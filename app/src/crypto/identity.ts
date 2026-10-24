import { sha512 } from '@noble/hashes/sha2.js';
import { concat, ctEqual, fromB64u, toB64u, utf8 } from './encoding';
import { ed25519Generate, exportRaw, type Bytes } from './primitives';

/** A long-term device identity. The private key is a non-extractable CryptoKey once unlocked. */
export interface Identity {
  pub: Bytes; // raw Ed25519 public key (32 bytes)
  priv: CryptoKey;
}

export async function generateIdentity(): Promise<{ identity: Identity; pkcs8: Bytes }> {
  const kp = await ed25519Generate();
  const pub = await exportRaw(kp.publicKey);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  // Re-import as non-extractable for in-memory use.
  const priv = await importIdentityPrivate(pkcs8);
  return { identity: { pub, priv }, pkcs8 };
}

export async function importIdentityPrivate(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'Ed25519' }, false, ['sign']);
}

/** Stable contact id derived from the identity public key. */
export const peerId = (pub: Uint8Array): string => toB64u(pub);
export const peerPub = (id: string): Bytes => fromB64u(id);

const SAFETY_ITERATIONS = 5200;

/** 30-digit fingerprint for one identity (Signal-style iterated hashing). */
function fingerprintDigits(pub: Uint8Array): string {
  const version = new Uint8Array([0, 1]);
  let h: Uint8Array = sha512(concat(version, pub, utf8('veil/safety-number')));
  for (let i = 0; i < SAFETY_ITERATIONS; i++) h = sha512(concat(h, pub));
  let digits = '';
  for (let i = 0; i < 30; i += 5) {
    // 5 bytes -> 40-bit big-endian integer -> mod 100000
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i + j]!;
    digits += String(n % 100000).padStart(5, '0');
  }
  return digits;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * 60-digit safety number shared by both parties (order-independent). If both people
 * see the same number, nobody intercepted the connection.
 */
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
  const [x, y] = cmpBytes(a, b) <= 0 ? [a, b] : [b, a];
  return fingerprintDigits(x) + fingerprintDigits(y);
}

export function formatSafetyNumber(n: string): string[] {
  return n.match(/.{5}/g) ?? [];
}

export const samePub = (a: Uint8Array, b: Uint8Array): boolean => ctEqual(a, b);
