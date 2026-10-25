import { concat, ctEqual, fromB64u, fromUtf8, randomBytes, toB64u, utf8, wipe } from '../crypto/encoding';
import { aesKey, exportRaw, hkdf, x25519, x25519Generate, type Bytes } from '../crypto/primitives';
import { openEnvelope, sealEnvelope, type MailboxCard } from './mailbox';
import { isHexKey, MAX_RELAYS, normalizeRelay } from './nostr';

/**
 * Invite links (v3): long-lived, single-use, no reply code, no server of our own.
 *
 *   link   = .../app/#VEIL3I.<base64url(deflate(JSON invite))>
 *   invite = { v: 3, id, name, mb, rl, ik, tok, iid, exp }
 *            mb/rl = the inviter's Nostr mailbox key and the public relays it reads
 *
 * `ik` is an X25519 key created for this invite only. A joiner seals a `join` note to it:
 *
 *   join envelope = epk(32) || envelope(k_join, { t: "join", iid, tok, id, name, reply, aid, ts })
 *   (k_join || k_chan) = HKDF-SHA-256(X25519(epk, ik), salt = iid, info = "veil/v1/invite")
 *
 * Only the inviter (holding ik's private key) can open it, and relays see padded
 * ciphertext signed by a throwaway key. `k_chan` then protects the WebRTC signaling
 * messages both apps exchange through public relays until the live, post-quantum handshake (pinned
 * to the identities named here) takes over.
 */

export const INVITE_PREFIX = 'VEIL3I.';
const INFO = utf8('veil/v1/invite');
const MAX_CODE = 4096;

export interface InviteV3 {
  v: 3;
  /** Inviter identity public key (base64url). */
  id: string;
  /** Inviter display name hint (untrusted). */
  name: string;
  /** Inviter mailbox: Nostr public key (hex) and relays. */
  mb: string;
  rl: string[];
  /** Per-invite X25519 public key. */
  ik: string;
  /** Per-invite secret proving the joiner really holds this link. */
  tok: string;
  /** Invite id. */
  iid: string;
  /** Expiry, epoch ms. */
  exp: number;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit = 32 * 1024): Promise<Bytes> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) throw new Error('invite too large');
    parts.push(value);
  }
  return concat(...parts);
}

export async function encodeInvite(inv: InviteV3): Promise<string> {
  return INVITE_PREFIX + toB64u(await pipe(utf8(JSON.stringify(inv)), new CompressionStream('deflate-raw')));
}

export function extractInvite(text: string): string | undefined {
  return text.match(/VEIL[23]I\.[A-Za-z0-9_-]+/)?.[0];
}

const isB64 = (s: unknown, bytes: number) => {
  if (typeof s !== 'string') return false;
  try {
    return fromB64u(s).length === bytes;
  } catch {
    return false;
  }
};

/** Validates a mailbox card received from someone else. */
export function parseCard(pk: unknown, relays: unknown, allowLocal: boolean): MailboxCard | undefined {
  if (!isHexKey(pk) || !Array.isArray(relays)) return undefined;
  try {
    const rl = [...new Set(relays.slice(0, MAX_RELAYS).map((r) => normalizeRelay(String(r), allowLocal)))];
    return rl.length ? { pk, relays: rl } : undefined;
  } catch {
    return undefined;
  }
}

export async function decodeInvite(text: string, allowLocal = false): Promise<InviteV3> {
  const code = extractInvite(text);
  if (!code || code.length > MAX_CODE) throw new Error('That does not look like a Veil invite');
  if (code.startsWith('VEIL2I.')) throw new Error('This invite is from an older version of Veil. Ask for a new link.');
  let j: Partial<InviteV3>;
  try {
    j = JSON.parse(fromUtf8(await pipe(fromB64u(code.slice(INVITE_PREFIX.length)), new DecompressionStream('deflate-raw'))));
  } catch {
    throw new Error('This invite link is damaged - ask for a new one');
  }
  const card = parseCard(j.mb, j.rl, allowLocal);
  if (j.v !== 3 || !isB64(j.id, 32) || !isB64(j.ik, 32) || !isB64(j.tok, 16) || !isB64(j.iid, 16) || !card || typeof j.exp !== 'number') {
    throw new Error('Unsupported or invalid Veil invite');
  }
  return { v: 3, id: j.id!, name: typeof j.name === 'string' ? j.name.slice(0, 48) : '', mb: card.pk, rl: card.relays, ik: j.ik!, tok: j.tok!, iid: j.iid!, exp: j.exp };
}

/** Everything the inviter keeps locally for one invite. */
export interface InviteSecret {
  iid: string;
  tok: string;
  ikPub: string;
  ikPkcs8: string;
  exp: number;
  created: number;
  /** First joiner identity; the invite cannot be claimed by anyone else afterwards. */
  claimedBy?: string;
  claimedName?: string;
  /** Kept (spent) after use until expiry, so a second joiner reveals an intercepted link. */
  usedAt?: number;
  conflictReported?: boolean;
}

export async function createInviteSecret(ttlMs: number): Promise<InviteSecret> {
  const kp = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    iid: toB64u(randomBytes(16)),
    tok: toB64u(randomBytes(16)),
    ikPub: toB64u(await exportRaw(kp.publicKey)),
    ikPkcs8: toB64u(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
    exp: Date.now() + ttlMs,
    created: Date.now(),
  };
}

async function split(dh: Bytes, iid: string): Promise<{ join: CryptoKey; chan: Bytes }> {
  const okm = await hkdf(dh, fromB64u(iid), INFO, 64);
  wipe(dh);
  const join = await aesKey(okm.slice(0, 32));
  const chan = okm.slice(32);
  wipe(okm);
  return { join, chan };
}

export interface JoinNote {
  t: 'join';
  iid: string;
  tok: string;
  id: string;
  name: string;
  reply: MailboxCard;
  aid: string;
  ts: number;
}

/** Joiner: seal a join note to the invite key. Returns the envelope and the channel key. */
export async function sealJoin(inv: InviteV3, note: JoinNote): Promise<{ envelope: Bytes; chan: Bytes }> {
  const eph = await x25519Generate();
  const epk = await exportRaw(eph.publicKey);
  const { join, chan } = await split(await x25519(eph.privateKey, fromB64u(inv.ik)), inv.iid);
  return { envelope: concat(epk, await sealEnvelope(join, utf8(JSON.stringify(note)))), chan };
}

/** Inviter: try to open a join note with one of our invites. */
export async function openJoin(secret: InviteSecret, envelope: Uint8Array): Promise<{ note: JoinNote; chan: Bytes } | undefined> {
  if (envelope.length < 32 + 12 + 16) return undefined;
  const priv = await crypto.subtle.importKey('pkcs8', fromB64u(secret.ikPkcs8), { name: 'X25519' }, false, ['deriveBits']);
  let dh: Bytes;
  try {
    dh = await x25519(priv, envelope.subarray(0, 32));
  } catch {
    return undefined;
  }
  const { join, chan } = await split(dh, secret.iid);
  const plain = await openEnvelope(join, envelope.subarray(32));
  if (!plain) return undefined;
  let note: JoinNote;
  try {
    note = JSON.parse(fromUtf8(plain)) as JoinNote;
  } catch {
    return undefined;
  }
  if (note?.t !== 'join' || note.iid !== secret.iid || typeof note.tok !== 'string' || !ctEqual(utf8(note.tok), utf8(secret.tok))) return undefined;
  if (!isB64(note.id, 32) || !isHexKey(note.reply?.pk) || !Array.isArray(note.reply?.relays) || typeof note.aid !== 'string') return undefined;
  return { note, chan };
}
