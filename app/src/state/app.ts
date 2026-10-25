import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { concat, fromB64u, fromUtf8, randomId, toB64u, toHex, utf8, wipe } from '../crypto/encoding';
import { generateRatchetKey, Ratchet, type DhKeyPair } from '../crypto/ratchet';
import { createInviteSecret, decodeInvite, encodeInvite, extractInvite, openJoin, sealJoin, type InviteSecret, type InviteV2, type JoinNote } from '../net/invite';
import { ackMail, createMailbox, deleteMailbox, fetchMail, normalizeRelayUrl, openEnvelope, postToMailbox, relayInfo, RelayError, sealEnvelope, setPushEndpoint, type MyMailbox } from '../net/mailbox';
import { peerId, peerPub, samePub, type Identity } from '../crypto/identity';
import { aesKey, cryptoSupported, hkdf } from '../crypto/primitives';
import { acceptAnswer, acceptOffer, createPeer, makeOffer, type PeerLink } from '../net/peer';
import type { InviteSummary } from './store';
import { Session, type AppMessage } from '../net/session';
import { SerialQueue } from '../crypto/chain';
import { decodeSignal, encodeSignal, extractCode, signalLink } from '../net/signaling';
import * as idb from '../storage/idb';
import { BackupWriter, readBackup } from '../storage/backup';
import { CHUNK_STORE_SIZE, DEFAULT_SETTINGS, Repo, type Contact, type FileMeta, type Message, type AsyncState, type ChannelRecord, type MessagePreview, type Settings, type StoredIdentity } from '../storage/repo';
import { Vault } from '../storage/vault';
import { claimInstance, heldElsewhere, onInstanceLost } from './instance';
import { clearNotifications, notify, onNotificationOpen, resetNotifications } from './notify';
import { store, toast, type AppState } from './store';

/**
 * Application controller: owns the vault, identity, live sessions and transfers, and
 * mirrors everything the UI needs into the reactive store. UI components call the
 * exported functions; they never touch crypto or networking directly.
 */

const MAX_TEXT = 16_000;
const MAX_NAME = 48;
const MAX_FILE = 4 * 1024 ** 3; // 4 GiB
const SIGNAL_CHANNEL = 'veil-signal';

let repo: Repo | undefined;
let identity: Identity | undefined;
let lockTimer: ReturnType<typeof setTimeout> | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

const sessions = new Map<string, Session>(); // contact id -> live session
interface Pending {
  link: PeerLink;
  ref: string;
  role: 'initiator' | 'responder';
  session?: Session;
  forContact?: string;
  /** Untrusted display-name hint from the peer's code, used only for brand-new contacts. */
  hint: string;
}
let pending: Pending | undefined;

interface OutgoingTransfer {
  file: File;
  msg: Message;
  canceled: boolean;
}
interface IncomingTransfer {
  msg: Message;
  expectIndex: number;
  received: number;
  buffer: Uint8Array[];
  buffered: number;
  storeIndex: number;
  hasher: ReturnType<typeof nobleSha256.create>;
  lastUi: number;
}
const outgoing = new Map<string, OutgoingTransfer>();
const incoming = new Map<string, IncomingTransfer>();

const S = () => store.state;
const R = () => {
  if (!repo) throw new Error('locked');
  return repo;
};

// ------------------------------------------------------------------ boot / vault

export async function boot() {
  applyTheme('system');
  const code = takeCodeFromUrl();
  if (!(await cryptoSupported()) || !window.RTCPeerConnection || !window.indexedDB || !('CompressionStream' in window)) {
    store.set({ phase: 'unsupported' });
    return;
  }
  if ((code?.startsWith('VEIL1A') || code?.startsWith('VEIL2I')) && (await handOffAnswer(code))) return;
  if (code) pendingCode = code;
  listenForHandoffs();
  addEventListener('hashchange', () => {
    const c = takeCodeFromUrl();
    if (!c) return;
    if (S().phase === 'ready') void openCode(c);
    else pendingCode = c;
  });
  const exists = await Vault.exists();
  if (exists && (await heldElsewhere())) return store.set({ phase: 'elsewhere', elsewhere: 'open' });
  store.set({ phase: exists ? 'locked' : 'onboarding' });
}

/** Another window took over: step aside without touching stored data. */
onInstanceLost(() => {
  teardown();
  clearTimeout(lockTimer);
  clearInterval(sweepTimer);
  store.set({ phase: 'elsewhere', elsewhere: 'taken' });
});

/** Make this window the active one (the other window locks itself). */
export async function useHere() {
  await claimInstance(true);
  store.set({ phase: (await Vault.exists()) ? 'locked' : 'onboarding', elsewhere: undefined });
}

async function ensureActive() {
  if (!(await claimInstance())) {
    store.set({ phase: 'elsewhere', elsewhere: 'open' });
    throw new Error('Veil is open in another window');
  }
}

let pendingCode: string | undefined;

function takeCodeFromUrl(): string | undefined {
  const hash = decodeURIComponent(location.hash);
  const code = extractInvite(hash) ?? extractCode(hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return code;
}

export async function createAccount(name: string, passphrase: string, relay?: string) {
  await ensureActive();
  const vault = await Vault.create(passphrase);
  repo = new Repo(vault);
  identity = await repo.createIdentity();
  await repo.saveProfile({ name: name.trim().slice(0, MAX_NAME) });
  await idb.requestPersistence();
  await enter();
  if (relay) await setupMailbox(relay).catch((e) => toast(`Mailbox not set up: ${(e as Error).message}`, 'error', 6000));
}

export async function unlock(passphrase: string) {
  await ensureActive();
  const vault = await Vault.unlock(passphrase);
  repo = new Repo(vault);
  identity = await repo.loadIdentity();
  if (!identity) throw new Error('Identity missing - vault is corrupted');
  await enter();
}

async function enter() {
  const r = R();
  const [profile, settings, contacts] = await Promise.all([r.getProfile(), r.getSettings(), r.listContacts()]);
  applyTheme(settings.theme);
  store.set({ phase: 'ready', myId: peerId(identity!.pub), profile, settings, contacts: sortContacts(contacts), messages: {}, presence: {}, view: 'chats' });
  armAutoLock();
  sweepTimer = setInterval(() => void sweepExpired(), 10_000);
  await loadOffline();
  void sweepExpired(true);
  if (pendingCode) {
    const c = pendingCode;
    pendingCode = undefined;
    void openCode(c);
  }
}

export function lock(reason?: string) {
  teardown();
  store.set({ phase: 'locked' });
  if (reason) toast(reason);
}

/** Closes every connection and forgets all keys and decrypted data held in memory. */
function teardown() {
  for (const s of sessions.values()) s.close('Locked');
  sessions.clear();
  pending?.link.pc.close();
  pending = undefined;
  outgoing.clear();
  incoming.clear();
  resetNotifications();
  stopOffline();
  repo?.vault.lock();
  repo = undefined;
  identity = undefined;
  clearTimeout(lockTimer);
  clearInterval(sweepTimer);
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  store.set({ contacts: [], messages: {}, presence: {}, typing: {}, activeChat: undefined, connect: null, progress: {}, myId: '' });
}

export async function wipeEverything() {
  lock();
  await idb.wipeDatabase();
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  store.set({ phase: 'onboarding' });
  location.reload();
}

export async function changePassphrase(oldPass: string, newPass: string) {
  await Vault.changePassphrase(oldPass, newPass);
}

function armAutoLock() {
  clearTimeout(lockTimer);
  const mins = S().settings.autoLockMins;
  if (S().phase === 'ready' && mins > 0) {
    lockTimer = setTimeout(() => {
      // Never lock (and drop the connection) while someone is waiting to connect.
      if (connecting()) return armAutoLock();
      lock('Locked after inactivity');
    }, mins * 60_000);
  }
}

export function activity() {
  if (S().phase === 'ready') armAutoLock();
}

export function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b0b14' : '#f6f6fb');
}

// ------------------------------------------------------------------ profile / settings

export async function saveProfileName(name: string) {
  const profile = { name: name.trim().slice(0, MAX_NAME) };
  await R().saveProfile(profile);
  store.set({ profile });
  for (const s of sessions.values()) void s.send({ t: 'profile', name: profile.name }).catch(() => {});
}

export async function saveSettings(patch: Partial<Settings>) {
  const settings = { ...S().settings, ...patch };
  await R().saveSettings(settings);
  store.set({ settings });
  applyTheme(settings.theme);
  armAutoLock();
}

// ------------------------------------------------------------------ contacts

function sortContacts(cs: Contact[]) {
  return [...cs].sort((a, b) => b.lastSeen - a.lastSeen);
}

function contact(id: string) {
  return S().contacts.find((c) => c.id === id);
}

async function upsertContact(c: Contact) {
  await R().saveContact(c);
  store.set((s) => ({ contacts: sortContacts([...s.contacts.filter((x) => x.id !== c.id), c]) }));
}

export const displayName = (c: Contact) => c.alias || c.name || 'Unnamed contact';

export async function updateContact(id: string, patch: Partial<Contact>) {
  const c = contact(id);
  if (c) await upsertContact({ ...c, ...patch });
}

export async function setDisappearing(id: string, secs: number) {
  await updateContact(id, { disappearSecs: secs });
  void sendApp(id, { t: 'disappear', secs }).catch(() => {});
  await addSystemNote(id, secs ? `Disappearing messages set to ${formatTtl(secs)}` : 'Disappearing messages turned off');
}

