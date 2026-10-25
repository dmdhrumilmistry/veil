import { concat, fromB64u, toB64u } from '../crypto/encoding';
import { generateIdentity, importIdentityPrivate, type Identity } from '../crypto/identity';
import * as idb from './idb';
import type { RatchetJSON } from '../crypto/ratchet';
import type { MyMailbox } from '../net/mailbox';
import type { InviteSecret } from '../net/invite';
import type { Vault } from './vault';

/** `queued`: waiting in the recipient's mailbox relay (they were offline). */
export type MessageStatus = 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type FileState = 'offered' | 'transferring' | 'done' | 'failed' | 'declined' | 'canceled' | 'removed';

export interface FileMeta {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  sha256?: string;
  state: FileState;
  /** Bytes transferred so far. */
  progress: number;
  chunks: number;
}

export interface Message {
  id: string;
  chat: string;
  dir: 'in' | 'out';
  ts: number;
  kind: 'text' | 'file';
  text?: string;
  file?: FileMeta;
  status: MessageStatus;
  /** Epoch ms after which both devices delete the message. */
  expiresAt?: number;
}

export interface Contact {
  id: string; // base64url Ed25519 identity key
  /** Name the peer chose (updated from their profile). */
  name: string;
  /** Local nickname that overrides `name`. */
  alias?: string;
  addedAt: number;
  lastSeen: number;
  verified: boolean;
  /** 0 = off, else seconds. */
  disappearSecs: number;
  unread: number;
  /** Last message summary for the chat list (stored encrypted like everything else). */
  preview?: MessagePreview;
  /** Where to leave messages for this contact while they are offline (their relay). */
  mailbox?: { relay: string; sid: string };
}

export interface MessagePreview {
  kind: 'text' | 'file';
  text: string;
  dir: 'in' | 'out';
  ts: number;
  expiresAt?: number;
}

export interface Settings {
  autoLockMins: number;
  theme: 'system' | 'dark' | 'light';
  useStun: boolean;
  stunUrls: string[];
  turnUrl: string;
  turnUser: string;
  turnPass: string;
  autoAcceptMB: number;
  enterToSend: boolean;
  notifications: boolean;
  /** Show contact names in notifications (visible on lock screens). */
  notifyNames: boolean;
  /** Knock on a contact's device when opening their chat, and answer their knocks. */
  autoConnect: boolean;
  /** Lifetime of invite links, in days. */
  inviteDays: number;
  /** Epoch ms of the last successful backup (0 = never). */
  lastBackupAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockMins: 15,
  theme: 'system',
  useStun: true,
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turnUrl: '',
  turnUser: '',
  turnPass: '',
  autoAcceptMB: 25,
  enterToSend: true,
  notifications: false,
  notifyNames: false,
  autoConnect: true,
  inviteDays: 7,
  lastBackupAt: 0,
};

export interface Profile {
  name: string;
}

export interface StoredIdentity {
  pub: string;
  pkcs8: string;
}

/** One Double Ratchet epoch: re-seeded at every live connection, newest first. */
export interface AsyncEpoch {
  ratchet: RatchetJSON;
  envKey: string;
  created: number;
}

export interface AsyncState {
  epochs: AsyncEpoch[];
}

/** Signaling channel opened by an invite link, until the two devices first connect. */
export interface ChannelRecord {
  iid: string;
  role: 'inviter' | 'joiner';
  key: string;
  peerId: string;
  peerName: string;
  sendTo: { relay: string; sid: string };
  /** Joiner without a mailbox: temporary reply queue on the inviter's relay. */
  queue?: MyMailbox;
  expires: number;
}

/** A sealed envelope waiting to be uploaded (relay unreachable at send time). */
export interface OutboxItem {
  id: string;
  chat: string;
  msgId?: string;
  relay: string;
  sid: string;
  envelope: string;
  tries: number;
}

export const CHUNK_STORE_SIZE = 1024 * 1024; // files are persisted in 1 MiB sealed chunks

/** Typed persistence for all app data. Every value passes through the vault. */
export class Repo {
  constructor(readonly vault: Vault) {}

  // ---- identity / profile / settings ----

  async createIdentity(): Promise<Identity> {
    const { identity, pkcs8 } = await generateIdentity();
    await this.vault.putJson('kv', 'identity', { pub: toB64u(identity.pub), pkcs8: toB64u(pkcs8) } satisfies StoredIdentity);
    pkcs8.fill(0);
    return identity;
  }

  /** Raw identity record, only for writing an encrypted backup. */
  exportIdentity(): Promise<StoredIdentity | undefined> {
    return this.vault.getJson<StoredIdentity>('kv', 'identity');
  }

  async importIdentity(s: StoredIdentity): Promise<void> {
    if (typeof s?.pub !== 'string' || typeof s?.pkcs8 !== 'string' || fromB64u(s.pub).length !== 32) throw new Error('invalid identity in backup');
    await importIdentityPrivate(fromB64u(s.pkcs8)); // validates the key before we store it
    await this.vault.putJson('kv', 'identity', { pub: s.pub, pkcs8: s.pkcs8 } satisfies StoredIdentity);
  }

  async loadIdentity(): Promise<Identity | undefined> {
    const s = await this.vault.getJson<StoredIdentity>('kv', 'identity');
    if (!s) return undefined;
    const pkcs8 = fromB64u(s.pkcs8);
    const priv = await importIdentityPrivate(pkcs8);
    pkcs8.fill(0);
    return { pub: fromB64u(s.pub), priv };
  }

