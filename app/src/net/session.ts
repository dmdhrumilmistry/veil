import { ChainError, RecvChain, SendChain, SerialQueue } from '../crypto/chain';
import { concat, fromB64u, fromUtf8, toB64u, utf8 } from '../crypto/encoding';
import { Handshake, type HandshakeMessage, type Role, type SessionKeys } from '../crypto/handshake';
import type { Identity } from '../crypto/identity';
import { maxMessageSize, type PeerLink } from './peer';
import { sdpFingerprint } from './signaling';

/**
 * A live, authenticated, end-to-end encrypted session with one peer.
 *
 * Wire format on both channels after the handshake (binary only):
 *   frame = seq(8) || AES-256-GCM(message key, plaintext)
 * ctrl plaintext = UTF-8 JSON (application messages)
 * bulk plaintext = fileId(16) || chunkIndex(4, BE) || bytes
 *
 * Handshake messages are the only frames allowed before keys exist; they travel as
 * JSON text on ctrl. Any protocol violation closes the connection.
 */

export type AppMessage = { t: string; [k: string]: unknown };

export interface SessionEvents {
  ready(peer: Uint8Array, asyncRoot: Uint8Array): void;
  message(msg: AppMessage): void;
  /** Awaited, so slow storage applies natural backpressure to the sender. */
  chunk(fileId: string, index: number, data: Uint8Array): Promise<void> | void;
  closed(reason: string): void;
  /** Fired when bulk channel drains so blocked senders can continue. */
  drain(): void;
  /** Connection health changed (false = temporarily unusable, e.g. peer vanished). */
  health?(ok: boolean): void;
}

const HANDSHAKE_TIMEOUT_MS = 20_000;
const MAX_CTRL_FRAME = 256 * 1024;
const BULK_HIGH_WATER = 8 * 1024 * 1024;
const BULK_LOW_WATER = 1024 * 1024;
const BULK_HEADER = 20;
const FRAME_OVERHEAD = 8 + 16;

export class Session {
  private hs: Handshake;
  private keys?: SessionKeys;
  private ctrlTx?: SendChain;
  private ctrlRx?: RecvChain;
  private bulkTx?: SendChain;
  private bulkRx?: RecvChain;
  private readonly txQ = new SerialQueue();
  private readonly bulkTxQ = new SerialQueue();
  private readonly rxQ = new SerialQueue();
  private readonly bulkRxQ = new SerialQueue();
  private closedReason?: string;
  private timer?: ReturnType<typeof setTimeout>;
  readonly chunkSize: number;

  constructor(
    readonly link: PeerLink,
    readonly role: Role,
    identity: Identity,
    expectedPeer: Uint8Array | undefined,
    private readonly ev: SessionEvents,
  ) {
    const { pc, ctrl, bulk } = link;
    this.hs = new Handshake({
      role,
      identity,
      localFingerprint: sdpFingerprint(pc.localDescription!.sdp),
      remoteFingerprint: sdpFingerprint(pc.remoteDescription!.sdp),
      expectedPeer,
    });
    this.chunkSize = Math.min(64 * 1024, maxMessageSize(pc)) - BULK_HEADER - FRAME_OVERHEAD;

    ctrl.onmessage = (e) => void this.rxQ.run(() => this.onCtrl(e.data)).catch((err) => this.fail(err));
    bulk.onmessage = (e) => void this.bulkRxQ.run(() => this.onBulk(e.data)).catch((err) => this.fail(err));
    bulk.bufferedAmountLowThreshold = BULK_LOW_WATER;
    bulk.onbufferedamountlow = () => this.ev.drain();
    ctrl.onclose = () => this.close('Connection closed');
    pc.onconnectionstatechange = () => {
      // 'disconnected' arrives within seconds when the other device vanishes (app killed,
      // network gone), long before 'failed'. Stop trusting the channel right away so new
      // messages take the offline path instead of disappearing into a dead connection.
      const was = this.degraded;
      this.degraded = pc.connectionState === 'disconnected';
      if (was !== this.degraded) this.ev.health?.(!this.degraded);
      if (pc.connectionState === 'failed') this.close('Connection lost');
      if (pc.connectionState === 'closed') this.close('Connection closed');
    };

    this.timer = setTimeout(() => this.close('Secure handshake timed out'), HANDSHAKE_TIMEOUT_MS);
    if (ctrl.readyState === 'open') void this.begin();
    else ctrl.onopen = () => void this.begin();
  }

  private degraded = false;

  get isReady(): boolean {
    return !!this.keys && !this.closedReason && !this.degraded;
  }