export function formatTtl(secs: number) {
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86400)} d`;
}

export async function deleteContact(id: string) {
  sessions.get(id)?.close('Contact deleted');
  await R().deleteContact(id);
  asyncCache.delete(id);
  seeds.delete(id);
  store.set((s) => {
    const messages = { ...s.messages };
    delete messages[id];
    return { contacts: s.contacts.filter((c) => c.id !== id), messages, activeChat: s.activeChat === id ? undefined : s.activeChat, view: 'chats' };
  });
}

export async function clearChat(id: string) {
  await R().clearChat(id);
  store.set((s) => ({ messages: { ...s.messages, [id]: [] } }));
  await setPreview(id, undefined);
}

export async function openChat(id: string | undefined) {
  store.set({ activeChat: id, view: 'chats' });
  if (!id) return;
  void clearNotifications(id);
  if (!S().messages[id]) {
    const msgs = await R().listMessages(id);
    store.set((s) => ({ messages: { ...s.messages, [id]: msgs } }));
  }
  await markRead(id);
  if (S().settings.autoConnect && !sessions.get(id)?.isReady && canMail(id) && Date.now() - (lastKnock.get(id) ?? 0) > 5 * 60_000) {
    void connectContact(id, true);
  }
}

export async function markRead(id: string) {
  const c = contact(id);
  if (c?.unread) await updateContact(id, { unread: 0 });
  if (document.visibilityState !== 'visible' || S().activeChat !== id) return;
  const unread = (S().messages[id] ?? []).filter((m) => m.dir === 'in' && m.status !== 'read');
  if (!unread.length) return;
  for (const m of unread) await setMessage({ ...m, status: 'read' });
  void sendApp(id, { t: 'receipt', s: 'read', ids: unread.map((m) => m.id) }).catch(() => {});
}

// ------------------------------------------------------------------ messages

async function setMessage(m: Message, persist = true) {
  if (persist) await R().saveMessage(m);
  store.set((s) => {
    const list = s.messages[m.chat];
    if (!list) return {};
    const i = list.findIndex((x) => x.id === m.id);
    const next = i >= 0 ? list.map((x, j) => (j === i ? m : x)) : [...list, m];
    return { messages: { ...s.messages, [m.chat]: next } };
  });
}

async function addMessage(m: Message) {
  await R().saveMessage(m);
  if (!S().messages[m.chat]) {
    const msgs = await R().listMessages(m.chat);
    store.set((s) => ({ messages: { ...s.messages, [m.chat]: msgs } }));
  } else {
    await setMessage(m, false);
  }
  if (!m.id.startsWith('sys-')) await setPreview(m.chat, previewOf(m));
}

function previewOf(m: Message): MessagePreview {
  return { kind: m.kind, text: m.kind === 'file' ? m.file!.name : (m.text ?? '').slice(0, 120), dir: m.dir, ts: m.ts, expiresAt: m.expiresAt };
}

async function setPreview(chat: string, preview: MessagePreview | undefined) {
  const c = contact(chat);
  if (c && JSON.stringify(c.preview) !== JSON.stringify(preview)) await upsertContact({ ...c, preview });
}

/** Recompute the chat-list preview after deletions so removed text never lingers there. */
async function refreshPreview(chat: string) {
  const list = S().messages[chat] ?? (await R().listMessages(chat));
  const last = [...list].reverse().find((m) => !m.id.startsWith('sys-'));
  await setPreview(chat, last ? previewOf(last) : undefined);
}

async function addSystemNote(chat: string, text: string) {
  // System notes are local-only text messages with a reserved id prefix.
  await addMessage({ id: `sys-${randomId()}`, chat, dir: 'in', ts: Date.now(), kind: 'text', text, status: 'read' });
}

function findMessage(chat: string, pred: (m: Message) => boolean) {
  return S().messages[chat]?.find(pred);
}

export async function sendText(chat: string, text: string) {
  const body = text.trim();
  if (!body) return;
  if (body.length > MAX_TEXT) return toast(`Messages are limited to ${MAX_TEXT} characters`, 'error');
  if (!sessions.get(chat)?.isReady && !canMail(chat)) return toast('Not connected - reconnect to send', 'error');
  const c = contact(chat)!;
  const ts = Date.now();
  const m: Message = {
    id: randomId(),
    chat,
    dir: 'out',
    ts,
    kind: 'text',
    text: body,
    status: 'sending',
    expiresAt: c.disappearSecs ? ts + c.disappearSecs * 1000 : undefined,
  };
  await addMessage(m);
  try {
    const via = await sendApp(chat, { t: 'msg', id: m.id, ts, text: body, ttl: c.disappearSecs || undefined });
    await setMessage({ ...m, status: via === 'live' ? 'sent' : via === 'mailbox' ? 'queued' : 'sending' });
  } catch {
    await setMessage({ ...m, status: 'failed' });
  }
  await touch(chat);
}

let lastTyping = 0;
export function sendTyping(chat: string) {
  const now = Date.now();
  if (now - lastTyping < 3000) return;
  lastTyping = now;
  void sessions.get(chat)?.send({ t: 'typing' }).catch(() => {});
}

export async function deleteMessage(m: Message) {
  await R().deleteMessage(m);
  revokeUrl(m.file?.fileId);
  store.set((s) => ({ messages: { ...s.messages, [m.chat]: (s.messages[m.chat] ?? []).filter((x) => x.id !== m.id) } }));
  await refreshPreview(m.chat);
}

async function touch(chat: string, unreadDelta = 0) {
  const c = contact(chat);
  if (c) await upsertContact({ ...c, lastSeen: Date.now(), unread: c.unread + unreadDelta });
}

async function sweepExpired(full = false) {
  if (!repo) return;
  const now = Date.now();
  for (const list of Object.values(S().messages)) {
    for (const m of list) if (m.expiresAt && m.expiresAt <= now) await deleteMessage(m);
  }
  // Chats not loaded into memory: always on unlock, then only where a timer is set.
  for (const c of S().contacts) {
    if (S().messages[c.id] || !(full || c.disappearSecs || (c.preview?.expiresAt ?? Infinity) <= now)) continue;
    let removed = false;
    for (const m of await R().listMessages(c.id)) {
      if (m.expiresAt && m.expiresAt <= now) {
        await R().deleteMessage(m);
        removed = true;
      }
    }
    if (removed) await refreshPreview(c.id);
  }
}

// ------------------------------------------------------------------ incoming messages

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(v);

async function onAppMessage(chat: string, m: AppMessage, via: 'live' | 'mailbox' = 'live') {
  if (via === 'mailbox' && !MAILBOX_TYPES.has(m.t)) return;
  switch (m.t) {
    case 'mailbox':
      return onMailboxCard(chat, m);
    case 'ratchet-init':
      return onRatchetInit(chat, m);
    case 'ratchet-hello':
      return onRatchetHello(chat, m);
    case 'rtc':
      return handleRtc(chat, { kind: 'contact' }, m, displayName(contact(chat) ?? ({} as Contact)));
    case 'profile': {
      const name = str(m.name, MAX_NAME);
      if (name !== undefined) await updateContact(chat, { name });
      return;
    }
    case 'msg': {
      const text = str(m.text, MAX_TEXT);
      if (!isId(m.id) || text === undefined) return;
      if (findMessage(chat, (x) => x.id === m.id)) return;
      const now = Date.now();
      const ttl = num(m.ttl);
      const msg: Message = {
        id: m.id,
        chat,
        dir: 'in',
        ts: Math.min(num(m.ts) ?? now, now + 60_000),
        kind: 'text',
        text,
        status: 'delivered',
        expiresAt: ttl ? now + ttl * 1000 : undefined,
      };
      await addMessage(msg);
      void sendApp(chat, { t: 'receipt', s: 'delivered', ids: [m.id] }).catch(() => {});
      await afterIncoming(chat, 'message');
      return;
    }
    case 'receipt': {
      const ids = Array.isArray(m.ids) ? m.ids.filter(isId).slice(0, 500) : [];
      const st = m.s === 'read' ? 'read' : m.s === 'delivered' ? 'delivered' : undefined;
      if (!st) return;
      for (const id of ids) {
        const msg = findMessage(chat, (x) => x.id === id && x.dir === 'out');
        if (msg && msg.status !== 'read') await setMessage({ ...msg, status: st });
      }
      return;
    }
    case 'typing':
      store.set((st) => ({ typing: { ...st.typing, [chat]: Date.now() } }));
      setTimeout(() => store.set((st) => ({ typing: { ...st.typing } })), 4200);
      return;
    case 'disappear': {
      const secs = num(m.secs);
      if (secs === undefined || secs > 365 * 86400) return;
      await updateContact(chat, { disappearSecs: secs });
      await addSystemNote(chat, secs ? `Disappearing messages set to ${formatTtl(secs)}` : 'Disappearing messages turned off');
      return;
    }
    case 'file-offer':
      return onFileOffer(chat, m);
    case 'file-accept':
      return onFileAccept(chat, m);
    case 'file-decline':
    case 'file-cancel':
      return onFileAbort(chat, m);
    case 'file-done':
      return onFileDone(chat, m);
    default:
      // Unknown types are ignored for forward compatibility.
      return;
  }
}

async function afterIncoming(chat: string, kind: 'message' | 'file') {
  const visible = document.visibilityState === 'visible';
  const viewing = visible && S().activeChat === chat && S().view === 'chats';
  await touch(chat, viewing ? 0 : 1);
  if (viewing) return markRead(chat);
  const c = contact(chat);
  if (visible) {
    // In the app but looking at another chat or panel: a quiet in-app hint.
    if (c) toast(`${kind === 'file' ? 'File' : 'Message'} from ${displayName(c)}`);
  } else {
    void notify({ chat, kind, name: c ? displayName(c) : undefined });
  }
}

onNotificationOpen((chat) => {
  if (S().phase === 'ready' && contact(chat)) void openChat(chat);
});

// ------------------------------------------------------------------ files

const objectUrls = new Map<string, string>();
function revokeUrl(fileId?: string) {
  if (!fileId) return;
  const u = objectUrls.get(fileId);
  if (u) URL.revokeObjectURL(u);
  objectUrls.delete(fileId);
}

/** Decrypts a stored file into a short-lived object URL. */
export async function fileUrl(meta: FileMeta): Promise<string> {
  const cached = objectUrls.get(meta.fileId);
  if (cached) return cached;
  const url = URL.createObjectURL(await R().loadFile(meta));
  objectUrls.set(meta.fileId, url);
  return url;
}

export async function sendFiles(chat: string, files: FileList | File[]) {
  for (const f of Array.from(files)) await sendFile(chat, f);
}

async function sendFile(chat: string, file: File) {
  const s = sessions.get(chat);
  if (!s?.isReady) return toast('Not connected - reconnect to send files', 'error');
  if (file.size > MAX_FILE) return toast('Files are limited to 4 GB', 'error');
  const c = contact(chat)!;
  const ts = Date.now();
  const meta: FileMeta = {
    fileId: randomId(),
    name: file.name.slice(0, 200) || 'file',
    size: file.size,
    mime: (file.type || 'application/octet-stream').slice(0, 100),
    state: 'offered',
    progress: 0,
    chunks: 0,
  };
  const msg: Message = { id: randomId(), chat, dir: 'out', ts, kind: 'file', file: meta, status: 'sending', expiresAt: c.disappearSecs ? ts + c.disappearSecs * 1000 : undefined };
  outgoing.set(meta.fileId, { file, msg, canceled: false });
  await addMessage(msg);
  try {
    await s.send({ t: 'file-offer', id: msg.id, ts, fileId: meta.fileId, name: meta.name, size: meta.size, mime: meta.mime, ttl: c.disappearSecs || undefined });
    await setMessage({ ...msg, status: 'sent' });
    outgoing.get(meta.fileId)!.msg = { ...msg, status: 'sent' };
  } catch {
    outgoing.delete(meta.fileId);
    await setMessage({ ...msg, status: 'failed', file: { ...meta, state: 'failed' } });
  }
  await touch(chat);
}

async function onFileOffer(chat: string, m: AppMessage) {
  const name = str(m.name, 200);
  const mime = str(m.mime, 100);
  const size = num(m.size);
  if (!isId(m.id) || !isId(m.fileId) || name === undefined || mime === undefined || size === undefined || size > MAX_FILE) return;
  if (findMessage(chat, (x) => x.id === m.id)) return;
  const now = Date.now();
  const ttl = num(m.ttl);
  const msg: Message = {
    id: m.id,
    chat,
    dir: 'in',
    ts: Math.min(num(m.ts) ?? now, now + 60_000),
    kind: 'file',
    file: { fileId: m.fileId, name, mime, size, state: 'offered', progress: 0, chunks: 0 },
    status: 'delivered',
    expiresAt: ttl ? now + ttl * 1000 : undefined,
  };
  await addMessage(msg);
  void sessions.get(chat)?.send({ t: 'receipt', s: 'delivered', ids: [m.id] }).catch(() => {});
  await afterIncoming(chat, 'file');
  if (size <= S().settings.autoAcceptMB * 1024 * 1024) await acceptFile(msg);
}

export async function acceptFile(msg: Message) {
  const s = sessions.get(msg.chat);
  if (!msg.file || !s?.isReady) return toast('Not connected', 'error');
  const updated: Message = { ...msg, file: { ...msg.file, state: 'transferring', progress: 0 } };
  incoming.set(msg.file.fileId, { msg: updated, expectIndex: 0, received: 0, buffer: [], buffered: 0, storeIndex: 0, hasher: nobleSha256.create(), lastUi: 0 });
  await setMessage(updated);
  await s.send({ t: 'file-accept', fileId: msg.file.fileId });
}

export async function declineFile(msg: Message) {
  if (!msg.file) return;
  await setMessage({ ...msg, file: { ...msg.file, state: 'declined' } });
  void sessions.get(msg.chat)?.send({ t: 'file-decline', fileId: msg.file.fileId }).catch(() => {});
}

export async function cancelTransfer(msg: Message) {
  if (!msg.file) return;
  const id = msg.file.fileId;
  const out = outgoing.get(id);
  if (out) out.canceled = true;
  const inc = incoming.get(id);
  incoming.delete(id);
  if (inc) await R().deleteFile(id, inc.storeIndex);
  await setMessage({ ...msg, file: { ...msg.file, state: 'canceled', chunks: 0 } });
  void sessions.get(msg.chat)?.send({ t: 'file-cancel', fileId: id }).catch(() => {});
}

async function onFileAccept(chat: string, m: AppMessage) {
  if (!isId(m.fileId)) return;
  const t = outgoing.get(m.fileId);
  if (!t || t.msg.chat !== chat || t.msg.file!.state !== 'offered') return;
  void streamFile(t);
}

async function streamFile(t: OutgoingTransfer) {
  const { file } = t;
  const chat = t.msg.chat;
  const fileId = t.msg.file!.fileId;
  const s = sessions.get(chat);
  if (!s) return;
  let meta: FileMeta = { ...t.msg.file!, state: 'transferring' };
  await setMessage({ ...t.msg, file: meta });
  const hasher = nobleSha256.create();
  let wireIndex = 0;
  let storeIndex = 0;
  let sent = 0;
  let lastUi = 0;
  try {
    for (let off = 0; off < file.size || (off === 0 && file.size === 0); off += CHUNK_STORE_SIZE) {
      const block = new Uint8Array(await file.slice(off, off + CHUNK_STORE_SIZE).arrayBuffer());
      hasher.update(block);
      // Keep our own encrypted copy so the file stays in the conversation history.
      await R().putFileChunk(fileId, storeIndex++, block);
      // Pipeline: seal/send runs in the session's serial queue while we keep reading,
      // bounded by the channel's buffer high-water mark.
      let inflight: Promise<void>[] = [];
      for (let p = 0; p < block.length; p += s.chunkSize) {
        if (t.canceled || s.closed) throw new Error(t.canceled ? 'canceled' : 'disconnected');
        if (s.congested || inflight.length >= 32) {
          await Promise.all(inflight);
          inflight = [];
          await s.waitForDrain();
        }
        const piece = block.subarray(p, p + s.chunkSize);
        inflight.push(s.sendChunk(fileId, wireIndex++, piece));
        sent += piece.length;
        if (performance.now() - lastUi > 120) {
          lastUi = performance.now();
          store.set((st) => ({ progress: { ...st.progress, [fileId]: sent } }));
        }
      }
      await Promise.all(inflight);
      if (file.size === 0) break;
    }
    const digest = toHex(hasher.digest());
    await s.send({ t: 'file-done', fileId, sha256: digest, chunks: wireIndex, size: sent });
    meta = { ...meta, state: 'done', progress: sent, sha256: digest, chunks: storeIndex };
  } catch (err) {
    await R().deleteFile(fileId, storeIndex);
    meta = { ...meta, state: t.canceled ? 'canceled' : 'failed', chunks: 0 };
    if (!t.canceled) toast(`Transfer failed: ${(err as Error).message}`, 'error');
  } finally {
    outgoing.delete(fileId);
    store.set((st) => {
      const progress = { ...st.progress };
      delete progress[fileId];
      return { progress };
    });
  }
  const current = findMessage(chat, (x) => x.id === t.msg.id) ?? t.msg;
  await setMessage({ ...current, file: meta });
}

async function onChunk(chat: string, fileId: string, index: number, data: Uint8Array) {
  const t = incoming.get(fileId);
  if (!t || t.msg.chat !== chat) return; // canceled or unknown - drop silently
  if (index !== t.expectIndex) throw new Error('file chunk out of order');
  t.expectIndex++;
  t.received += data.length;
  if (t.received > t.msg.file!.size) throw new Error('peer sent more data than announced');
  const copy = new Uint8Array(data);
  t.hasher.update(copy);
  t.buffer.push(copy);
  t.buffered += copy.length;
  if (t.buffered >= CHUNK_STORE_SIZE) await flush(t);
  const now = performance.now();
  if (now - t.lastUi > 120) {
    t.lastUi = now;
    store.set((st) => ({ progress: { ...st.progress, [fileId]: t.received } }));
  }
}

async function flush(t: IncomingTransfer) {
  if (!t.buffered) return;
  const block = new Uint8Array(t.buffered);
  let off = 0;
  for (const b of t.buffer) {
    block.set(b, off);
    off += b.length;
  }
  t.buffer = [];
  t.buffered = 0;
  await R().putFileChunk(t.msg.file!.fileId, t.storeIndex++, block);
}

async function onFileDone(chat: string, m: AppMessage) {
  if (!isId(m.fileId)) return;
  const t = incoming.get(m.fileId);
  if (!t || t.msg.chat !== chat) return;
  // Wait until the bulk channel has delivered every chunk (ctrl and bulk are independent streams).
  const want = num(m.size) ?? -1;
  const deadline = Date.now() + 30_000;
  while (t.received < want && Date.now() < deadline && incoming.has(m.fileId)) await new Promise((r) => setTimeout(r, 50));
  if (!incoming.has(m.fileId)) return;
  incoming.delete(m.fileId);
  await flush(t);
  const digest = toHex(t.hasher.digest());
  const ok = t.received === t.msg.file!.size && typeof m.sha256 === 'string' && digest === m.sha256;
  const file: FileMeta = { ...t.msg.file!, state: ok ? 'done' : 'failed', progress: t.received, sha256: digest, chunks: ok ? t.storeIndex : 0 };
  if (!ok) {
    await R().deleteFile(t.msg.file!.fileId, t.storeIndex);
    toast('A received file failed its integrity check and was discarded', 'error');
  }
  store.set((st) => {
    const progress = { ...st.progress };
    delete progress[m.fileId as string];
    return { progress };
  });
  const current = findMessage(chat, (x) => x.id === t.msg.id) ?? t.msg;
  await setMessage({ ...current, file });
}

async function onFileAbort(chat: string, m: AppMessage) {
  if (!isId(m.fileId)) return;
  const out = outgoing.get(m.fileId);
  if (out && out.msg.chat === chat) {
    out.canceled = true;
    if (out.msg.file!.state === 'offered') {
      outgoing.delete(m.fileId);
      await setMessage({ ...out.msg, file: { ...out.msg.file!, state: m.t === 'file-decline' ? 'declined' : 'canceled' } });
    }
  }
  const inc = incoming.get(m.fileId);
  if (inc && inc.msg.chat === chat) {
    incoming.delete(m.fileId);
    await R().deleteFile(m.fileId, inc.storeIndex);
    await setMessage({ ...inc.msg, file: { ...inc.msg.file!, state: 'canceled', chunks: 0 } });
  }
}

/** Mark transfers that were interrupted (disconnect / app closed) as failed. */
async function failTransfers(chat: string) {
  for (const [id, t] of incoming) {
    if (t.msg.chat !== chat) continue;
    incoming.delete(id);
    await R().deleteFile(id, t.storeIndex);
    await setMessage({ ...t.msg, file: { ...t.msg.file!, state: 'failed', chunks: 0 } });
  }
  for (const [id, t] of outgoing) {
    if (t.msg.chat !== chat) continue;
    t.canceled = true;
    if (t.msg.file!.state === 'offered') {
      outgoing.delete(id);
      await setMessage({ ...t.msg, file: { ...t.msg.file!, state: 'failed' } });
    }
  }
}

// ------------------------------------------------------------------ connecting

export function closeConnect() {
  releaseWakeLock();
  if (pending && !pending.session?.isReady) pending.link.pc.close();
  pending = undefined;
  store.set({ connect: null });
}

function sessionEvents(p: Pending) {
  let chat = '';
  // Messages can arrive while onReady is still persisting the contact; hold them.
  const early: AppMessage[] = [];
  const handle = (m: AppMessage) => void onAppMessage(chat, m).catch((e) => console.warn('[veil]', e));
  return {
    ready: (peer: Uint8Array, asyncRoot: Uint8Array) =>
      void onReady(p, peer, asyncRoot).then((id) => {
        chat = id;
        early.splice(0).forEach(handle);
      }),
    message: (m: AppMessage) => {
      if (chat) handle(m);
      else if (early.length < 100) early.push(m);
    },
    chunk: (fileId: string, index: number, data: Uint8Array) => (chat ? onChunk(chat, fileId, index, data) : undefined),
    drain: () => {},
    closed: (reason: string) => {
      for (const [k, a] of attempts) if (a.link === p.link) attempts.delete(k);
      if (pending === p) {
        pending = undefined;
        const c = S().connect;
        if (c) store.set({ connect: { ...c, step: 'error', error: reason } });
      }
      if (chat && sessions.get(chat) === p.session) {
        sessions.delete(chat);
        store.set((s) => {
          const presence = { ...s.presence };
          delete presence[chat];
          return { presence };
        });
        void failTransfers(chat);
        if (reason !== 'Locked' && reason !== 'Replaced by a new connection') toast(`${displayName(contact(chat) ?? ({} as Contact))}: ${reason}`);
      }
    },
  };
}

async function onReady(p: Pending, peer: Uint8Array, asyncRoot: Uint8Array): Promise<string> {
  const id = peerId(peer);
  const existing = contact(id);
  const now = Date.now();
  const c: Contact = existing
    ? { ...existing, lastSeen: now }
    : { id, name: p.hint, addedAt: now, lastSeen: now, verified: false, disappearSecs: 0, unread: 0 };
  await upsertContact(c);
  const old = sessions.get(id);
  sessions.set(id, p.session!);
  if (old && old !== p.session) old.close('Replaced by a new connection');
  if (pending === p) pending = undefined;
  store.set((s) => ({ presence: { ...s.presence, [id]: 'online' }, connect: null }));
  void p.session!.send({ t: 'profile', name: S().profile.name }).catch(() => {});
  await startAsync(p, id, peer, asyncRoot).catch((e) => console.warn('[veil] offline setup failed:', e));
  void onConnected(id);
  void flushOutbox();
  if (!existing) await addSystemNote(id, 'Connected. Compare safety numbers to verify this contact.');
  toast(`Securely connected to ${displayName(c)}`, 'success');
  void notify({ chat: id, kind: 'connected', name: displayName(c) });
  await openChat(id);
  return id;
}

export async function createInvite(forContact?: string, liveCode = false): Promise<void> {
  if (forContact && canMail(forContact) && !liveCode) return connectContact(forContact);
  if (!forContact && myMailbox && !liveCode) return createInviteLink();
  closeConnect();
  store.set({ connect: { mode: 'invite', step: 'creating', forContact } });
  try {
    const link = createPeer(S().settings);
    const ref = randomId();
    pending = { link, ref, role: 'initiator', forContact, hint: '' };
    const sdp = await makeOffer(link);
    if (pending?.ref !== ref) return;
    const code = await encodeSignal({ v: 1, k: 'offer', sdp, id: S().myId, name: S().profile.name, ref });
    store.set({ connect: { mode: 'invite', step: 'waiting', code, link: signalLink(code), forContact } });
    void holdWakeLock();
    // A live code only works while this screen stays open and the network path stays fresh.
    const ref2 = ref;
    setTimeout(() => {
      const c = S().connect;
      if (pending?.ref === ref2 && !pending.session && c?.mode === 'invite' && c.step === 'waiting') {
        closeConnect();
        store.set({ connect: { mode: 'invite', step: 'error', forContact, error: 'This code has expired. Codes only work for about 15 minutes while this screen stays open - create a fresh one, or set up a mailbox for links that last days.' } });
      }
    }, 15 * 60_000);
  } catch (err) {
    store.set({ connect: { mode: 'invite', step: 'error', error: (err as Error).message } });
  }
}

export function startJoin() {
  closeConnect();
  store.set({ connect: { mode: 'join', step: 'input' } });
}

/** Handles any pasted/scanned/linked code: offers start a join, answers complete an invite. */
export async function openCode(text: string) {
  if (extractInvite(text)) return previewInvite(text);
  try {
    const sig = await decodeSignal(text);
    if (sig.k === 'answer') return submitAnswer(text);
    if (samePub(peerPub(sig.id), identity!.pub)) throw new Error('This is your own invite - send it to someone else');
    closeConnect();
    store.set({ connect: { mode: 'join', step: 'creating', peerName: sig.name } });
    const link = createPeer(S().settings);
    const p: Pending = { link, ref: sig.ref, role: 'responder', hint: sig.name };
    pending = p;
    const sdp = await acceptOffer(link, sig.sdp);
    p.session = new Session(link, 'responder', identity!, peerPub(sig.id), sessionEvents(p));
    const code = await encodeSignal({ v: 1, k: 'answer', sdp, id: S().myId, name: S().profile.name, ref: sig.ref });
    if (pending === p) store.set({ connect: { mode: 'join', step: 'waiting', code, link: signalLink(code), peerName: sig.name } });
  } catch (err) {
    store.set((s) => ({ connect: { ...(s.connect ?? { mode: 'join' }), step: 'error', error: (err as Error).message } as AppState['connect'] }));
  }
}

export async function submitAnswer(text: string) {
  const c = S().connect;
  try {
    const sig = await decodeSignal(text);
    if (sig.k !== 'answer') throw new Error('That is an invite, not a reply. Paste the reply code your contact sent back.');
    const p = pending;
    if (!p || p.role !== 'initiator' || p.ref !== sig.ref) throw new Error('This reply belongs to a different or expired invite');
    if (p.forContact && p.forContact !== sig.id) {
      throw new Error('Warning: this reply came from a different identity than the contact you invited. If they reinstalled Veil, start a new invite from the + button; otherwise someone may be intercepting.');
    }
    p.hint = sig.name;
    store.set({ connect: { ...(c as Extract<AppState['connect'], { mode: 'invite' }>), step: 'connecting' } });
    await acceptAnswer(p.link, sig.sdp);
    p.session = new Session(p.link, 'initiator', identity!, peerPub(sig.id), sessionEvents(p));
  } catch (err) {
    toast((err as Error).message, 'error', 7000);
  }
}

export function disconnect(chat: string) {
  sessions.get(chat)?.close('Disconnected');
}

export function sessionFor(chat: string) {
  return sessions.get(chat);
}

// ------------------------------------------------------------------ cross-tab handoff

/**
 * When the inviter opens a reply *link*, it lands in a new tab. That tab forwards the
 * code to the tab holding the pending connection over a same-origin BroadcastChannel,
 * then tells the user they can close it.
 */
async function handOffAnswer(code: string): Promise<boolean> {
  if (!('BroadcastChannel' in window)) return false;
  const bc = new BroadcastChannel(SIGNAL_CHANNEL);
  const acked = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 1500);
    bc.onmessage = (e) => {
      if (e.data?.type === 'ack') {
        clearTimeout(t);
        resolve(true);
      }
    };
    bc.postMessage({ type: 'answer', code });
  });
  bc.close();
  if (acked) store.set({ phase: 'handoff', handoffMessage: code.startsWith('VEIL2I') ? 'Invite opened in your other Veil window. You can close this tab.' : 'Reply delivered to your open Veil tab. You can close this tab.' });
  return acked;
}

function listenForHandoffs() {
  if (!('BroadcastChannel' in window)) return;
  const bc = new BroadcastChannel(SIGNAL_CHANNEL);
  bc.onmessage = (e) => {
    const data = e.data as { type?: string; code?: unknown };
    // An invite link opened in a new tab: the active, unlocked window takes it.
    if (data?.type === 'answer' && typeof data.code === 'string' && data.code.startsWith('VEIL2I') && S().phase === 'ready') {
      bc.postMessage({ type: 'ack' });
      void openCode(data.code);
      window.focus();
      return;
    }
    if (data?.type !== 'answer' || typeof data.code !== 'string' || !pending || pending.role !== 'initiator') return;
    void decodeSignal(data.code)
      .then((sig) => {
        if (sig.ref !== pending?.ref) return;
        bc.postMessage({ type: 'ack' });
        void submitAnswer(data.code as string);
        window.focus();
      })
      .catch(() => {});
  };
}

// ------------------------------------------------------------------ encrypted backup / restore

export interface BackupProgress {
  phase: 'preparing' | 'writing' | 'verifying' | 'restoring';
  done: number;
  total: number;
}

interface Sink {
  write(b: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

type SavePicker = (o: object) => Promise<{ createWritable(): Promise<{ write(b: BufferSource): Promise<void>; close(): Promise<void> }> }>;

/** Streams to disk via the File System Access API when available, else builds a Blob. */
async function openSink(name: string): Promise<{ sink: Sink; finish(): Blob | undefined }> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    const handle = await picker({ suggestedName: name, types: [{ description: 'Veil backup', accept: { 'application/octet-stream': ['.veilbackup'] } }] });
    const w = await handle.createWritable();
    return { sink: { write: (b) => w.write(b as BufferSource), close: () => w.close() }, finish: () => undefined };
  }
  const parts: BlobPart[] = [];
  return {
    sink: { write: async (b) => void parts.push(b as BlobPart), close: async () => {} },
    finish: () => new Blob(parts, { type: 'application/octet-stream' }),
  };
}

export function backupFileName() {
  return `veil-backup-${new Date().toISOString().slice(0, 10)}.veilbackup`;
}

/**
 * Writes an encrypted backup. Returns a Blob to download when the browser could not
 * stream straight to a file (otherwise the file is already saved).
 */
export async function createBackup(passphrase: string, includeFiles: boolean, onProgress: (p: BackupProgress) => void): Promise<Blob | undefined> {
  const r = R();
  onProgress({ phase: 'preparing', done: 0, total: 1 });
  const identity = await r.exportIdentity();
  if (!identity) throw new Error('Identity missing');
  const contacts = await r.listContacts();
  const chats = await Promise.all(contacts.map((c) => r.listMessages(c.id)));
  const now = Date.now();
  const messages = chats.flat().filter((m) => !m.expiresAt || m.expiresAt > now);
  const files = includeFiles ? messages.filter((m) => m.file?.state === 'done' && m.file.chunks > 0) : [];
  const total = files.reduce((n, m) => n + m.file!.size, 0) + 1;

  const { sink, finish } = await openSink(backupFileName());
  try {
    const w = await BackupWriter.create(passphrase);
    await sink.write(w.header);
    await sink.write(await w.json('identity', identity));
    await sink.write(await w.json('profile', S().profile));
    await sink.write(await w.json('settings', { ...S().settings, lastBackupAt: 0 }));
    for (const c of contacts) await sink.write(await w.json('contact', { ...c, unread: 0 }));
    const included = new Set(files.map((m) => m.id));
    for (const m of messages) {
      const keep = !m.file || included.has(m.id) || m.file.state !== 'done';
      const msg = keep ? m : { ...m, file: { ...m.file!, state: 'removed', chunks: 0 } };
      await sink.write(await w.json('message', msg));
    }
    let done = 0;
    for (const m of files) {
      for (let i = 0; i < m.file!.chunks; i++) {
        const data = await r.getFileChunk(m.file!.fileId, i);
        if (!data) continue;
        await sink.write(await w.chunk(m.file!.fileId, i, data));
        done += data.length;
        onProgress({ phase: 'writing', done, total });
      }
    }
    await sink.write(await w.end());
    await sink.close();
  } catch (err) {
    await sink.close().catch(() => {});
    throw err;
  }
  await saveSettings({ lastBackupAt: Date.now() });
  onProgress({ phase: 'writing', done: total, total });
  return finish();
}

/** Decrypts and checks the whole backup without writing anything. Returns a summary. */
export async function inspectBackup(file: Blob, passphrase: string, onProgress?: (p: BackupProgress) => void) {
  let contacts = 0;
  let messages = 0;
  let name = '';
  let identity = false;
  for await (const e of readBackup(file, passphrase, (done, total) => onProgress?.({ phase: 'verifying', done, total }))) {
    if (e.type !== 'json') continue;
    if (e.k === 'contact') contacts++;
    else if (e.k === 'message') messages++;
    else if (e.k === 'identity') identity = true;
    else if (e.k === 'profile') name = String((e.d as { name?: unknown })?.name ?? '');
  }
  if (!identity) throw new Error('This backup has no identity key');
  return { contacts, messages, name };
}

/**
 * Replaces everything on this device with the backup's contents, protected by a new
 * device passphrase. The backup is fully verified first; if writing fails midway the
 * partial data is wiped so the device never ends up half-restored.
 */
export async function restoreBackup(file: Blob, backupPass: string, devicePass: string, onProgress: (p: BackupProgress) => void) {
  const report = (p: BackupProgress) => {
    onProgress(p);
    store.set({ restoring: p });
  };
  const back = S().phase;
  // Restoring replaces the shared database, so any other window must stand down.
  await claimInstance(true);
  store.set({ phase: 'restoring' });
  try {
    await inspectBackup(file, backupPass, report);
  } catch (err) {
    store.set({ phase: back, restoring: undefined });
    throw err;
  }
  teardown();
  await idb.wipeDatabase();
  try {
    const vault = await Vault.create(devicePass);
    const r = new Repo(vault);
    for await (const e of readBackup(file, backupPass, (done, total) => report({ phase: 'restoring', done, total }))) {
      if (e.type === 'chunk') {
        await r.putFileChunk(e.fileId, e.index, e.data);
        continue;
      }
      const d = e.d as Record<string, unknown>;
      if (e.k === 'identity') await r.importIdentity(d as unknown as StoredIdentity);
      else if (e.k === 'profile') await r.saveProfile({ name: String(d.name ?? '').slice(0, MAX_NAME) });
      else if (e.k === 'settings') await r.saveSettings({ ...DEFAULT_SETTINGS, ...(d as Partial<Settings>), notifications: false, lastBackupAt: 0 });
      else if (e.k === 'contact' && typeof d.id === 'string') await r.saveContact(d as unknown as Contact);
      else if (e.k === 'message' && typeof d.chat === 'string' && typeof d.id === 'string') {
        const m = d as unknown as Message;
        // Transfers cannot resume after a restore.
        if (m.file && (m.file.state === 'transferring' || m.file.state === 'offered')) m.file = { ...m.file, state: 'failed', chunks: 0 };
        if (m.status === 'sending') m.status = 'failed';
        await r.saveMessage(m);
      }
    }
    repo = r;
    identity = await r.loadIdentity();
    if (!identity) throw new Error('Identity missing after restore');
    await idb.requestPersistence();
    store.set({ restoring: undefined });
    await enter();
    toast('Backup restored. Reconnect with contacts to keep chatting.', 'success', 6000);
  } catch (err) {
    repo = undefined;
    identity = undefined;
    await idb.wipeDatabase();
    store.set({ phase: 'onboarding', restoring: undefined });
    throw err;
  }
}

// ------------------------------------------------------------------ offline messages (mailbox relay + Double Ratchet)

/** Message types that may arrive through a mailbox. Everything else needs a live session. */
const MAILBOX_TYPES = new Set(['msg', 'receipt', 'profile', 'disappear', 'mailbox', 'rtc']);
const MAX_EPOCHS = 2;
const POLL_MS = 30_000;

let myMailbox: MyMailbox | undefined;
const asyncCache = new Map<string, AsyncState>();
const asyncQueues = new Map<string, SerialQueue>();
const envKeys = new Map<string, CryptoKey>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let polling: Promise<void> | undefined;

/** Per-live-session secrets used once to (re)seed the ratchet, then wiped. */
interface LiveSeed {
  role: 'initiator' | 'responder';
  sk: Uint8Array;
  env: string;
  ad: Uint8Array;
  bob?: DhKeyPair;
}
const seeds = new Map<string, LiveSeed>();

function asyncQueue(chat: string) {
  let q = asyncQueues.get(chat);
  if (!q) asyncQueues.set(chat, (q = new SerialQueue()));
  return q;
}

async function envKey(b64: string): Promise<CryptoKey> {
  let k = envKeys.get(b64);
  if (!k) envKeys.set(b64, (k = await aesKey(fromB64u(b64))));
  return k;
}

/** Can we leave a message for this contact while they are offline? */
export function canMail(chat: string): boolean {
  return !!contact(chat)?.mailbox && !!asyncCache.get(chat)?.epochs.length;
}

function publishOffline() {
  const offline: Record<string, boolean> = {};
  for (const c of S().contacts) offline[c.id] = canMail(c.id);
  store.set({ offline, mailbox: myMailbox ? { relay: myMailbox.relay, push: !!myMailbox.push } : undefined });
}

async function loadOffline() {
  myMailbox = await R().getMailbox();
  const now = Date.now();
  for (const inv of await R().listInvites()) {
    if (inv.exp < now) await R().deleteInvite(inv.iid);
    else invites.set(inv.iid, inv);
  }
  for (const ch of await R().listChannels()) {
    if (ch.expires < now) await dropChannel(ch);
    else channels.set(ch.iid, ch);
  }
  publishInvites();
  boostTimer = setInterval(() => {
    if (Date.now() < boostUntil) void pollMailbox();
  }, BOOST_POLL_MS);
  // Still waiting on an invite we accepted? Let the inviter know we are here.
  for (const ch of channels.values()) {
    if (ch.role === 'joiner' && !contact(ch.peerId)) void knock(ch.peerId, { kind: 'channel', iid: ch.iid }, ch.peerName);
  }
  for (const c of S().contacts) {
    const st = await R().getAsync(c.id);
    if (st) asyncCache.set(c.id, st);
  }
  publishOffline();
  void pollMailbox();
  void flushOutbox();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void pollMailbox();
    void flushOutbox();
  }, POLL_MS);
}

function stopOffline() {
  clearInterval(pollTimer);
  clearInterval(boostTimer);
  for (const a of attempts.values()) a.link?.pc.close();
  attempts.clear();
  invites.clear();
  channels.clear();
  lastKnock.clear();
  releaseWakeLock();
  for (const s of seeds.values()) wipe(s.sk);
  seeds.clear();
  asyncCache.clear();
  asyncQueues.clear();
  envKeys.clear();
  myMailbox = undefined;
}

/**
 * Sends an application message: over the live session when connected, otherwise
 * Double-Ratchet encrypted into the contact's mailbox (or the outbox if their relay is
 * unreachable right now).
 */
async function sendApp(chat: string, msg: AppMessage, queueable = true): Promise<'live' | 'mailbox' | 'outbox'> {
  const s = sessions.get(chat);
  if (s?.isReady) {
    await s.send(msg);
    return 'live';
  }
  if (!queueable || !MAILBOX_TYPES.has(msg.t) || !canMail(chat)) throw new Error('not connected');
  return asyncQueue(chat).run(async () => {
    const c = contact(chat)!;
    const st = asyncCache.get(chat)!;
    const ep = st.epochs[0]!;
    const r = Ratchet.fromJSON(ep.ratchet);
    if (!r.canSend) throw new Error('offline channel not ready');
    const sealed = await r.encrypt(utf8(JSON.stringify(msg)));
    // Persist the advanced ratchet before anything leaves the device.
    ep.ratchet = r.toJSON();
    await R().saveAsync(chat, st);
    const envelope = await sealEnvelope(await envKey(ep.envKey), sealed);
    const item = { id: randomId(), chat, msgId: msg.t === 'msg' ? String(msg.id) : undefined, relay: c.mailbox!.relay, sid: c.mailbox!.sid, envelope: toB64u(envelope), tries: 0 };
    try {
      await postToMailbox(item.relay, item.sid, envelope);
      return 'mailbox' as const;
    } catch (err) {
      if (err instanceof RelayError && err.status === 404) {
        await updateContact(chat, { mailbox: undefined });
        publishOffline();
        throw err;
      }
      await R().saveOutbox(item);
      return 'outbox' as const;
    }
  });
}

let flushing = false;
async function flushOutbox() {
  if (!repo || flushing) return;
  flushing = true;
  try {
    for (const item of await R().listOutbox()) {
      try {
        await postToMailbox(item.relay, item.sid, fromB64u(item.envelope));
        await R().deleteOutbox(item.id);
        const m = item.msgId ? findMessage(item.chat, (x) => x.id === item.msgId) : undefined;
        if (m && m.status === 'sending') await setMessage({ ...m, status: 'queued' });
      } catch (err) {
        const gone = err instanceof RelayError && err.status === 404;
        if (gone || item.tries >= 200) {
          await R().deleteOutbox(item.id);
          const m = item.msgId ? findMessage(item.chat, (x) => x.id === item.msgId) : undefined;
          if (m) await setMessage({ ...m, status: 'failed' });
        } else {
          await R().saveOutbox({ ...item, tries: item.tries + 1 });
        }
      }
    }
  } finally {
    flushing = false;
  }
}

/** Fetches, decrypts and acknowledges everything waiting in our mailbox. */
export function pollMailbox(): Promise<void> {
  if (!repo) return Promise.resolve();
  const queues = [...(myMailbox ? [myMailbox] : []), ...[...channels.values()].flatMap((c) => (c.queue ? [c.queue] : []))];
  if (!queues.length) return Promise.resolve();
  polling ??= (async () => {
    try {
      for (const mb of queues) {
        let after = 0;
        for (;;) {
          const { messages, more } = await fetchMail(mb, after);
          for (const m of messages) {
            await receiveEnvelope(m.body).catch((e) => console.warn('[veil] mailbox message dropped:', (e as Error).message));
            after = m.id;
          }
          if (messages.length) await ackMail(mb, after);
          if (!more) break;
        }
      }
      store.set({ mailboxError: undefined });
    } catch (err) {
      if (err instanceof RelayError && err.status === 404) {
        store.set({ mailboxError: 'Your mailbox no longer exists on the relay. Set it up again.' });
      } else {
        store.set({ mailboxError: (err as Error).message });
      }
    }
  })().finally(() => (polling = undefined));
  return polling;
}

async function receiveEnvelope(body: Uint8Array) {
  // Trial decryption: the envelope carries no sender id.
  for (const [chat, st] of asyncCache) {
    for (const ep of st.epochs) {
      const inner = await openEnvelope(await envKey(ep.envKey), body);
      if (!inner) continue;
      const msg = await asyncQueue(chat).run(async () => {
        const r = Ratchet.fromJSON(ep.ratchet);
        const plain = await r.decrypt(inner);
        ep.ratchet = r.toJSON();
        await R().saveAsync(chat, st);
        return JSON.parse(fromUtf8(plain)) as AppMessage;
      });
      if (msg && typeof msg.t === 'string') await onAppMessage(chat, msg, 'mailbox');
      return;
    }
  }
  // Signaling for a pending invite connection.
  for (const ch of channels.values()) {
    const plain = await openEnvelope(await envKey(ch.key), body);
    if (!plain) continue;
    const m = JSON.parse(fromUtf8(plain)) as AppMessage;
    if (m?.t === 'rtc') await handleRtc(ch.peerId, { kind: 'channel', iid: ch.iid }, m, ch.peerName);
    return;
  }
  // Someone opened one of our invite links.
  for (const inv of invites.values()) {
    if (inv.exp < Date.now()) continue;
    const joined = await openJoin(inv, body);
    if (joined) return onJoin(inv, joined.note, joined.chan);
  }
}

/** Runs once per live session to give both sides a fresh post-quantum-seeded ratchet. */
async function startAsync(p: Pending, chat: string, peer: Uint8Array, asyncRoot: Uint8Array) {
  const zero = new Uint8Array(32);
  const sk = await hkdf(asyncRoot, zero, utf8('veil/v1/ratchet/sk'), 32);
  const env = await hkdf(asyncRoot, zero, utf8('veil/v1/mailbox/env'), 32);
  wipe(asyncRoot);
  const me = identity!.pub;
  const [i, r] = p.role === 'initiator' ? [me, peer] : [peer, me];
  const seed: LiveSeed = { role: p.role, sk, env: toB64u(env), ad: concat(utf8('veil/v1/ratchet/ad'), i, r) };
  wipe(env);
  const old = seeds.get(chat);
  if (old) wipe(old.sk);
  seeds.set(chat, seed);
  if (p.role === 'responder') {
    seed.bob = await generateRatchetKey();
    await p.session!.send({ t: 'ratchet-init', pub: toB64u(seed.bob.pub) });
  }
  if (myMailbox) await p.session!.send({ t: 'mailbox', relay: myMailbox.relay, sid: myMailbox.sid });
}

async function addEpoch(chat: string, r: Ratchet, env: string) {
  const st = asyncCache.get(chat) ?? { epochs: [] };
  st.epochs = [{ ratchet: r.toJSON(), envKey: env, created: Date.now() }, ...st.epochs].slice(0, MAX_EPOCHS);
  asyncCache.set(chat, st);
  await R().saveAsync(chat, st);
  publishOffline();
}

async function onRatchetInit(chat: string, m: AppMessage) {
  const seed = seeds.get(chat);
  if (!seed || seed.role !== 'initiator' || typeof m.pub !== 'string') return;
  seeds.delete(chat);
  const pub = fromB64u(m.pub);
  if (pub.length !== 32) return;
  const r = await Ratchet.initAlice(seed.sk, pub, seed.ad);
  const hello = await r.encrypt(utf8('veil-ratchet-hello'));
  wipe(seed.sk);
  await asyncQueue(chat).run(() => addEpoch(chat, r, seed.env));
  await sessions.get(chat)?.send({ t: 'ratchet-hello', m: toB64u(hello) });
}

async function onRatchetHello(chat: string, m: AppMessage) {
  const seed = seeds.get(chat);
  if (!seed || seed.role !== 'responder' || !seed.bob || typeof m.m !== 'string') return;
  seeds.delete(chat);
  const r = Ratchet.initBob(seed.sk, seed.bob, seed.ad);
  const hello = fromUtf8(await r.decrypt(fromB64u(m.m)));
  wipe(seed.sk);
  if (hello !== 'veil-ratchet-hello') return;
  await asyncQueue(chat).run(() => addEpoch(chat, r, seed.env));
}

async function onMailboxCard(chat: string, m: AppMessage) {
  if (m.remove === true) {
    await updateContact(chat, { mailbox: undefined });
    return publishOffline();
  }
  if (typeof m.relay !== 'string' || typeof m.sid !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(m.sid)) return;
  let relay: string;
  try {
    // A contact may only point us at a local relay when we run locally ourselves.
    relay = normalizeRelayUrl(m.relay, isLocalApp());
  } catch {
    return;
  }
  await updateContact(chat, { mailbox: { relay, sid: m.sid } });
  publishOffline();
  void flushOutbox();
}

const isLocalApp = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1';

async function announceMailbox() {
  const card: AppMessage = myMailbox ? { t: 'mailbox', relay: myMailbox.relay, sid: myMailbox.sid } : { t: 'mailbox', remove: true };
  for (const c of S().contacts) void sendApp(c.id, card).catch(() => {});
}

/** Creates our mailbox on a relay and tells contacts where to leave messages. */
export async function setupMailbox(input: string) {
  const relay = normalizeRelayUrl(input, true);
  if (myMailbox) await removeMailbox();
  const mb = await createMailbox(relay);
  await R().saveMailbox(mb);
  myMailbox = mb;
  publishOffline();
  await announceMailbox();
}

export async function removeMailbox() {
  const mb = myMailbox;
  if (!mb) return;
  myMailbox = undefined;
  await announceMailbox();
  await deleteMailbox(mb).catch(() => {});
  await R().saveMailbox(undefined);
  publishOffline();
}

/** Registers (or removes) a Web Push subscription so the relay can wake this device. */
export async function setMailboxPush(on: boolean) {
  const mb = myMailbox;
  if (!mb || !('serviceWorker' in navigator)) throw new Error('Push is not available here');
  const reg = await navigator.serviceWorker.ready;
  if (!reg.pushManager) throw new Error('This browser does not support push');
  if (on) {
    const info = await relayInfo(mb.relay);
    let sub = await reg.pushManager.getSubscription();
    const current = sub?.options.applicationServerKey ? toB64u(new Uint8Array(sub.options.applicationServerKey)) : undefined;
    if (sub && current !== info.vapid) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(info.vapid) });
    await setPushEndpoint(mb, sub.endpoint);
    mb.push = sub.endpoint;
  } else {
    await setPushEndpoint(mb, null).catch(() => {});
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    mb.push = undefined;
  }
  await R().saveMailbox(mb);
  publishOffline();
}

// The service worker asks us to check the mailbox when a push arrives while we are open.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if ((e.data as { type?: string })?.type === 'veil-poll') void pollMailbox();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void pollMailbox();
});
addEventListener('online', () => {
  void flushOutbox();
  void pollMailbox();
});

// ------------------------------------------------------------------ rendezvous: invite links & one-tap reconnect

/**
 * With a mailbox relay, WebRTC signaling no longer needs copy-pasted codes:
 *
 *   knock  "I would like to connect"           (from the side that wants to talk)
 *   offer  SDP offer                           (from the side that receives a knock)
 *   answer SDP answer                          (from the knocker)
 *
 * Between contacts these travel inside the Double Ratchet (authenticated as that
 * contact). Before two people are contacts, they travel over an invite channel keyed by
 * the invite link (see net/invite.ts). Either way the resulting live session still runs
 * the full hybrid handshake, pinned to the expected identity.
 *
 * Glare (both knock or both offer at once) is resolved deterministically: the side
 * with the smaller identity key becomes the offerer.
 */

type Transport = { kind: 'contact' } | { kind: 'channel'; iid: string };
interface Attempt {
  aid: string;
  role: 'knocker' | 'offerer' | 'answerer';
  link?: PeerLink;
  started: number;
}

const KNOCK_TTL = 3 * 60_000;
const OFFER_TTL = 90_000;
const BOOST_MS = 3 * 60_000;
const BOOST_POLL_MS = 2_000;

const invites = new Map<string, InviteSecret>();
const channels = new Map<string, ChannelRecord>();
const attempts = new Map<string, Attempt>();
const lastKnock = new Map<string, number>();
let boostTimer: ReturnType<typeof setInterval> | undefined;
let boostUntil = 0;

export const DEFAULT_RELAY: string | undefined = (import.meta.env.VITE_DEFAULT_RELAY as string | undefined) || undefined;

/** Poll our queues every 2 s for a while: someone is (or may be) trying to connect. */
function boost(ms = BOOST_MS) {
  boostUntil = Math.max(boostUntil, Date.now() + ms);
  void pollMailbox();
}

function connecting(): boolean {
  const c = S().connect;
  return attempts.size > 0 || (!!c && ['waiting', 'connecting', 'requested', 'link'].includes(c.step));
}

function publishInvites() {
  const list: InviteSummary[] = [...invites.values()].map((i) => ({ iid: i.iid, created: i.created, expires: i.exp, claimed: !!i.claimedBy })).sort((a, b) => b.created - a.created);
  store.set({ invites: list });
}

async function sendRtc(peer: string, t: Transport, msg: AppMessage) {
  if (t.kind === 'contact') {
    await sendApp(peer, msg);
    return;
  }
  const ch = channels.get(t.iid);
  if (!ch) throw new Error('invite channel closed');
  await postToMailbox(ch.sendTo.relay, ch.sendTo.sid, await sealEnvelope(await envKey(ch.key), utf8(JSON.stringify(msg))));
}

function setConnecting(peer: string, on: boolean) {
  store.set((s) => {
    const presence = { ...s.presence };
    if (on && presence[peer] !== 'online') presence[peer] = 'connecting';
    if (!on && presence[peer] === 'connecting') delete presence[peer];
    return { presence };
  });
}

/** Ask a peer's device to connect. Times out quietly if they are not around. */
async function knock(peer: string, t: Transport, hint = '', quiet = true) {
  if (sessions.get(peer)?.isReady) return;
  const current = attempts.get(peer);
  if (current && Date.now() - current.started < 20_000) return; // already trying
  const aid = randomId();
  attempts.set(peer, { aid, role: 'knocker', started: Date.now() });
  lastKnock.set(peer, Date.now());
  setConnecting(peer, true);
  boost();
  try {
    await sendRtc(peer, t, { t: 'rtc', k: 'knock', aid, ts: Date.now() });
  } catch (err) {
    attempts.delete(peer);
    setConnecting(peer, false);
    if (!quiet) toast(`Could not reach ${hint || 'them'}: ${(err as Error).message}`, 'error');
    return;
  }
  setTimeout(() => {
    if (attempts.get(peer)?.aid !== aid) return;
    attempts.delete(peer);
    setConnecting(peer, false);
    if (!quiet && !sessions.get(peer)?.isReady) toast(`${hint || 'They'} did not answer. Messages will wait in their mailbox.`);
  }, KNOCK_TTL);
}

/** One-tap (or automatic) reconnect to an existing contact through the mailbox. */
export async function connectContact(chat: string, quiet = false): Promise<void> {
  if (!canMail(chat)) return createInvite(chat, true);
  closeConnect();
  await knock(chat, { kind: 'contact' }, displayName(contact(chat)!), quiet);
}

async function offerTo(peer: string, t: Transport, aid: string) {
  attempts.get(peer)?.link?.pc.close();
  const link = createPeer(S().settings);
  attempts.set(peer, { aid, role: 'offerer', link, started: Date.now() });
  setConnecting(peer, true);
  boost();
  const sdp = await makeOffer(link);
  if (attempts.get(peer)?.link !== link) return link.pc.close();
  await sendRtc(peer, t, { t: 'rtc', k: 'offer', aid, ts: Date.now(), sdp });
  setTimeout(() => {
    const a = attempts.get(peer);
    if (a?.link === link && !sessions.get(peer)?.isReady) {
      link.pc.close();
      attempts.delete(peer);
      setConnecting(peer, false);
    }
  }, OFFER_TTL + 30_000);
}

/** Do we still want a connection with this peer (so stale offers deserve a fresh knock)? */
function wantsConnection(peer: string) {
  return attempts.get(peer)?.role === 'knocker' || [...channels.values()].some((c) => c.peerId === peer && c.role === 'joiner');
}

async function handleRtc(peer: string, t: Transport, m: AppMessage, hint: string) {
  const ts = num(m.ts);
  const aid = typeof m.aid === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(m.aid) ? m.aid : undefined;
  if (!ts || !aid || peer === S().myId || sessions.get(peer)?.isReady) return;
  const age = Date.now() - ts;
  const mine = attempts.get(peer);
  const iAmSmaller = S().myId < peer;

  if (m.k === 'knock') {
    if (age > KNOCK_TTL) return;
    if (mine?.role === 'offerer' || mine?.role === 'answerer') return;
    if (mine?.role === 'knocker' && !iAmSmaller) return; // glare: they will offer
    const watching = S().activeChat === peer && document.visibilityState === 'visible';
    if (!mine && t.kind === 'contact' && !S().settings.autoConnect && !watching) {
      await addSystemNote(peer, `${hint || 'Your contact'} tried to connect. Tap Connect to reach them.`);
      return;
    }
    return offerTo(peer, t, aid);
  }

  if (m.k === 'offer' && typeof m.sdp === 'string' && m.sdp.length < 16_000) {
    if (age > OFFER_TTL) {
      if (wantsConnection(peer)) void knock(peer, t, hint);
      return;
    }
    if (mine?.role === 'offerer' && mine.aid !== aid && iAmSmaller) return; // glare: our offer wins
    if (mine?.role === 'answerer' && mine.aid === aid) return; // duplicate
    mine?.link?.pc.close();
    const link = createPeer(S().settings);
    attempts.set(peer, { aid, role: 'answerer', link, started: Date.now() });
    setConnecting(peer, true);
    const sdp = await acceptOffer(link, m.sdp);
    const p: Pending = { link, ref: aid, role: 'responder', hint };
    p.session = new Session(link, 'responder', identity!, peerPub(peer), sessionEvents(p));
    await sendRtc(peer, t, { t: 'rtc', k: 'answer', aid, ts: Date.now(), sdp });
    return;
  }

  if (m.k === 'answer' && typeof m.sdp === 'string' && m.sdp.length < 16_000) {
    if (mine?.role !== 'offerer' || mine.aid !== aid || !mine.link) return;
    await acceptAnswer(mine.link, m.sdp);
    const p: Pending = { link: mine.link, ref: aid, role: 'initiator', hint };
    p.session = new Session(mine.link, 'initiator', identity!, peerPub(peer), sessionEvents(p));
  }
}

/** Clean up invite state once two devices have met. */
async function onConnected(peer: string) {
  attempts.delete(peer);
  for (const ch of [...channels.values()]) {
    if (ch.peerId !== peer) continue;
    if (ch.role === 'inviter') {
      invites.delete(ch.iid);
      await R().deleteInvite(ch.iid);
    }
    await dropChannel(ch);
  }
  publishInvites();
}

async function dropChannel(ch: ChannelRecord) {
  channels.delete(ch.iid);
  if (repo) await R().deleteChannel(ch.iid);
  if (ch.queue) await deleteMailbox(ch.queue).catch(() => {});
}

// ---- inviter side

/** Creates a long-lived, single-use invite link (requires our mailbox). */
export async function createInviteLink() {
  if (!myMailbox) throw new Error('Set up a mailbox to create invite links');
  closeConnect();
  store.set({ connect: { mode: 'invite', step: 'creating' } });
  try {
    const days = Math.min(30, Math.max(1, S().settings.inviteDays || 7));
    const secret = await createInviteSecret(days * 86_400_000);
    await R().saveInvite(secret);
    invites.set(secret.iid, secret);
    publishInvites();
    const inv: InviteV2 = { v: 2, id: S().myId, name: S().profile.name, relay: myMailbox.relay, sid: myMailbox.sid, ik: secret.ikPub, tok: secret.tok, iid: secret.iid, exp: secret.exp };
    const code = await encodeInvite(inv);
    store.set({ connect: { mode: 'invite', step: 'link', code, link: signalLink(code), expires: secret.exp } });
  } catch (err) {
    store.set({ connect: { mode: 'invite', step: 'error', error: (err as Error).message } });
  }
}

export async function revokeInvite(iid: string) {
  invites.delete(iid);
  await R().deleteInvite(iid);
  for (const ch of [...channels.values()]) if (ch.iid === iid) await dropChannel(ch);
  publishInvites();
}

async function onJoin(inv: InviteSecret, note: JoinNote, chan: Uint8Array) {
  if (note.id === S().myId) return;
  if (inv.claimedBy && inv.claimedBy !== note.id) return; // single use: someone else got here first
  let reply: { relay: string; sid: string };
  try {
    reply = { relay: normalizeRelayUrl(note.reply.relay, isLocalApp()), sid: note.reply.sid };
    if (!/^[A-Za-z0-9_-]{22}$/.test(reply.sid)) return;
  } catch {
    return;
  }
  inv.claimedBy = note.id;
  await R().saveInvite(inv);
  const name = String(note.name ?? '').slice(0, MAX_NAME);
  const ch: ChannelRecord = { iid: inv.iid, role: 'inviter', key: toB64u(chan), peerId: note.id, peerName: name, sendTo: reply, expires: inv.exp };
  channels.set(ch.iid, ch);
  await R().saveChannel(ch);
  publishInvites();
  if (document.visibilityState === 'visible') toast(`${name || 'Someone'} opened your invite - connecting...`);
  else void notify({ kind: 'connected', name: name || undefined });
  // A join is a standing request: offer now even if it waited a while; if they are
  // gone, their app knocks again when it comes back.
  await offerTo(note.id, { kind: 'channel', iid: ch.iid }, note.aid);
}

// ---- joiner side

let previewed: InviteV2 | undefined;

async function previewInvite(text: string) {
  try {
    const inv = await decodeInvite(text);
    if (inv.id === S().myId) throw new Error('This is your own invite - send it to someone else');
    if (inv.exp < Date.now()) throw new Error('This invite link has expired. Ask for a new one.');
    previewed = inv;
    closeConnect();
    if (contact(inv.id) && canMail(inv.id)) {
      // Already a contact: just reach them.
      await openChat(inv.id);
      return connectContact(inv.id);
    }
    store.set({ connect: { mode: 'join', step: 'confirm', peerName: inv.name } });
  } catch (err) {
    store.set({ connect: { mode: 'join', step: 'error', error: (err as Error).message } });
  }
}

/** Accept the previewed invite: leave an encrypted join note in the inviter's mailbox. */
export async function acceptInvite() {
  const inv = previewed;
  if (!inv) return;
  store.set({ connect: { mode: 'join', step: 'creating', peerName: inv.name } });
  try {
    const relay = normalizeRelayUrl(inv.relay, isLocalApp());
    let queue: ChannelRecord['queue'];
    let reply: { relay: string; sid: string };
    if (myMailbox) {
      reply = { relay: myMailbox.relay, sid: myMailbox.sid };
    } else {
      // No mailbox of our own: a temporary reply queue on their relay, deleted after we meet.
      queue = await createMailbox(relay);
      reply = { relay: queue.relay, sid: queue.sid };
    }
    const aid = randomId();
    const note: JoinNote = { t: 'join', iid: inv.iid, tok: inv.tok, id: S().myId, name: S().profile.name, reply, aid, ts: Date.now() };
    const { envelope, chan } = await sealJoin(inv, note);
    const ch: ChannelRecord = { iid: inv.iid, role: 'joiner', key: toB64u(chan), peerId: inv.id, peerName: inv.name, sendTo: { relay, sid: inv.sid }, queue, expires: inv.exp };
    wipe(chan);
    channels.set(ch.iid, ch);
    await R().saveChannel(ch);
    attempts.set(inv.id, { aid, role: 'knocker', started: Date.now() });
    lastKnock.set(inv.id, Date.now());
    await postToMailbox(relay, inv.sid, envelope);
    previewed = undefined;
    boost();
    void holdWakeLock();
    store.set({ connect: { mode: 'join', step: 'requested', peerName: inv.name } });
  } catch (err) {
    store.set({ connect: { mode: 'join', step: 'error', peerName: inv.name, error: (err as Error).message } });
  }
}

// ---- keep the screen awake while waiting for someone

let wakeLock: { release(): Promise<void> } | undefined;
async function holdWakeLock() {
  try {
    wakeLock ??= await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen');
  } catch {
    /* not supported or not allowed - fine */
  }
}
function releaseWakeLock() {
  void wakeLock?.release().catch(() => {});
  wakeLock = undefined;
}
