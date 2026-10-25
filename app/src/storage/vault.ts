import { fromB64u, fromUtf8, randomBytes, toB64u, utf8, wipe } from '../crypto/encoding';
import { aesGcmDecrypt, aesGcmEncrypt, aesKey, hkdf, hmac, pbkdf2, type Bytes } from '../crypto/primitives';
import * as idb from './idb';

/**
 * Encrypted-at-rest storage.
 *
 *   passphrase --PBKDF2-SHA-256 (600k)--> KEK --AES-256-GCM unwrap--> master (32 random bytes)
 *   master --HKDF--> recordKey (AES-256-GCM, non-extractable) + indexKey (HMAC-SHA-256)
 *
 * Every record is sealed with a fresh random IV and the record's storage key as AAD,
 * so ciphertexts cannot be swapped between slots. Lookup keys are HMAC tags, so the
 * database never contains plaintext contact identifiers.
 */

export const KDF_ITERATIONS = 600_000;
const HEADER_KEY = 'vault';
const WRAP_AAD = utf8('veil/vault/v1/wrap');

interface VaultHeader {
  v: 1;
  kdf: 'PBKDF2-SHA-256';
  iter: number;
  salt: string;
  iv: string;
  wrapped: string;
}

interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Incorrect passphrase');
  }
}

export class Vault {
  private constructor(
    private readonly recordKey: CryptoKey,
    private indexKey: Bytes,
  ) {}

  static async exists(): Promise<boolean> {
    return (await idb.get<VaultHeader>('meta', HEADER_KEY)) !== undefined;
  }

  private static async fromMaster(master: Bytes): Promise<Vault> {
    const okm = await hkdf(master, new Uint8Array(32), utf8('veil/vault/v1/keys'), 64);
    const recordKey = await aesKey(okm.slice(0, 32));
    const indexKey = okm.slice(32);
    wipe(okm, master);
    return new Vault(recordKey, indexKey);
  }

  private static async wrap(master: Bytes, passphrase: string, iter: number): Promise<VaultHeader> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const kekRaw = await pbkdf2(passphrase, salt, iter);
    const kek = await aesKey(kekRaw);
    wipe(kekRaw);
    const wrapped = await aesGcmEncrypt(kek, iv, master, WRAP_AAD);
    return { v: 1, kdf: 'PBKDF2-SHA-256', iter, salt: toB64u(salt), iv: toB64u(iv), wrapped: toB64u(wrapped) };
  }

  private static async unwrap(h: VaultHeader, passphrase: string): Promise<Bytes> {
    const kekRaw = await pbkdf2(passphrase, fromB64u(h.salt), h.iter);
    const kek = await aesKey(kekRaw);
    wipe(kekRaw);
    try {
      return await aesGcmDecrypt(kek, fromB64u(h.iv), fromB64u(h.wrapped), WRAP_AAD);
    } catch {
      throw new WrongPassphraseError();
    }
  }

  static async create(passphrase: string, iter = KDF_ITERATIONS): Promise<Vault> {
    const master = randomBytes(32);
    await idb.put('meta', HEADER_KEY, await Vault.wrap(new Uint8Array(master), passphrase, iter));
    return Vault.fromMaster(master);
  }

  static async unlock(passphrase: string): Promise<Vault> {
    const h = await idb.get<VaultHeader>('meta', HEADER_KEY);
    if (!h) throw new Error('No vault on this device');
    return Vault.fromMaster(await Vault.unwrap(h, passphrase));
  }

  static async changePassphrase(oldPass: string, newPass: string, iter = KDF_ITERATIONS): Promise<void> {
    const h = await idb.get<VaultHeader>('meta', HEADER_KEY);
    if (!h) throw new Error('No vault on this device');
    const master = await Vault.unwrap(h, oldPass);
    const next = await Vault.wrap(master, newPass, iter);
    wipe(master);
    await idb.put('meta', HEADER_KEY, next);
  }

  /** Opaque, deterministic lookup tag for a label (e.g. a contact id). */
  async tag(label: string): Promise<string> {
    return toB64u((await hmac(this.indexKey, utf8(label))).subarray(0, 16));
  }

  async sealBytes(slot: string, data: Uint8Array): Promise<Sealed> {
    const iv = randomBytes(12);
    return { iv, ct: await aesGcmEncrypt(this.recordKey, iv, data, utf8(slot)) };
  }

  async openBytes(slot: string, s: Sealed): Promise<Bytes> {
    return aesGcmDecrypt(this.recordKey, s.iv, s.ct, utf8(slot));
  }

  async putJson(store: idb.StoreName, slot: string, value: unknown): Promise<void> {
    await idb.put(store, slot, await this.sealBytes(`${store}:${slot}`, utf8(JSON.stringify(value))));
  }

  async getJson<T>(store: idb.StoreName, slot: string): Promise<T | undefined> {
    const s = await idb.get<Sealed>(store, slot);
    if (!s) return undefined;
    return JSON.parse(fromUtf8(await this.openBytes(`${store}:${slot}`, s))) as T;
  }

  async listJson<T>(store: idb.StoreName, prefix: string): Promise<[string, T][]> {
    const rows = await idb.entries<Sealed>(store, prefix);
    const out: [string, T][] = [];
    for (const [k, s] of rows) {
      try {
        out.push([k, JSON.parse(fromUtf8(await this.openBytes(`${store}:${k}`, s))) as T]);
      } catch {
        // Corrupted or tampered record - skip rather than crash the app.
      }
    }
    return out;
  }

  /** Decrypts at most `limit` records below `before`, newest first in storage, ascending in the result. */
  async pageJson<T>(store: idb.StoreName, prefix: string, before: string | undefined, limit: number): Promise<[string, T][]> {
    const rows = await idb.pageBefore<Sealed>(store, prefix, before, limit);
    const out: [string, T][] = [];
    for (const [k, s] of rows) {
      try {
        out.push([k, JSON.parse(fromUtf8(await this.openBytes(`${store}:${k}`, s))) as T]);
      } catch {
        /* skip corrupted record */
      }
    }
    return out;
  }

  async putBlob(slot: string, data: Uint8Array): Promise<void> {
    await idb.put('chunks', slot, await this.sealBytes(`chunks:${slot}`, data));
  }

  async getBlob(slot: string): Promise<Bytes | undefined> {
    const s = await idb.get<Sealed>('chunks', slot);
    return s ? this.openBytes(`chunks:${slot}`, s) : undefined;
  }

  /** Forget key material. The CryptoKey becomes unreachable and is garbage collected. */
  lock(): void {
    wipe(this.indexKey);
    this.indexKey = new Uint8Array(0);
  }
}