  get peer(): Uint8Array | undefined {
    return this.keys?.peerIdentity;
  }

  private async begin() {
    if (this.role !== 'initiator') return;
    try {
      this.sendHandshake(await this.hs.start());
    } catch (err) {
      this.fail(err);
    }
  }

  private sendHandshake(m: HandshakeMessage) {
    this.link.ctrl.send(JSON.stringify(m));
  }

  private async onCtrl(data: unknown) {
    if (this.closedReason) return;
    if (!this.keys) {
      if (typeof data !== 'string' || data.length > 16 * 1024) throw new Error('unexpected frame before handshake');
      const { reply, keys } = await this.hs.receive(JSON.parse(data));
      if (reply) this.sendHandshake(reply);
      if (keys) this.activate(keys);
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_CTRL_FRAME) throw new ChainError('invalid frame');
    const plain = await this.ctrlRx!.open(new Uint8Array(data));
    const msg = JSON.parse(fromUtf8(plain)) as AppMessage;
    if (!msg || typeof msg.t !== 'string') throw new Error('invalid message');
    this.ev.message(msg);
  }

  private async onBulk(data: unknown) {
    if (this.closedReason) return;
    if (!this.keys || !(data instanceof ArrayBuffer)) throw new ChainError('invalid bulk frame');
    const plain = await this.bulkRx!.open(new Uint8Array(data));
    if (plain.length < BULK_HEADER) throw new ChainError('short bulk frame');
    const fileId = toB64u(plain.subarray(0, 16));
    const index = new DataView(plain.buffer, plain.byteOffset + 16, 4).getUint32(0);
    await this.ev.chunk(fileId, index, plain.subarray(BULK_HEADER));
  }

  private activate(keys: SessionKeys) {
    clearTimeout(this.timer);
    this.keys = keys;
    this.ctrlTx = new SendChain(keys.ctrlSend, 'veil/v1/ctrl');
    this.ctrlRx = new RecvChain(keys.ctrlRecv, 'veil/v1/ctrl');
    this.bulkTx = new SendChain(keys.bulkSend, 'veil/v1/bulk');
    this.bulkRx = new RecvChain(keys.bulkRecv, 'veil/v1/bulk');
    for (const k of [keys.ctrlSend, keys.ctrlRecv, keys.bulkSend, keys.bulkRecv]) k.fill(0);
    this.ev.ready(keys.peerIdentity, keys.asyncRoot);
  }

  send(msg: AppMessage): Promise<void> {
    return this.txQ.run(async () => {
      if (!this.isReady) throw new Error('not connected');
      const frame = await this.ctrlTx!.seal(utf8(JSON.stringify(msg)));
      this.link.ctrl.send(frame);
    });
  }

  /** True when the bulk channel buffer is full and the caller should wait for `drain`. */
  get congested(): boolean {
    return this.link.bulk.bufferedAmount > BULK_HIGH_WATER;
  }

  sendChunk(fileId: string, index: number, data: Uint8Array): Promise<void> {
    return this.bulkTxQ.run(async () => {
      if (!this.isReady) throw new Error('not connected');
      const header = new Uint8Array(BULK_HEADER);
      header.set(fromB64u(fileId), 0);
      new DataView(header.buffer).setUint32(16, index);
      const frame = await this.bulkTx!.seal(concat(header, data));
      this.link.bulk.send(frame);
    });
  }

  waitForDrain(): Promise<void> {
    if (!this.congested) return Promise.resolve();
    return new Promise((resolve) => {
      const bulk = this.link.bulk;
      const check = () => {
        if (!this.congested || this.closedReason) {
          bulk.removeEventListener('bufferedamountlow', check);
          clearInterval(iv);
          resolve();
        }
      };
      const iv = setInterval(check, 250);
      bulk.addEventListener('bufferedamountlow', check);
    });
  }

  get closed(): string | undefined {
    return this.closedReason;
  }

  private fail(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[veil] session error:', msg);
    this.close(err instanceof ChainError ? 'Security check failed - connection closed' : msg);
  }

  close(reason = 'Disconnected') {
    if (this.closedReason) return;
    this.closedReason = reason;
    clearTimeout(this.timer);
    this.ctrlTx?.destroy();
    this.ctrlRx?.destroy();
    this.bulkTx?.destroy();
    this.bulkRx?.destroy();
    try {
      this.link.ctrl.close();
      this.link.bulk.close();
      this.link.pc.close();
    } catch {
      /* already closed */
    }
    this.ev.closed(reason);
  }
}
