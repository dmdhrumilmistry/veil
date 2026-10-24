import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { concat, ctEqual, fromB64u, lpConcat, randomBytes, toB64u, utf8, wipe } from './encoding';
import type { Identity } from './identity';
import { ed25519Sign, ed25519Verify, exportRaw, hkdf, sha256, x25519, x25519Generate, type Bytes } from './primitives';

/**
 * Veil handshake v1 - a 1.5 round-trip, mutually authenticated, hybrid post-quantum
 * key exchange run inside the (already DTLS-encrypted) WebRTC data channel.
 *
 *   I -> R  HELLO  { id_I, eph_I, kem_pk_I, nonce_I }
 *   R -> I  HELLO  { id_R, eph_R, kem_ct_R, nonce_R, sig_R }
 *   I -> R  FIN    { sig_I }
 *
 *   T     = SHA-256( lp("veil/v1/handshake", fp_I, fp_R, id_I, eph_I, kem_pk_I, nonce_I,
 *                       id_R, eph_R, kem_ct_R, nonce_R) )
 *   sig_X = Ed25519_X( "veil/v1/sig/" || X || T )
 *   ss    = X25519(eph_I, eph_R) || ML-KEM-768.Decaps(kem_ct_R)
 *   keys  = HKDF-SHA-256(ikm = ss, salt = T, info = "veil/v1/chains", 128 bytes)
 *
 * Properties:
 *   - Confidentiality holds if EITHER X25519 or ML-KEM-768 is unbroken (hybrid).
 *   - Forward secrecy: all key-exchange material is ephemeral and discarded.
 *   - Mutual authentication: each side signs the full transcript with its identity key.
 *   - Channel binding: fp_I/fp_R are the DTLS certificate fingerprints each side observed
 *     in the SDP. A signaling-layer man-in-the-middle who swaps certificates produces
 *     mismatching transcripts, so signatures fail.
 *   - Identity pinning: if an invite carried the peer's identity key, any other key is
 *     rejected before keys are derived.
 */

export const PROTOCOL_VERSION = 1;

export type Role = 'initiator' | 'responder';

export interface SessionKeys {
  ctrlSend: Bytes;
  ctrlRecv: Bytes;
  bulkSend: Bytes;
  bulkRecv: Bytes;
  peerIdentity: Bytes;
  transcript: Bytes;
}

interface HelloI { t: 'hello'; v: number; r: 'I'; id: string; eph: string; kem: string; n: string }
interface HelloR { t: 'hello'; v: number; r: 'R'; id: string; eph: string; ct: string; n: string; sig: string }
interface Fin { t: 'fin'; sig: string }
export type HandshakeMessage = HelloI | HelloR | Fin;

export class HandshakeError extends Error {}

const LABEL = utf8('veil/v1/handshake');
const SIG_I = utf8('veil/v1/sig/I');
const SIG_R = utf8('veil/v1/sig/R');
const INFO = utf8('veil/v1/chains');

function b(s: unknown, len?: number): Bytes {
  if (typeof s !== 'string') throw new HandshakeError('malformed handshake field');
  const out = fromB64u(s);
  if (len !== undefined && out.length !== len) throw new HandshakeError('bad field length');
  return out;
}

export interface HandshakeOptions {
  role: Role;
  identity: Identity;
  /** DTLS fingerprint of our own certificate, as it appears in our local SDP. */
  localFingerprint: string;
  /** DTLS fingerprint of the peer certificate, as it appears in the remote SDP. */
  remoteFingerprint: string;
  /** If known (from an invite or a pinned contact), the only identity key we accept. */
  expectedPeer?: Uint8Array;
}

export class Handshake {
  private readonly o: HandshakeOptions;
  private eph?: CryptoKeyPair;
  private ephPub?: Bytes;
  private kem?: { publicKey: Uint8Array; secretKey: Uint8Array };
  private nonce = randomBytes(32);
  private helloI?: { id: Bytes; eph: Bytes; kem: Bytes; n: Bytes };
  private pending?: { keys: SessionKeys; transcript: Bytes; peer: Bytes };
  private done = false;

  constructor(opts: HandshakeOptions) {
    this.o = opts;
  }

  private fps(): [Bytes, Bytes] {
    const local = utf8(this.o.localFingerprint.toLowerCase());
    const remote = utf8(this.o.remoteFingerprint.toLowerCase());
    return this.o.role === 'initiator' ? [local, remote] : [remote, local];
  }

  private checkPeer(id: Uint8Array): void {
    if (ctEqual(id, this.o.identity.pub)) throw new HandshakeError('peer presented our own identity');
    if (this.o.expectedPeer && !ctEqual(id, this.o.expectedPeer)) {
      throw new HandshakeError('peer identity does not match the invite - possible interception');
    }
  }

  private async initEphemeral(): Promise<void> {
    this.eph = await x25519Generate();
    this.ephPub = await exportRaw(this.eph.publicKey);
  }

  /** Initiator: produce the first message. */
  async start(): Promise<HelloI> {
    if (this.o.role !== 'initiator') throw new HandshakeError('only the initiator starts');
    await this.initEphemeral();
    this.kem = ml_kem768.keygen();
    return {
      t: 'hello',
      v: PROTOCOL_VERSION,
      r: 'I',
      id: toB64u(this.o.identity.pub),
      eph: toB64u(this.ephPub!),
      kem: toB64u(this.kem.publicKey),
      n: toB64u(this.nonce),
    };
  }

