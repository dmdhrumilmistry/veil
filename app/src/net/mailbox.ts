import { concat, randomBytes, utf8 } from '../crypto/encoding';
import { aesGcmDecrypt, aesGcmEncrypt, type Bytes } from '../crypto/primitives';

/**
 * Offline-message envelope format (carried by public Nostr relays, see nostr.ts).
 *
 * envelope = iv(12) || AES-256-GCM(envKey, iv, pad(u32 len || ratchetMessage))
 *
 * The envelope key is shared by the two contacts (derived from the post-quantum live
 * handshake), so the relay never sees Double Ratchet headers, and every envelope is
 * padded to a fixed bucket size so lengths reveal little. There is no sender id: the
 * recipient finds the right contact by trial decryption.
 */

// Largest bucket keeps base64 events well under common relay limits (128 KiB).
const BUCKETS = [1024, 4096, 16384, 49_152];
const AAD = utf8('veil/v1/mailbox/envelope');

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

// ---------------------------------------------------------------- mailbox cards

/** Where to leave messages for someone: a pseudonymous Nostr key and the relays they read. */
export interface MailboxCard {
  pk: string;
  relays: string[];
}

/** Our own mailbox: a random secp256k1 key, unrelated to the identity key. */
export interface MyMailbox {
  sk: string;
  pk: string;
}
