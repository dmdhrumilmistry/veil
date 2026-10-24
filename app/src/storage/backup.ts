import { concat, fromB64u, fromUtf8, randomBytes, toB64u, utf8, wipe } from '../crypto/encoding';
import { aesGcmDecrypt, aesGcmEncrypt, aesKey, hkdf, pbkdf2, sha256, type Bytes } from '../crypto/primitives';

/**
 * Encrypted backup file format (".veilbackup"), version 1.
 *
 *   file    = MAGIC(8) || u32 headerLen || header(JSON) || record*
 *   header  = { v: 1, kdf: "PBKDF2-SHA-256", iter, salt }
 *   key     = HKDF-SHA-256(ikm = PBKDF2(passphrase, salt, iter),
 *                          salt = SHA-256(MAGIC || headerLen || header), info = "veil/backup/v1")
 *   record  = u32 len || iv(12) || AES-256-GCM(key, iv, plaintext, aad = u64 index || final(1))
 *   plaintext = type(1) || payload
 *     0x01 JSON entry   { k, d }
 *     0x02 file chunk   fileId(16) || u32 index || bytes
 *     0xFF end          { records }   (the only record with final = 1)
 *
 * Binding the header into the key means any header edit yields a wrong key. Record
 * indexes and the final flag in the AAD stop reordering, splicing and truncation: a
 * valid file must end with exactly one authenticated end record.
 */

const MAGIC = utf8('VEILBAK\x01');
const INFO = utf8('veil/backup/v1');
export const BACKUP_ITERATIONS = 600_000;
const MAX_RECORD = 4 * 1024 * 1024;
const T_JSON = 0x01;
const T_CHUNK = 0x02;
const T_END = 0xff;

export type BackupErrorCode = 'not-a-backup' | 'unsupported' | 'wrong-passphrase' | 'corrupt' | 'truncated';

export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode) {
    super(
      {
        'not-a-backup': 'This file is not a Veil backup',
        unsupported: 'This backup was made by a newer version of Veil',
        'wrong-passphrase': 'Incorrect backup passphrase',
        corrupt: 'This backup is damaged or has been tampered with',
        truncated: 'This backup is incomplete - it may not have finished saving',
      }[code],
    );
  }
}

export type BackupEntry =
  | { type: 'json'; k: string; d: unknown }
  | { type: 'chunk'; fileId: string; index: number; data: Bytes };

function u32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function aad(index: number, final: boolean): Bytes {
  const b = new Uint8Array(9);
  new DataView(b.buffer).setBigUint64(0, BigInt(index));
  b[8] = final ? 1 : 0;
  return b;
}

async function deriveKey(passphrase: string, header: Bytes, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const kek = await pbkdf2(passphrase, salt, iter);
  const raw = await hkdf(kek, await sha256(header), INFO, 32);
  wipe(kek);
  const key = await aesKey(raw);
  wipe(raw);
  return key;
}

/** Produces the byte frames of a backup. The caller streams them to a file. */
export class BackupWriter {
  private index = 0;
  private ended = false;

  private constructor(
    private readonly key: CryptoKey,
    readonly header: Bytes,
  ) {}

