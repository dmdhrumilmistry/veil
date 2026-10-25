import { concat, fromB64u, toB64u, utf8, wipe } from './encoding';
import { aesGcmDecrypt, aesGcmEncrypt, aesKey, hkdf, hmac, x25519, type Bytes } from './primitives';

/**
 * Double Ratchet (Signal specification, https://signal.org/docs/specifications/doubleratchet/)
 * for asynchronous (offline) messages.
 *
 *   KDF_RK(rk, dh) = HKDF-SHA-256(salt = rk, ikm = dh, info = "veil/v1/ratchet/rk") -> rk', ck
 *   KDF_CK(ck)     = HMAC(ck, 0x01) -> mk,  HMAC(ck, 0x02) -> ck'
 *   ENCRYPT(mk)    = HKDF(mk, info = "veil/v1/ratchet/mk") -> AES-256-GCM key || 96-bit nonce
 *   header         = dh_pub(32) || pn(u32) || n(u32), authenticated as associated data
 *
 * The shared secret SK comes from the live hybrid X25519 + ML-KEM-768 handshake, so the
 * root chain starts post-quantum secure: recorded traffic stays protected even if X25519
 * is broken later. DH ratchet steps then add break-in recovery on every round trip.
 *
 * All state transitions are computed on a copy and only committed after a message
 * authenticates, so forged or corrupted messages can never damage the session.
 */

export const MAX_SKIP = 1000;
const MAX_STORED_SKIPPED = 2000;
const HEADER_LEN = 40;
const RK_INFO = utf8('veil/v1/ratchet/rk');
const MK_INFO = utf8('veil/v1/ratchet/mk');

export interface DhKeyPair {
  pub: Bytes;
  pkcs8: Bytes;
}

export interface RatchetJSON {
  v: 1;
  dhs: { pub: string; pkcs8: string };
  dhr?: string;
  rk: string;
  cks?: string;
  ckr?: string;
  ns: number;
  nr: number;
  pn: number;
  skipped: [string, string][];
  ad: string;
}

export class RatchetError extends Error {}

export async function generateRatchetKey(): Promise<DhKeyPair> {
  const kp = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    pub: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)),
    pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)),
  };
}

async function dh(pair: DhKeyPair, pub: Uint8Array): Promise<Bytes> {
  const priv = await crypto.subtle.importKey('pkcs8', pair.pkcs8 as BufferSource, { name: 'X25519' }, false, ['deriveBits']);
  return x25519(priv, pub);
}

async function kdfRk(rk: Uint8Array, dhOut: Uint8Array): Promise<[Bytes, Bytes]> {
  const out = await hkdf(dhOut, rk, RK_INFO, 64);
  const res: [Bytes, Bytes] = [out.slice(0, 32), out.slice(32)];
  wipe(out, dhOut);
  return res;
}

async function kdfCk(ck: Uint8Array): Promise<[Bytes, Bytes]> {
  return [await hmac(ck, new Uint8Array([1])), await hmac(ck, new Uint8Array([2]))];
}

async function messageKey(mk: Uint8Array): Promise<{ key: CryptoKey; iv: Bytes }> {
  const out = await hkdf(mk, new Uint8Array(32), MK_INFO, 44);
  const key = await aesKey(out.slice(0, 32));
  const iv = out.slice(32);
  wipe(out);
  return { key, iv };
}

function header(pub: Uint8Array, pn: number, n: number): Bytes {
  const h = new Uint8Array(HEADER_LEN);
  h.set(pub, 0);
  const v = new DataView(h.buffer);
  v.setUint32(32, pn);
  v.setUint32(36, n);
  return h;
}

function parseHeader(h: Uint8Array) {
  const v = new DataView(h.buffer, h.byteOffset, HEADER_LEN);
  return { pub: h.slice(0, 32), pn: v.getUint32(32), n: v.getUint32(36) };
}

const skKey = (pub: Uint8Array, n: number) => `${toB64u(pub)}:${n}`;
const eq = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

interface State {
  dhs: DhKeyPair;
  dhr?: Bytes;
  rk: Bytes;
  cks?: Bytes;
  ckr?: Bytes;
  ns: number;
  nr: number;
  pn: number;
  skipped: Map<string, Bytes>;
  ad: Bytes;
}

export class Ratchet {
  private constructor(private s: State) {}

  /** Initiator side: knows the responder's ratchet public key. */
  static async initAlice(sk: Uint8Array, bobPub: Uint8Array, ad: Uint8Array): Promise<Ratchet> {
    const dhs = await generateRatchetKey();
    const [rk, cks] = await kdfRk(sk, await dh(dhs, bobPub));
    return new Ratchet({ dhs, dhr: new Uint8Array(bobPub), rk, cks, ns: 0, nr: 0, pn: 0, skipped: new Map(), ad: new Uint8Array(ad) });
  }

  /** Responder side: owns the key pair whose public half it sent to the initiator. */
  static initBob(sk: Uint8Array, bobPair: DhKeyPair, ad: Uint8Array): Ratchet {
    return new Ratchet({ dhs: bobPair, rk: new Uint8Array(sk), ns: 0, nr: 0, pn: 0, skipped: new Map(), ad: new Uint8Array(ad) });
  }