  async getProfile(): Promise<Profile> {
    return (await this.vault.getJson<Profile>('kv', 'profile')) ?? { name: '' };
  }

  saveProfile(p: Profile) {
    return this.vault.putJson('kv', 'profile', p);
  }

  async getSettings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...(await this.vault.getJson<Partial<Settings>>('kv', 'settings')) };
  }

  saveSettings(s: Settings) {
    return this.vault.putJson('kv', 'settings', s);
  }

  // ---- offline messaging (never included in backups: ratchet state must not be rolled back) ----

  getMailbox() {
    return this.vault.getJson<MyMailbox>('kv', 'mailbox');
  }

  async saveMailbox(mb: MyMailbox | undefined) {
    if (mb) await this.vault.putJson('kv', 'mailbox', mb);
    else await idb.del('kv', 'mailbox');
  }

  private async asyncSlot(id: string) {
    return `async/${await this.vault.tag(`async:${id}`)}`;
  }

  async getAsync(id: string) {
    return this.vault.getJson<AsyncState>('kv', await this.asyncSlot(id));
  }

  async saveAsync(id: string, s: AsyncState) {
    await this.vault.putJson('kv', await this.asyncSlot(id), s);
  }

  async deleteAsync(id: string) {
    await idb.del('kv', await this.asyncSlot(id));
  }

  async listInvites(): Promise<InviteSecret[]> {
    return (await this.vault.listJson<InviteSecret>('kv', 'invite/')).map(([, v]) => v);
  }

  saveInvite(i: InviteSecret) {
    return this.vault.putJson('kv', `invite/${i.iid}`, i);
  }

  deleteInvite(iid: string) {
    return idb.del('kv', `invite/${iid}`);
  }

  async listChannels(): Promise<ChannelRecord[]> {
    return (await this.vault.listJson<ChannelRecord>('kv', 'chan/')).map(([, v]) => v);
  }

  saveChannel(c: ChannelRecord) {
    return this.vault.putJson('kv', `chan/${c.iid}`, c);
  }

  deleteChannel(iid: string) {
    return idb.del('kv', `chan/${iid}`);
  }

  async listOutbox(): Promise<OutboxItem[]> {
    return (await this.vault.listJson<OutboxItem>('kv', 'outbox/')).map(([, o]) => o);
  }

  async saveOutbox(o: OutboxItem) {
    await this.vault.putJson('kv', `outbox/${o.id}`, o);
  }

  async deleteOutbox(id: string) {
    await idb.del('kv', `outbox/${id}`);
  }

  // ---- contacts ----

  private async contactSlot(id: string) {
    return `contact/${await this.vault.tag(`contact:${id}`)}`;
  }

  async listContacts(): Promise<Contact[]> {
    return (await this.vault.listJson<Contact>('kv', 'contact/')).map(([, c]) => c);
  }

  async saveContact(c: Contact) {
    await this.vault.putJson('kv', await this.contactSlot(c.id), c);
  }

  async deleteContact(id: string) {
    await this.clearChat(id);
    await this.deleteAsync(id);
    await idb.del('kv', await this.contactSlot(id));
  }

  // ---- messages ----

  private async chatPrefix(chat: string) {
    return `${await this.vault.tag(`chat:${chat}`)}/`;
  }

  async listMessages(chat: string): Promise<Message[]> {
    const rows = await this.vault.listJson<Message>('msgs', await this.chatPrefix(chat));
    return rows.map(([, m]) => m).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  async saveMessage(m: Message) {
    await this.vault.putJson('msgs', (await this.chatPrefix(m.chat)) + m.id, m);
  }

  async deleteMessage(m: Message) {
    if (m.file) await this.deleteFile(m.file.fileId, m.file.chunks);
    await idb.del('msgs', (await this.chatPrefix(m.chat)) + m.id);
  }

  async clearChat(chat: string) {
    for (const m of await this.listMessages(chat)) await this.deleteMessage(m);
  }

  // ---- file chunks (sealed at rest, 1 MiB each) ----

  private async chunkSlot(fileId: string, index: number) {
    return `${await this.vault.tag(`file:${fileId}`)}/${String(index).padStart(8, '0')}`;
  }

  async putFileChunk(fileId: string, index: number, data: Uint8Array) {
    await this.vault.putBlob(await this.chunkSlot(fileId, index), data);
  }

  async getFileChunk(fileId: string, index: number) {
    return this.vault.getBlob(await this.chunkSlot(fileId, index));
  }

  async deleteFile(fileId: string, chunks: number) {
    for (let i = 0; i < chunks; i++) await idb.del('chunks', await this.chunkSlot(fileId, i));
  }

  /** Decrypts a stored file into a Blob (kept in memory only while displayed). */
  async loadFile(meta: FileMeta): Promise<Blob> {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < meta.chunks; i++) {
      const c = await this.getFileChunk(meta.fileId, i);
      if (!c) throw new Error('file data missing');
      parts.push(c);
    }
    return new Blob(parts.length ? parts : [concat()], { type: safeMime(meta.mime) });
  }
}

/** Only allow inert media types to be rendered inline; everything else is opaque bytes. */
export function safeMime(mime: string): string {
  return /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm|mp4))$/.test(mime)
    ? mime
    : 'application/octet-stream';
}