  static async create(passphrase: string, iter = BACKUP_ITERATIONS): Promise<BackupWriter> {
    const salt = randomBytes(16);
    const json = utf8(JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA-256', iter, salt: toB64u(salt) }));
    const header = concat(MAGIC, u32(json.length), json);
    return new BackupWriter(await deriveKey(passphrase, header, salt, iter), header);
  }

  private async record(plain: Uint8Array, final = false): Promise<Bytes> {
    if (this.ended) throw new Error('backup already finished');
    const iv = randomBytes(12);
    const ct = await aesGcmEncrypt(this.key, iv, plain, aad(this.index++, final));
    return concat(u32(iv.length + ct.length), iv, ct);
  }

  json(k: string, d: unknown): Promise<Bytes> {
    return this.record(concat(new Uint8Array([T_JSON]), utf8(JSON.stringify({ k, d }))));
  }

  chunk(fileId: string, index: number, data: Uint8Array): Promise<Bytes> {
    return this.record(concat(new Uint8Array([T_CHUNK]), fromB64u(fileId), u32(index), data));
  }

  async end(): Promise<Bytes> {
    const frame = await this.record(concat(new Uint8Array([T_END]), utf8(JSON.stringify({ records: this.index }))), true);
    this.ended = true;
    return frame;
  }
}

function parseJson(b: Uint8Array): Record<string, unknown> {
  try {
    const v = JSON.parse(fromUtf8(b));
    if (v && typeof v === 'object') return v;
  } catch {
    /* fall through */
  }
  throw new BackupError('corrupt');
}

async function read(blob: Blob, off: number, len: number): Promise<Bytes> {
  return new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
}

/**
 * Streams and authenticates every entry in a backup. Throws BackupError on any problem;
 * consumers must not commit anything until the generator has completed successfully
 * (or must roll back if it throws).
 */
export async function* readBackup(blob: Blob, passphrase: string, onProgress?: (done: number, total: number) => void): AsyncGenerator<BackupEntry> {
  const head = await read(blob, 0, MAGIC.length + 4);
  if (head.length < MAGIC.length + 4 || !MAGIC.every((b, i) => head[i] === b)) throw new BackupError('not-a-backup');
  const hlen = new DataView(head.buffer).getUint32(MAGIC.length);
  if (hlen > 4096) throw new BackupError('not-a-backup');
  const hjson = await read(blob, head.length, hlen);
  let h: { v?: unknown; kdf?: unknown; iter?: unknown; salt?: unknown };
  try {
    h = JSON.parse(fromUtf8(hjson));
  } catch {
    throw new BackupError('not-a-backup');
  }
  if (h.v !== 1 || h.kdf !== 'PBKDF2-SHA-256') throw new BackupError('unsupported');
  if (typeof h.iter !== 'number' || h.iter < 100_000 || h.iter > 10_000_000 || typeof h.salt !== 'string') throw new BackupError('corrupt');
  const header = concat(head, hjson);
  let salt: Bytes;
  try {
    salt = fromB64u(h.salt);
  } catch {
    throw new BackupError('corrupt');
  }
  if (salt.length !== 16) throw new BackupError('corrupt');
  const key = await deriveKey(passphrase, header, salt, h.iter);

  let off = header.length;
  let index = 0;
  for (;;) {
    if (off + 4 > blob.size) throw new BackupError('truncated');
    const len = new DataView((await read(blob, off, 4)).buffer).getUint32(0);
    if (len < 12 + 16 + 1 || len > MAX_RECORD) throw new BackupError('corrupt');
    if (off + 4 + len > blob.size) throw new BackupError('truncated');
    const rec = await read(blob, off + 4, len);
    off += 4 + len;

    // The end record is the only one authenticated with final = 1.
    let plain: Bytes | undefined;
    let final = false;
    for (const f of [false, true]) {
      try {
        plain = await aesGcmDecrypt(key, rec.subarray(0, 12), rec.subarray(12), aad(index, f));
        final = f;
        break;
      } catch {
        /* try the other flag */
      }
    }
    if (!plain) throw new BackupError(index === 0 ? 'wrong-passphrase' : 'corrupt');
    index++;
    onProgress?.(off, blob.size);

    const type = plain[0];
    const body = plain.subarray(1);
    if (final) {
      if (type !== T_END) throw new BackupError('corrupt');
      const { records } = parseJson(body) as { records: number };
      if (records !== index - 1 || off !== blob.size) throw new BackupError('corrupt');
      return;
    }
    if (type === T_JSON) {
      const { k, d } = parseJson(body) as { k: string; d: unknown };
      if (typeof k !== 'string') throw new BackupError('corrupt');
      yield { type: 'json', k, d };
    } else if (type === T_CHUNK) {
      if (body.length < 20) throw new BackupError('corrupt');
      yield {
        type: 'chunk',
        fileId: toB64u(body.subarray(0, 16)),
        index: new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0),
        data: body.slice(20),
      };
    } else {
      throw new BackupError('corrupt');
    }
  }
}