  get canSend(): boolean {
    return !!this.s.cks;
  }

  async encrypt(plaintext: Uint8Array): Promise<Bytes> {
    const s = this.s;
    if (!s.cks) throw new RatchetError('sending chain not initialised');
    const [mk, ck] = await kdfCk(s.cks);
    wipe(s.cks);
    s.cks = ck;
    const h = header(s.dhs.pub, s.pn, s.ns);
    s.ns++;
    const { key, iv } = await messageKey(mk);
    wipe(mk);
    return concat(h, await aesGcmEncrypt(key, iv, plaintext, concat(s.ad, h)));
  }

  async decrypt(message: Uint8Array): Promise<Bytes> {
    if (message.length < HEADER_LEN + 16) throw new RatchetError('message too short');
    const h = message.subarray(0, HEADER_LEN);
    const ct = message.subarray(HEADER_LEN);
    const { pub, pn, n } = parseHeader(h);
    // Work on a copy; commit only after successful authentication.
    const s = this.clone();
    const ad = concat(s.ad, h);

    const skipped = s.skipped.get(skKey(pub, n));
    if (skipped) {
      const plain = await this.open(skipped, ct, ad);
      s.skipped.delete(skKey(pub, n));
      this.s = s;
      return plain;
    }

    if (!eq(pub, s.dhr)) {
      await this.skip(s, pn);
      // DH ratchet step.
      s.pn = s.ns;
      s.ns = 0;
      s.nr = 0;
      s.dhr = pub;
      [s.rk, s.ckr] = await kdfRk(s.rk, await dh(s.dhs, s.dhr));
      s.dhs = await generateRatchetKey();
      [s.rk, s.cks] = await kdfRk(s.rk, await dh(s.dhs, s.dhr));
    }
    await this.skip(s, n);
    if (!s.ckr) throw new RatchetError('no receiving chain');
    const [mk, ck] = await kdfCk(s.ckr);
    s.ckr = ck;
    s.nr++;
    const plain = await this.open(mk, ct, ad);
    this.s = s;
    return plain;
  }

  private async open(mk: Uint8Array, ct: Uint8Array, ad: Uint8Array): Promise<Bytes> {
    const { key, iv } = await messageKey(mk);
    try {
      return await aesGcmDecrypt(key, iv, ct, ad);
    } catch {
      throw new RatchetError('message failed authentication');
    }
  }

  private async skip(s: State, until: number) {
    if (!s.ckr) return;
    if (until < s.nr) return; // duplicate / old message: handled by skipped lookup or rejected later
    if (until - s.nr > MAX_SKIP) throw new RatchetError('too many skipped messages');
    while (s.nr < until) {
      const [mk, ck] = await kdfCk(s.ckr);
      s.skipped.set(skKey(s.dhr!, s.nr), mk);
      s.ckr = ck;
      s.nr++;
    }
    // Bound memory: drop the oldest skipped keys.
    while (s.skipped.size > MAX_STORED_SKIPPED) s.skipped.delete(s.skipped.keys().next().value!);
  }

  private clone(): State {
    const s = this.s;
    const c = (b?: Uint8Array) => (b ? new Uint8Array(b) : undefined);
    return {
      dhs: { pub: new Uint8Array(s.dhs.pub), pkcs8: new Uint8Array(s.dhs.pkcs8) },
      dhr: c(s.dhr),
      rk: new Uint8Array(s.rk),
      cks: c(s.cks),
      ckr: c(s.ckr),
      ns: s.ns,
      nr: s.nr,
      pn: s.pn,
      skipped: new Map(s.skipped),
      ad: s.ad,
    };
  }

  toJSON(): RatchetJSON {
    const s = this.s;
    const b = (x?: Uint8Array) => (x ? toB64u(x) : undefined);
    return {
      v: 1,
      dhs: { pub: toB64u(s.dhs.pub), pkcs8: toB64u(s.dhs.pkcs8) },
      dhr: b(s.dhr),
      rk: toB64u(s.rk),
      cks: b(s.cks),
      ckr: b(s.ckr),
      ns: s.ns,
      nr: s.nr,
      pn: s.pn,
      skipped: [...s.skipped].map(([k, v]) => [k, toB64u(v)]),
      ad: toB64u(s.ad),
    };
  }

  static fromJSON(j: RatchetJSON): Ratchet {
    if (j?.v !== 1) throw new RatchetError('unsupported ratchet state');
    const b = (x?: string) => (x ? fromB64u(x) : undefined);
    return new Ratchet({
      dhs: { pub: fromB64u(j.dhs.pub), pkcs8: fromB64u(j.dhs.pkcs8) },
      dhr: b(j.dhr),
      rk: fromB64u(j.rk),
      cks: b(j.cks),
      ckr: b(j.ckr),
      ns: j.ns,
      nr: j.nr,
      pn: j.pn,
      skipped: new Map(j.skipped.map(([k, v]) => [k, fromB64u(v)])),
      ad: fromB64u(j.ad),
    });
  }
}
