import { describe, expect, it } from 'vitest';
import { RecvChain, SendChain, ChainError } from '../src/crypto/chain';
import { fromB64u, randomBytes, toB64u, utf8, fromUtf8 } from '../src/crypto/encoding';
import { Handshake, HandshakeError, type HandshakeMessage } from '../src/crypto/handshake';
import { generateIdentity, safetyNumber } from '../src/crypto/identity';

const FP_I = 'sha-256 AA:BB';
const FP_R = 'sha-256 CC:DD';

async function pair(opts: { rExpect?: Uint8Array; iExpect?: Uint8Array; rFps?: [string, string] } = {}) {
  const a = (await generateIdentity()).identity;
  const b = (await generateIdentity()).identity;
  const I = new Handshake({ role: 'initiator', identity: a, localFingerprint: FP_I, remoteFingerprint: FP_R, expectedPeer: opts.iExpect });
  const [rl, rr] = opts.rFps ?? [FP_R, FP_I];
  const R = new Handshake({ role: 'responder', identity: b, localFingerprint: rl, remoteFingerprint: rr, expectedPeer: opts.rExpect });
  return { a, b, I, R };
}

// Round-trip through JSON like the wire does.
const wire = (m: HandshakeMessage | undefined) => JSON.parse(JSON.stringify(m));

describe('handshake', () => {
  it('derives matching, crossed keys for both sides', async () => {
    const { a, b, I, R } = await pair();
    const hello = await I.start();
    const r1 = await R.receive(wire(hello));
    expect(r1.keys).toBeUndefined();
    const r2 = await I.receive(wire(r1.reply));
    const r3 = await R.receive(wire(r2.reply));
    const ki = r2.keys!;
    const kr = r3.keys!;
    expect(toB64u(ki.ctrlSend)).toBe(toB64u(kr.ctrlRecv));
    expect(toB64u(ki.ctrlRecv)).toBe(toB64u(kr.ctrlSend));
    expect(toB64u(ki.bulkSend)).toBe(toB64u(kr.bulkRecv));
    expect(toB64u(ki.ctrlSend)).not.toBe(toB64u(ki.ctrlRecv));
    expect(toB64u(ki.peerIdentity)).toBe(toB64u(b.pub));
    expect(toB64u(kr.peerIdentity)).toBe(toB64u(a.pub));
  });

  it('fails when DTLS fingerprints differ (signaling MITM)', async () => {
    const { I, R } = await pair({ rFps: [FP_R, 'sha-256 EE:FF'] });
    const r1 = await R.receive(wire(await I.start()));
    await expect(I.receive(wire(r1.reply))).rejects.toBeInstanceOf(HandshakeError);
  });

  it('rejects a peer that does not match the pinned invite identity', async () => {
    const other = (await generateIdentity()).identity;
    const { I, R } = await pair({ rExpect: other.pub });
    await expect(R.receive(wire(await I.start()))).rejects.toThrow(/does not match/);
  });

  it('accepts a peer matching the pinned identity', async () => {
    const { a, b, I, R } = await pair();
    const I2 = new Handshake({ role: 'initiator', identity: a, localFingerprint: FP_I, remoteFingerprint: FP_R, expectedPeer: b.pub });
    const R2 = new Handshake({ role: 'responder', identity: b, localFingerprint: FP_R, remoteFingerprint: FP_I, expectedPeer: a.pub });
    void I; void R;
    const r1 = await R2.receive(wire(await I2.start()));
    const r2 = await I2.receive(wire(r1.reply));
    expect((await R2.receive(wire(r2.reply))).keys).toBeDefined();
  });

  it('rejects a tampered responder hello', async () => {
    const { I, R } = await pair();
    const r1 = wire((await R.receive(wire(await I.start()))).reply);
    const n = fromB64u(r1.n);
    n[0]! ^= 1;
    r1.n = toB64u(n);
    await expect(I.receive(r1)).rejects.toThrow(/signature invalid/);
  });

  it('rejects a forged FIN', async () => {
    const { I, R } = await pair();
    const r1 = await R.receive(wire(await I.start()));
    await I.receive(wire(r1.reply));
    await expect(R.receive({ t: 'fin', sig: toB64u(randomBytes(64)) })).rejects.toThrow(/signature invalid/);
  });

  it('rejects wrong protocol versions and junk', async () => {
    const { I, R } = await pair();
    const hello = wire(await I.start());
    await expect(R.receive({ ...hello, v: 2 })).rejects.toThrow(/version/);
    await expect(R.receive({ t: 'fin', sig: 'x' })).rejects.toBeInstanceOf(HandshakeError);
    await expect(R.receive(null)).rejects.toBeInstanceOf(HandshakeError);
    await expect(R.receive({ ...hello, kem: toB64u(randomBytes(10)) })).rejects.toThrow(/length/);
  });
});

describe('KDF chain', () => {
  const ck = randomBytes(32);

  it('round-trips in order and every frame differs', async () => {
    const s = new SendChain(ck, 'ctrl');
    const r = new RecvChain(ck, 'ctrl');
    const f1 = await s.seal(utf8('hello'));
    const f2 = await s.seal(utf8('hello'));
    expect(toB64u(f1)).not.toBe(toB64u(f2));
    expect(fromUtf8(await r.open(f1))).toBe('hello');
    expect(fromUtf8(await r.open(f2))).toBe('hello');
  });

  it('rejects replay, reorder, tamper and cross-channel frames', async () => {
    const s = new SendChain(ck, 'ctrl');
    const f1 = await s.seal(utf8('a'));
    const f2 = await s.seal(utf8('b'));

    const r1 = new RecvChain(ck, 'ctrl');
    await expect(r1.open(f2)).rejects.toBeInstanceOf(ChainError);

    const r2 = new RecvChain(ck, 'ctrl');
    await r2.open(f1);
    await expect(r2.open(f1)).rejects.toBeInstanceOf(ChainError);

    const t = new Uint8Array(f1);
    t[t.length - 1]! ^= 1;
    await expect(new RecvChain(ck, 'ctrl').open(t)).rejects.toThrow(/authentication/);

    await expect(new RecvChain(ck, 'bulk').open(f1)).rejects.toThrow(/authentication/);
  });
});

describe('safety numbers', () => {
  it('are 60 digits and symmetric', async () => {
    const a = (await generateIdentity()).identity.pub;
    const b = (await generateIdentity()).identity.pub;
    const n = safetyNumber(a, b);
    expect(n).toMatch(/^\d{60}$/);
    expect(safetyNumber(b, a)).toBe(n);
    const c = (await generateIdentity()).identity.pub;
    expect(safetyNumber(a, c)).not.toBe(n);
  });
});
