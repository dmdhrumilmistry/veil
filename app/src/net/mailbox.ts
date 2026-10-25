import { concat, fromB64u, randomBytes, toB64u, utf8 } from '../crypto/encoding';
import { aesGcmDecrypt, aesGcmEncrypt, type Bytes } from '../crypto/primitives';

/**
 * Client for a Veil Mailbox Relay (see /relay) plus the envelope format.
 *
 * envelope = iv(12) || AES-256-GCM(envKey, iv, pad(u32 len || ratchetMessage))
 *
 * The envelope key is shared by the two contacts (derived from the post-quantum live
 * handshake), so the relay never sees Double Ratchet headers, and every envelope is
 * padded to a fixed bucket size so lengths reveal little. There is no sender id: the
 * recipient finds the right contact by trial decryption.
 */

const BUCKETS = [1024, 4096, 16384, 65_536 - 64];
const AAD = utf8('veil/v1/mailbox/envelope');

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

function pad(data: Uint8Array): Bytes {
  const need = data.length + 4;
  const size = BUCKETS.find((b) => b >= need + 28);
  if (!size) throw new Error('message too large for the mailbox');
  const out = new Uint8Array(size - 28); // 12-byte IV + 16-byte tag bring it to the bucket size
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

function unpad(p: Uint8Array): Bytes {
  const len = new DataView(p.buffer, p.byteOffset, 4).getUint32(0);
  if (len > p.length - 4) throw new Error('bad padding');
  return p.slice(4, 4 + len);
}

export async function sealEnvelope(envKey: CryptoKey, message: Uint8Array): Promise<Bytes> {
  const iv = randomBytes(12);
  return concat(iv, await aesGcmEncrypt(envKey, iv, pad(message), AAD));
}

/** Returns undefined when the envelope was not made with this key. */
export async function openEnvelope(envKey: CryptoKey, envelope: Uint8Array): Promise<Bytes | undefined> {
  if (envelope.length < 12 + 16 + 4) return undefined;
  try {
    return unpad(await aesGcmDecrypt(envKey, envelope.subarray(0, 12), envelope.subarray(12), AAD));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- relay API

export interface RelayInfo {
  service: 'veil-relay';
  v: number;
  vapid: string;
  maxMessage: number;
  ttlDays: number;
}

export interface MyMailbox {
  relay: string;
  rid: string;
  sid: string;
  pub: string;
  pkcs8: string;
  push?: string;
}

/** Relays must be HTTPS (plain HTTP is only allowed for a relay on this machine). */
export function normalizeRelayUrl(input: string, allowLocal = false): string {
  let u: URL;
  try {
    u = new URL(input.trim().includes('://') ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new RelayError('That is not a valid address');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (local && !allowLocal) throw new RelayError('Local relays are not allowed here');
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new RelayError('Relays must use https://');
  if (u.username || u.password || u.search || u.hash) throw new RelayError('Use a plain relay address');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new RelayError('Relay unreachable');
  }
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new RelayError(msg || `Relay error ${res.status}`, res.status);
  }
  return res;
}

export async function relayInfo(relay: string): Promise<RelayInfo> {
  const info = (await (await call(`${relay}/v1/info`)).json()) as RelayInfo;
  if (info?.service !== 'veil-relay' || info.v !== 1) throw new RelayError('That server is not a Veil relay');
  return info;
}

export async function createMailbox(relay: string): Promise<MyMailbox> {
  await relayInfo(relay);
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = toB64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const pkcs8 = toB64u(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
  const res = await call(`${relay}/v1/queues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: pub }) });
  const { rid, sid } = (await res.json()) as { rid: string; sid: string };
  return { relay, rid, sid, pub, pkcs8 };
}

export async function postToMailbox(relay: string, sid: string, envelope: Uint8Array): Promise<void> {
  await call(`${relay}/v1/send/${encodeURIComponent(sid)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: envelope as BodyInit });
}

async function owner(mb: MyMailbox, method: string, sub: string, body = '', query = ''): Promise<Response> {
  const path = `/v1/recv/${mb.rid}${sub}`;
  const ts = Date.now();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(body))), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('pkcs8', fromB64u(mb.pkcs8), { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, utf8(`veil-relay/v1\n${method}\n${path}\n${ts}\n${digest}`)));
  return call(`${mb.relay}${path}${query}`, {
    method,
    headers: { 'Veil-Auth': `${ts}.${toB64u(sig)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body || undefined,
  });
}

export async function fetchMail(mb: MyMailbox, after = 0): Promise<{ messages: { id: number; ts: number; body: Bytes }[]; more: boolean }> {
  const res = (await (await owner(mb, 'GET', '', '', `?after=${after}`)).json()) as { messages: { id: number; ts: number; body: string }[]; more: boolean };
  return { messages: res.messages.map((m) => ({ ...m, body: fromB64u(m.body) })), more: res.more };
}

export async function ackMail(mb: MyMailbox, upTo: number) {
  await owner(mb, 'POST', '/ack', JSON.stringify({ upTo }));
}

export async function setPushEndpoint(mb: MyMailbox, endpoint: string | null) {
  if (endpoint) await owner(mb, 'PUT', '/push', JSON.stringify({ endpoint }));
  else await owner(mb, 'DELETE', '/push');
}

export async function deleteMailbox(mb: MyMailbox) {
  await owner(mb, 'DELETE', '');
}
