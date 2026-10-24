import { concat, fromB64u, toB64u } from '../crypto/encoding';
import { generateIdentity, importIdentityPrivate, type Identity } from '../crypto/identity';
import * as idb from './idb';
import type { Vault } from './vault';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export type FileState = 'offered' | 'transferring' | 'done' | 'failed' | 'declined' | 'canceled';

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
};

export interface Profile {
  name: string;
}

interface StoredIdentity {
  pub: string;
  pkcs8: string;
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
