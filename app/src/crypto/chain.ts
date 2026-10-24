import { concat, utf8, wipe } from './encoding';
import { aesGcmDecrypt, aesGcmEncrypt, aesKey, hmac, type Bytes } from './primitives';

/**
 * Symmetric KDF chain (Signal "sending/receiving chain" construction).
 *
 *   mk_n   = HMAC(ck_n, 0x01)   one-time message key
 *   ck_n+1 = HMAC(ck_n, 0x02)   next chain key (old one is wiped)
 *
 * Each message is sealed with AES-256-GCM under its own key, so compromising the
 * current state never reveals earlier messages (forward secrecy within a session).
 * WebRTC data channels are reliable + ordered, so receivers demand strict sequence
 * numbers: any gap, replay or reorder is a protocol violation and kills the session.
 */

const MK = new Uint8Array([1]);
const CK = new Uint8Array([2]);
const HEADER = 8; // uint64 sequence number (big-endian)
export const MAX_MESSAGES = 2 ** 48; // far below the GCM per-key bound since keys are single-use

function seqBytes(seq: number): Bytes {
  const b = new Uint8Array(HEADER);
  new DataView(b.buffer).setBigUint64(0, BigInt(seq));
  return b;
}

export class ChainError extends Error {}

class Chain {
  protected ck: Bytes;
  protected seq = 0;
  private readonly label: Bytes;

  constructor(chainKey: Uint8Array, label: string) {
    if (chainKey.length !== 32) throw new Error('chain key must be 32 bytes');
    this.ck = new Uint8Array(chainKey);
    this.label = utf8(label);
  }

  protected async step(): Promise<{ key: CryptoKey; seq: number; aad: Bytes; iv: Bytes }> {
    if (this.seq >= MAX_MESSAGES) throw new ChainError('chain exhausted');
    const mk = await hmac(this.ck, MK);
    const next = await hmac(this.ck, CK);
    wipe(this.ck);
    this.ck = next;
    const key = await aesKey(mk);
    wipe(mk);
    const seq = this.seq++;
    const s = seqBytes(seq);
    // Nonce = 4 zero bytes || seq. Keys are single-use, so nonce reuse is impossible anyway.
    const iv = concat(new Uint8Array(4), s);
    return { key, seq, aad: concat(this.label, s), iv };
  }

  destroy(): void {
    wipe(this.ck);
  }
}

export class SendChain extends Chain {
  async seal(plaintext: Uint8Array): Promise<Bytes> {
    const { key, iv, aad, seq } = await this.step();
    const ct = await aesGcmEncrypt(key, iv, plaintext, aad);
    return concat(seqBytes(seq), ct);
  }
}

export class RecvChain extends Chain {
  async open(frame: Uint8Array): Promise<Bytes> {
    if (frame.length < HEADER + 16) throw new ChainError('frame too short');
    const seq = Number(new DataView(frame.buffer, frame.byteOffset, HEADER).getBigUint64(0));
    if (seq !== this.seq) throw new ChainError(`out-of-order frame: got ${seq}, want ${this.seq}`);
    const { key, iv, aad } = await this.step();
    try {
      return await aesGcmDecrypt(key, iv, frame.subarray(HEADER), aad);
    } catch {
      throw new ChainError('authentication failed');
    }
  }
}

/** Serializes async work so frames are sealed/opened strictly in order. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}
