import { describe, expect, it } from 'vitest';
import { randomBytes, toB64u } from '../src/crypto/encoding';
import { createInviteSecret, decodeInvite, encodeInvite, openJoin, sealJoin, type InviteV2, type JoinNote } from '../src/net/invite';

async function setup(ttl = 3600_000) {
  const secret = await createInviteSecret(ttl);
  const inv: InviteV2 = {
    v: 2,
    id: toB64u(randomBytes(32)),
    name: 'Alice',
    relay: 'https://relay.example.com',
    sid: 'A'.repeat(22),
    ik: secret.ikPub,
    tok: secret.tok,
    iid: secret.iid,
    exp: secret.exp,
  };
  const note: JoinNote = { t: 'join', iid: inv.iid, tok: inv.tok, id: toB64u(randomBytes(32)), name: 'Bob', reply: { relay: inv.relay, sid: 'B'.repeat(22) }, aid: 'x'.repeat(22), ts: Date.now() };
  return { secret, inv, note };
}

describe('invite links v2', () => {
  it('encodes and decodes, and rejects garbage', async () => {
    const { inv } = await setup();
    const code = await encodeInvite(inv);
    expect(code.startsWith('VEIL2I.')).toBe(true);
    expect(code.length).toBeLessThan(400);
    expect(await decodeInvite(`https://x/app/#${code}`)).toEqual(inv);
    await expect(decodeInvite('VEIL2I.AAAA')).rejects.toThrow();
    await expect(decodeInvite('hello')).rejects.toThrow();
  });

  it('lets only the inviter open a join note and derives a shared channel key', async () => {
    const { secret, inv, note } = await setup();
    const { envelope, chan } = await sealJoin(inv, note);
    const opened = await openJoin(secret, envelope);
    expect(opened?.note.name).toBe('Bob');
    expect(toB64u(opened!.chan)).toBe(toB64u(chan));
    const other = await createInviteSecret(1000);
    expect(await openJoin({ ...other, iid: secret.iid, tok: secret.tok }, envelope)).toBeUndefined();
  });

  it('rejects a wrong token, wrong invite id and tampering', async () => {
    const { secret, inv, note } = await setup();
    const forged = await sealJoin(inv, { ...note, tok: toB64u(randomBytes(16)) });
    expect(await openJoin(secret, forged.envelope)).toBeUndefined();
    const wrongIid = await sealJoin(inv, { ...note, iid: toB64u(randomBytes(16)) });
    expect(await openJoin(secret, wrongIid.envelope)).toBeUndefined();
    const ok = await sealJoin(inv, note);
    const t = new Uint8Array(ok.envelope);
    t[t.length - 1]! ^= 1;
    expect(await openJoin(secret, t)).toBeUndefined();
  });

  it('pads join notes so their size says nothing', async () => {
    const { inv, note } = await setup();
    const a = await sealJoin(inv, note);
    const b = await sealJoin(inv, { ...note, name: 'A much longer display name here' });
    expect(a.envelope.length).toBe(b.envelope.length);
  });
});
