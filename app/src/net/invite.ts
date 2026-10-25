import { concat, ctEqual, fromB64u, fromUtf8, randomBytes, toB64u, utf8, wipe } from '../crypto/encoding';
import { aesKey, exportRaw, hkdf, x25519, x25519Generate, type Bytes } from '../crypto/primitives';
import { openEnvelope, sealEnvelope } from './mailbox';

/**
 * Invite links (v2): long-lived, single-use, no reply code.
 *
 *   link   = .../app/#VEIL2I.<base64url(deflate(JSON invite))>
 *   invite = { v: 2, id, name, relay, sid, ik, tok, iid, exp }
 *
 * `ik` is an X25519 key created for this invite only. A joiner seals a `join` note to it:
 *
 *   join envelope = epk(32) || envelope(k_join, { t: "join", iid, tok, id, name, reply, aid, ts })
 *   (k_join || k_chan) = HKDF-SHA-256(X25519(epk, ik), salt = iid, info = "veil/v1/invite")
 *
 * Only the inviter (holding ik's private key) can open it, and the relay sees padded
 * ciphertext with no sender id. `k_chan` then protects the WebRTC signaling messages
 * both apps exchange through the relay until the live, post-quantum handshake (pinned
 * to the identities named here) takes over.
 */

export const INVITE_PREFIX = 'VEIL2I.';
const INFO = utf8('veil/v1/invite');
const MAX_CODE = 4096;

export interface InviteV2 {
  v: 2;
  /** Inviter identity public key (base64url). */
  id: string;
  /** Inviter display name hint (untrusted). */
  name: string;
  /** Inviter mailbox relay + send capability. */
  relay: string;
  sid: string;
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

export async function encodeInvite(inv: InviteV2): Promise<string> {
  return INVITE_PREFIX + toB64u(await pipe(utf8(JSON.stringify(inv)), new CompressionStream('deflate-raw')));
}

export function extractInvite(text: string): string | undefined {
  return text.match(/VEIL2I\.[A-Za-z0-9_-]+/)?.[0];
}

const isB64 = (s: unknown, bytes: number) => {
  if (typeof s !== 'string') return false;
  try {
    return fromB64u(s).length === bytes;
  } catch {
    return false;
  }
};

export async function decodeInvite(text: string): Promise<InviteV2> {
  const code = extractInvite(text);
  if (!code || code.length > MAX_CODE) throw new Error('That does not look like a Veil invite');
  let j: Partial<InviteV2>;
  try {
    j = JSON.parse(fromUtf8(await pipe(fromB64u(code.slice(INVITE_PREFIX.length)), new DecompressionStream('deflate-raw'))));
  } catch {
    throw new Error('This invite link is damaged - ask for a new one');
  }
  if (
    j.v !== 2 ||
    !isB64(j.id, 32) ||
    !isB64(j.ik, 32) ||
    !isB64(j.tok, 16) ||
    !isB64(j.iid, 16) ||
    typeof j.relay !== 'string' ||
    typeof j.sid !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(j.sid) ||
    typeof j.exp !== 'number'
  ) {
    throw new Error('Unsupported or invalid Veil invite');
  }
  return { v: 2, id: j.id!, name: typeof j.name === 'string' ? j.name.slice(0, 48) : '', relay: j.relay, sid: j.sid, ik: j.ik!, tok: j.tok!, iid: j.iid!, exp: j.exp };
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
  reply: { relay: string; sid: string };
  aid: string;
  ts: number;
}

/** Joiner: seal a join note to the invite key. Returns the envelope and the channel key. */
export async function sealJoin(inv: InviteV2, note: JoinNote): Promise<{ envelope: Bytes; chan: Bytes }> {
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
  if (!isB64(note.id, 32) || typeof note.reply?.relay !== 'string' || typeof note.reply?.sid !== 'string' || typeof note.aid !== 'string') return undefined;
  return { note, chan };
}
