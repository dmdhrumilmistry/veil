import { describe, expect, it } from 'vitest';
import { fromUtf8, randomBytes, utf8 } from '../src/crypto/encoding';
import { MAX_SKIP, Ratchet, RatchetError, generateRatchetKey } from '../src/crypto/ratchet';

async function pair() {
  const sk = randomBytes(32);
  const ad = utf8('alice|bob');
  const bobKey = await generateRatchetKey();
  const alice = await Ratchet.initAlice(sk, bobKey.pub, ad);
  const bob = Ratchet.initBob(sk, bobKey, ad);
  return { alice, bob };
}

const enc = (r: Ratchet, s: string) => r.encrypt(utf8(s));
const dec = async (r: Ratchet, m: Uint8Array) => fromUtf8(await r.decrypt(m));

describe('double ratchet', () => {
  it('exchanges messages in both directions with ratchet steps', async () => {
    const { alice, bob } = await pair();
    expect(bob.canSend).toBe(false);
    expect(await dec(bob, await enc(alice, 'hi bob'))).toBe('hi bob');
    expect(bob.canSend).toBe(true);
    expect(await dec(alice, await enc(bob, 'hi alice'))).toBe('hi alice');
    for (let i = 0; i < 5; i++) {
      expect(await dec(bob, await enc(alice, `a${i}`))).toBe(`a${i}`);
      expect(await dec(alice, await enc(bob, `b${i}`))).toBe(`b${i}`);
    }
  });

  it('handles out-of-order and delayed messages across ratchet steps', async () => {
    const { alice, bob } = await pair();
    const m1 = await enc(alice, 'one');
    const m2 = await enc(alice, 'two');
    const m3 = await enc(alice, 'three');
    expect(await dec(bob, m3)).toBe('three');
    expect(await dec(alice, await enc(bob, 'reply'))).toBe('reply'); // DH step
    const m4 = await enc(alice, 'four');
    expect(await dec(bob, m4)).toBe('four');
    expect(await dec(bob, m1)).toBe('one'); // from the previous chain
    expect(await dec(bob, m2)).toBe('two');
  });

  it('rejects replays and tampering without corrupting state', async () => {
    const { alice, bob } = await pair();
    const m1 = await enc(alice, 'once');
    expect(await dec(bob, m1)).toBe('once');
    await expect(bob.decrypt(m1)).rejects.toBeInstanceOf(RatchetError);
    const m2 = await enc(alice, 'next');
    const bad = new Uint8Array(m2);
    bad[bad.length - 1]! ^= 1;
    await expect(bob.decrypt(bad)).rejects.toBeInstanceOf(RatchetError);
    const hdr = new Uint8Array(m2);
    hdr[39]! ^= 1; // message number is authenticated
    await expect(bob.decrypt(hdr)).rejects.toBeInstanceOf(RatchetError);
    expect(await dec(bob, m2)).toBe('next'); // state untouched by the failures
  });

  it('rejects messages from a different session and bounds skipping', async () => {
    const a = await pair();
    const b = await pair();
    await expect(b.bob.decrypt(await enc(a.alice, 'x'))).rejects.toBeInstanceOf(RatchetError);
    const { alice, bob } = await pair();
    await dec(bob, await enc(alice, 'start'));
    for (let i = 0; i < MAX_SKIP + 1; i++) await enc(alice, 'skip');
    await expect(bob.decrypt(await enc(alice, 'far'))).rejects.toThrow(/skipped/);
  });

  it('survives serialisation (persisted between app launches)', async () => {
    const { alice, bob } = await pair();
    await dec(bob, await enc(alice, 'before'));
    const a2 = Ratchet.fromJSON(JSON.parse(JSON.stringify(alice.toJSON())));
    const b2 = Ratchet.fromJSON(JSON.parse(JSON.stringify(bob.toJSON())));
    expect(await dec(a2, await enc(b2, 'after restart'))).toBe('after restart');
    expect(await dec(b2, await enc(a2, 'still works'))).toBe('still works');
  });
});
