/**
 * Thin, typed wrappers over WebCrypto. Every primitive used by Veil lives here so
 * the cryptographic surface is small and auditable.
 *
 *   - Ed25519        identity signatures
 *   - X25519         ephemeral Diffie-Hellman
 *   - ML-KEM-768     post-quantum KEM (via @noble/post-quantum, see handshake.ts)
 *   - HKDF-SHA-256   key derivation
 *   - HMAC-SHA-256   KDF chains
 *   - AES-256-GCM    authenticated encryption
 *   - PBKDF2-SHA-256 passphrase stretching (vault)
 */

const subtle = globalThis.crypto.subtle;

export type Bytes = Uint8Array<ArrayBuffer>;

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', data as BufferSource));
}

// ---------- Ed25519 ----------

export async function ed25519Generate(): Promise<CryptoKeyPair> {
  return (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

export async function ed25519Sign(priv: CryptoKey, data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.sign({ name: 'Ed25519' }, priv, data as BufferSource));
}

export async function ed25519Verify(pubRaw: Uint8Array, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (pubRaw.length !== 32 || sig.length !== 64) return false;
  const pub = await subtle.importKey('raw', pubRaw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  return subtle.verify({ name: 'Ed25519' }, pub, sig as BufferSource, data as BufferSource);
}

// ---------- X25519 ----------

export async function x25519Generate(): Promise<CryptoKeyPair> {
  // Private key is non-extractable: it only ever lives inside WebCrypto.
  return (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
}

export async function x25519(priv: CryptoKey, peerPubRaw: Uint8Array): Promise<Bytes> {
  if (peerPubRaw.length !== 32) throw new Error('bad X25519 public key');
  const pub = await subtle.importKey('raw', peerPubRaw as BufferSource, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256));
  // Reject all-zero output (small-order point) per RFC 7748 section 6.1.
  if (shared.every((b) => b === 0)) throw new Error('X25519 produced all-zero secret');
  return shared;
}

export async function exportRaw(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle.exportKey('raw', key));
}

// ---------- HKDF / HMAC ----------

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hmac(keyRaw: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const key = await subtle.importKey('raw', keyRaw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data as BufferSource));
}

// ---------- AES-256-GCM ----------

export async function aesKey(raw: Uint8Array, usages: KeyUsage[] = ['encrypt', 'decrypt']): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('AES-256 key must be 32 bytes');
  return subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, usages);
}

export async function aesGcmEncrypt(key: CryptoKey, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Bytes> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 };
  if (aad) params.additionalData = aad as BufferSource;
  return new Uint8Array(await subtle.encrypt(params, key, plaintext as BufferSource));
}

export async function aesGcmDecrypt(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Promise<Bytes> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 };
  if (aad) params.additionalData = aad as BufferSource;
  return new Uint8Array(await subtle.decrypt(params, key, ciphertext as BufferSource));
}

// ---------- PBKDF2 ----------

export async function pbkdf2(passphrase: string, salt: Uint8Array, iterations: number): Promise<Bytes> {
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, 256);
  return new Uint8Array(bits);
}

/** Feature detection - Veil requires Ed25519 + X25519 in WebCrypto (all evergreen browsers). */
export async function cryptoSupported(): Promise<boolean> {
  try {
    await ed25519Generate();
    await x25519Generate();
    return true;
  } catch {
    return false;
  }
}
