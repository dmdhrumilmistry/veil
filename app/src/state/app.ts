import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { randomId, toHex } from '../crypto/encoding';
import { peerId, peerPub, samePub, type Identity } from '../crypto/identity';
import { cryptoSupported } from '../crypto/primitives';
import { acceptAnswer, acceptOffer, createPeer, makeOffer, type PeerLink } from '../net/peer';
import { Session, type AppMessage } from '../net/session';
import { decodeSignal, encodeSignal, extractCode, signalLink } from '../net/signaling';
import * as idb from '../storage/idb';
import { BackupWriter, readBackup } from '../storage/backup';
import { CHUNK_STORE_SIZE, DEFAULT_SETTINGS, Repo, type Contact, type FileMeta, type Message, type MessagePreview, type Settings, type StoredIdentity } from '../storage/repo';
import { Vault } from '../storage/vault';
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
  if (code?.startsWith('VEIL1A') && (await handOffAnswer(code))) return;
  if (code) pendingCode = code;
  listenForHandoffs();
  addEventListener('hashchange', () => {
    const c = takeCodeFromUrl();
    if (!c) return;
    if (S().phase === 'ready') void openCode(c);
    else pendingCode = c;
  });
  store.set({ phase: (await Vault.exists()) ? 'locked' : 'onboarding' });
}

let pendingCode: string | undefined;

function takeCodeFromUrl(): string | undefined {
  const code = extractCode(decodeURIComponent(location.hash));
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return code;
}

export async function createAccount(name: string, passphrase: string) {
  const vault = await Vault.create(passphrase);
  repo = new Repo(vault);
  identity = await repo.createIdentity();
  await repo.saveProfile({ name: name.trim().slice(0, MAX_NAME) });
  await idb.requestPersistence();
  await enter();
}

export async function unlock(passphrase: string) {
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
  if (S().phase === 'ready' && mins > 0) lockTimer = setTimeout(() => lock('Locked after inactivity'), mins * 60_000);
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
  void sessions.get(id)?.send({ t: 'disappear', secs }).catch(() => {});
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
}

export async function markRead(id: string) {
  const c = contact(id);
  if (c?.unread) await updateContact(id, { unread: 0 });
  if (document.visibilityState !== 'visible' || S().activeChat !== id) return;
  const unread = (S().messages[id] ?? []).filter((m) => m.dir === 'in' && m.status !== 'read');
  if (!unread.length) return;
  for (const m of unread) await setMessage({ ...m, status: 'read' });
  void sessions.get(id)?.send({ t: 'receipt', s: 'read', ids: unread.map((m) => m.id) }).catch(() => {});
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
  const s = sessions.get(chat);
  if (!s?.isReady) return toast('Not connected - reconnect to send', 'error');
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
    await s.send({ t: 'msg', id: m.id, ts, text: body, ttl: c.disappearSecs || undefined });
    await setMessage({ ...m, status: 'sent' });
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

async function onAppMessage(chat: string, m: AppMessage) {
  const s = sessions.get(chat);
  switch (m.t) {
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
      void s?.send({ t: 'receipt', s: 'delivered', ids: [m.id] }).catch(() => {});
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
  if (pending && !pending.session?.isReady) pending.link.pc.close();
  pending = undefined;
  store.set({ connect: null });
}

function sessionEvents(p: Pending) {
  let chat = '';
  return {
    ready: (peer: Uint8Array) => void onReady(p, peer).then((id) => (chat = id)),
    message: (m: AppMessage) => {
      if (chat) void onAppMessage(chat, m).catch((e) => console.warn('[veil]', e));
    },
    chunk: (fileId: string, index: number, data: Uint8Array) => (chat ? onChunk(chat, fileId, index, data) : undefined),
    drain: () => {},
    closed: (reason: string) => {
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

async function onReady(p: Pending, peer: Uint8Array): Promise<string> {
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
  if (!existing) await addSystemNote(id, 'Connected. Compare safety numbers to verify this contact.');
  toast(`Securely connected to ${displayName(c)}`, 'success');
  void notify({ chat: id, kind: 'connected', name: displayName(c) });
  await openChat(id);
  return id;
}

export async function createInvite(forContact?: string) {
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
  if (acked) store.set({ phase: 'handoff', handoffMessage: 'Reply delivered to your open Veil tab. You can close this tab.' });
  return acked;
}

function listenForHandoffs() {
  if (!('BroadcastChannel' in window)) return;
  const bc = new BroadcastChannel(SIGNAL_CHANNEL);
  bc.onmessage = (e) => {
    const data = e.data as { type?: string; code?: unknown };
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