  /**
   * Feed a message from the peer. Returns a reply to send (if any) and, once the
   * handshake is complete on this side, the derived session keys.
   */
  async receive(msg: unknown): Promise<{ reply?: HandshakeMessage; keys?: SessionKeys }> {
    if (this.done) throw new HandshakeError('handshake already complete');
    if (!msg || typeof msg !== 'object') throw new HandshakeError('malformed message');
    const m = msg as Record<string, unknown>;
    if (m.t === 'hello' && m.v !== PROTOCOL_VERSION) throw new HandshakeError(`unsupported protocol version ${String(m.v)}`);

    if (this.o.role === 'responder' && m.t === 'hello' && m.r === 'I' && !this.helloI) {
      return this.onHelloI(m);
    }
    if (this.o.role === 'initiator' && m.t === 'hello' && m.r === 'R' && this.kem && !this.pending) {
      return this.onHelloR(m);
    }
    if (this.o.role === 'responder' && m.t === 'fin' && this.pending) {
      return this.onFin(m);
    }
    throw new HandshakeError('unexpected handshake message');
  }

  private async transcript(i: { id: Bytes; eph: Bytes; kem: Bytes; n: Bytes }, r: { id: Bytes; eph: Bytes; ct: Bytes; n: Bytes }): Promise<Bytes> {
    const [fpI, fpR] = this.fps();
    return sha256(lpConcat(LABEL, fpI, fpR, i.id, i.eph, i.kem, i.n, r.id, r.eph, r.ct, r.n));
  }

  private async derive(ss: Bytes, transcript: Bytes, peer: Bytes): Promise<SessionKeys> {
    const okm = await hkdf(ss, transcript, INFO, 128);
    wipe(ss);
    const k = (i: number) => okm.slice(i * 32, (i + 1) * 32);
    const [ctrlI2R, ctrlR2I, bulkI2R, bulkR2I] = [k(0), k(1), k(2), k(3)];
    wipe(okm);
    const initiator = this.o.role === 'initiator';
    return {
      ctrlSend: initiator ? ctrlI2R : ctrlR2I,
      ctrlRecv: initiator ? ctrlR2I : ctrlI2R,
      bulkSend: initiator ? bulkI2R : bulkR2I,
      bulkRecv: initiator ? bulkR2I : bulkI2R,
      peerIdentity: peer,
      transcript,
    };
  }

  private async onHelloI(m: Record<string, unknown>) {
    const i = { id: b(m.id, 32), eph: b(m.eph, 32), kem: b(m.kem, 1184), n: b(m.n, 32) };
    this.checkPeer(i.id);
    this.helloI = i;
    await this.initEphemeral();

    let enc: { cipherText: Uint8Array; sharedSecret: Uint8Array };
    try {
      enc = ml_kem768.encapsulate(i.kem);
    } catch {
      throw new HandshakeError('invalid ML-KEM public key');
    }
    const dh = await x25519(this.eph!.privateKey, i.eph);
    const r = { id: this.o.identity.pub, eph: this.ephPub!, ct: new Uint8Array(enc.cipherText), n: this.nonce };
    const transcript = await this.transcript(i, r);
    const sig = await ed25519Sign(this.o.identity.priv, concat(SIG_R, transcript));
    const keys = await this.derive(concat(dh, enc.sharedSecret), transcript, i.id);
    wipe(dh, enc.sharedSecret);
    // Keys stay pending until the initiator proves possession of its identity key.
    this.pending = { keys, transcript, peer: i.id };
    const reply: HelloR = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      r: 'R',
      id: toB64u(r.id),
      eph: toB64u(r.eph),
      ct: toB64u(r.ct),
      n: toB64u(r.n),
      sig: toB64u(sig),
    };
    return { reply };
  }

  private async onHelloR(m: Record<string, unknown>) {
    const r = { id: b(m.id, 32), eph: b(m.eph, 32), ct: b(m.ct, 1088), n: b(m.n, 32) };
    const sigR = b(m.sig, 64);
    this.checkPeer(r.id);
    const i = { id: this.o.identity.pub, eph: this.ephPub!, kem: new Uint8Array(this.kem!.publicKey), n: this.nonce };
    const transcript = await this.transcript(i, r);
    if (!(await ed25519Verify(r.id, sigR, concat(SIG_R, transcript)))) {
      throw new HandshakeError('responder signature invalid - connection may be intercepted');
    }
    const kemSs = ml_kem768.decapsulate(r.ct, this.kem!.secretKey);
    wipe(this.kem!.secretKey);
    const dh = await x25519(this.eph!.privateKey, r.eph);
    const keys = await this.derive(concat(dh, kemSs), transcript, r.id);
    wipe(dh, kemSs);
    const sig = await ed25519Sign(this.o.identity.priv, concat(SIG_I, transcript));
    this.done = true;
    this.pending = { keys, transcript, peer: r.id };
    return { reply: { t: 'fin', sig: toB64u(sig) } as Fin, keys };
  }

  private async onFin(m: Record<string, unknown>) {
    const sig = b(m.sig, 64);
    const { keys, transcript, peer } = this.pending!;
    if (!(await ed25519Verify(peer, sig, concat(SIG_I, transcript)))) {
      throw new HandshakeError('initiator signature invalid - connection may be intercepted');
    }
    this.done = true;
    return { keys };
  }
}
