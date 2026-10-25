/**
 * Cross-implementation test vectors (protocol/vectors.json).
 *
 * The web app (TypeScript) is the reference implementation. This file regenerates the
 * vectors with `WRITE_VECTORS=1 npx vitest run test/vectors.test.ts` and otherwise checks
 * that the committed file still matches this implementation. The Dart core
 * (flutter/veil_core) must reproduce every deterministic value byte-for-byte and decrypt
 * every randomized one, so the two apps can never silently drift apart.
 */
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecvChain, SendChain } from '../src/crypto/chain';
import { concat, fromB64u, toB64u, utf8 } from '../src/crypto/encoding';
import { deriveKeyMaterial, transcriptHash } from '../src/crypto/handshake';
import { safetyNumber } from '../src/crypto/identity';
import { aesKey } from '../src/crypto/primitives';
import { generateRatchetKey, Ratchet } from '../src/crypto/ratchet';
import { createInviteSecret, encodeInvite, sealJoin, type InviteV3 } from '../src/net/invite';
import { sealEnvelope } from '../src/net/mailbox';
import { wrapEvent } from '../src/net/nostr';
import { encodeSignal } from '../src/net/signaling';
import { BackupWriter } from '../src/storage/backup';

const FILE = new URL('../../protocol/vectors.json', import.meta.url);
const b = toB64u;
const seq = (n: number, start = 1) => Uint8Array.from({ length: n }, (_, i) => (start + i * 7) & 0xff);

// PKCS#8 wrappers so fixed seeds can be imported into WebCrypto.
const ED_PKCS8 = fromB64u('MC4CAQAwBQYDK2VwBCIEIA');
const X_PKCS8 = fromB64u('MC4CAQAwBQYDK2VuBCIEIA');

async function edFromSeed(seed: Uint8Array) {
  const priv = await crypto.subtle.importKey('pkcs8', concat(ED_PKCS8, seed), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  return { priv, pub: fromB64u(jwk.x!) };
}

async function xFromSeed(seed: Uint8Array) {
  const priv = await crypto.subtle.importKey('pkcs8', concat(X_PKCS8, seed), { name: 'X25519' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  return { priv, pub: fromB64u(jwk.x!) };
}

async function generate() {
  // ML-KEM-768 (FIPS 203): deterministic keygen from d||z and encapsulation with message m.
  const kemSeed = seq(64, 3);
  const kemMsg = seq(32, 99);
  const kem = ml_kem768.keygen(kemSeed);
  const enc = ml_kem768.encapsulate(kem.publicKey, kemMsg);

  // X25519 / Ed25519 (RFC 7748 / 8032 behaviour via WebCrypto).
  const xa = await xFromSeed(seq(32, 11));
  const xb = await xFromSeed(seq(32, 51));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: await crypto.subtle.importKey('raw', xb.pub, { name: 'X25519' }, false, []) }, xa.priv, 256));
  const ed = await edFromSeed(seq(32, 21));
  const edMsg = utf8('veil test vector');
  const edSig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, ed.priv, edMsg));

  // Handshake transcript + key schedule.
  const tI = { id: seq(32, 1), eph: seq(32, 2), kem: kem.publicKey, n: seq(32, 3) };
  const tR = { id: seq(32, 4), eph: seq(32, 5), ct: enc.cipherText, n: seq(32, 6) };
  const fpI = utf8('sha-256 AA:BB:CC');
  const fpR = utf8('sha-256 DD:EE:FF');
  const T = await transcriptHash(fpI, fpR, tI, tR);
  const ss = concat(shared, enc.sharedSecret);
  const okm = await deriveKeyMaterial(new Uint8Array(ss), T);

  // Live KDF chain frames.
  const ck = seq(32, 77);
  const plaintexts = ['hello', '', 'a longer message with unicode: ok'].map(utf8);
  const tx = new SendChain(ck, 'veil/v1/ctrl');
  const frames: string[] = [];
  for (const p of plaintexts) frames.push(b(await tx.seal(p)));

  // Safety numbers.
  const idA = (await edFromSeed(seq(32, 31))).pub;
  const idB = (await edFromSeed(seq(32, 41))).pub;

  // Mailbox envelope (random IV) - Dart must open it.
  const envRaw = seq(32, 61);
  const envelope = await sealEnvelope(await aesKey(envRaw), utf8('envelope payload'));

  // Double Ratchet: Alice -> Bob (3 messages), then Bob -> Alice (2, after a DH step).
  const sk = seq(32, 71);
  const ad = utf8('veil/v1/ratchet/ad|I|R');
  const bobKey = await generateRatchetKey();
  const alice = await Ratchet.initAlice(sk, bobKey.pub, ad);
  const aliceMsgs = ['first', 'second', 'third'];
  const aliceCts: string[] = [];
  for (const m of aliceMsgs) aliceCts.push(b(await alice.encrypt(utf8(m))));
  const aliceAfterSend = alice.toJSON();
  const bobRef = Ratchet.initBob(sk, bobKey, ad);
  for (const c of aliceCts) await bobRef.decrypt(fromB64u(c));
  const bobMsgs = ['reply one', 'reply two'];
  const bobCts: string[] = [];
  for (const m of bobMsgs) bobCts.push(b(await bobRef.encrypt(utf8(m))));

  // Invite v3 + sealed join note.
  const secret = await createInviteSecret(7 * 86_400_000);
  const inv: InviteV3 = { v: 3, id: b(idA), name: 'Alice', mb: 'ab'.repeat(32), rl: ['wss://relay.example.com'], ik: secret.ikPub, tok: secret.tok, iid: secret.iid, exp: 4102444800000 };
  const inviteCode = await encodeInvite(inv);
  const note = { t: 'join' as const, iid: inv.iid, tok: inv.tok, id: b(idB), name: 'Bob', reply: { pk: 'cd'.repeat(32), relays: ['wss://relay.example.com'] }, aid: 'A'.repeat(22), ts: 1700000000000 };
  const join = await sealJoin(inv, note);

  // Nostr gift wrap.
  const event = await wrapEvent('ef'.repeat(32), 'Y2lwaGVydGV4dA', 3600);

  // Manual signaling code (v1 offer).
  const signal = { v: 1 as const, k: 'offer' as const, sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n', id: b(idA), name: 'Alice', ref: 'R'.repeat(22) };
  const signalCode = await encodeSignal(signal);

  // Backup file (low iteration count for test speed; the format records it).
  const bw = await BackupWriter.create('backup passphrase 1!', 100_000);
  const backupFrames = [bw.header, await bw.json('profile', { name: 'Alice' }), await bw.chunk('A'.repeat(22), 0, seq(100, 9)), await bw.end()];

  return {
    version: 1,
    note: 'Generated by app/test/vectors.test.ts (TypeScript reference). Verified by app and flutter/veil_core tests.',
    mlkem768: { seed: b(kemSeed), m: b(kemMsg), pk: b(kem.publicKey), sk: b(kem.secretKey), ct: b(enc.cipherText), ss: b(enc.sharedSecret) },
    x25519: { privA: b(seq(32, 11)), pubA: b(xa.pub), privB: b(seq(32, 51)), pubB: b(xb.pub), shared: b(shared) },
    ed25519: { seed: b(seq(32, 21)), pub: b(ed.pub), msg: b(edMsg), sig: b(edSig) },
    handshake: {
      fpI: b(fpI),
      fpR: b(fpR),
      helloI: { id: b(tI.id), eph: b(tI.eph), kem: b(tI.kem), n: b(tI.n) },
      helloR: { id: b(tR.id), eph: b(tR.eph), ct: b(tR.ct), n: b(tR.n) },
      transcript: b(T),
      ss: b(ss),
      keys: okm.map(b),
    },
    chain: { ck: b(ck), label: 'veil/v1/ctrl', plaintexts: plaintexts.map(b), frames },
    safety: { a: b(idA), b: b(idB), number: safetyNumber(idA, idB) },
    envelope: { key: b(envRaw), plaintext: b(utf8('envelope payload')), envelope: b(envelope) },
    ratchet: {
      sk: b(sk),
      ad: b(ad),
      bob: { pub: b(bobKey.pub), pkcs8: b(bobKey.pkcs8) },
      aliceToBob: aliceCts.map((c, i) => ({ ct: c, pt: aliceMsgs[i] })),
      aliceStateAfterSending: aliceAfterSend,
      bobToAlice: bobCts.map((c, i) => ({ ct: c, pt: bobMsgs[i] })),
    },
    invite: { code: inviteCode, invite: inv, secret, joinEnvelope: b(join.envelope), chan: b(join.chan), note },
    nostr: { event },
    signal: { code: signalCode, decoded: signal },
    backup: { passphrase: 'backup passphrase 1!', file: b(concat(...backupFrames)), profile: { name: 'Alice' }, chunk: { fileId: 'A'.repeat(22), index: 0, data: b(seq(100, 9)) } },
  };
}

describe('cross-implementation vectors', () => {
  it('match the committed protocol/vectors.json', async () => {
    if (process.env.WRITE_VECTORS === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, JSON.stringify(await generate(), null, 2) + '\n');
    }
    const v = JSON.parse(readFileSync(FILE, 'utf8'));

    // Deterministic values must be reproduced exactly.
    const kem = ml_kem768.keygen(fromB64u(v.mlkem768.seed));
    expect(b(kem.publicKey)).toBe(v.mlkem768.pk);
    expect(b(ml_kem768.encapsulate(kem.publicKey, fromB64u(v.mlkem768.m)).cipherText)).toBe(v.mlkem768.ct);
    const h = v.handshake;
    const T = await transcriptHash(fromB64u(h.fpI), fromB64u(h.fpR), {
      id: fromB64u(h.helloI.id), eph: fromB64u(h.helloI.eph), kem: fromB64u(h.helloI.kem), n: fromB64u(h.helloI.n),
    }, { id: fromB64u(h.helloR.id), eph: fromB64u(h.helloR.eph), ct: fromB64u(h.helloR.ct), n: fromB64u(h.helloR.n) });
    expect(b(T)).toBe(h.transcript);
    expect((await deriveKeyMaterial(fromB64u(h.ss), T)).map(b)).toEqual(h.keys);
    const tx = new SendChain(fromB64u(v.chain.ck), v.chain.label);
    for (let i = 0; i < v.chain.frames.length; i++) expect(b(await tx.seal(fromB64u(v.chain.plaintexts[i])))).toBe(v.chain.frames[i]);
    const rx = new RecvChain(fromB64u(v.chain.ck), v.chain.label);
    for (const f of v.chain.frames) await rx.open(fromB64u(f));
    expect(safetyNumber(fromB64u(v.safety.a), fromB64u(v.safety.b))).toBe(v.safety.number);

    // Randomized values must still decrypt with this implementation.
    const bob = Ratchet.initBob(fromB64u(v.ratchet.sk), { pub: fromB64u(v.ratchet.bob.pub), pkcs8: fromB64u(v.ratchet.bob.pkcs8) }, fromB64u(v.ratchet.ad));
    for (const m of v.ratchet.aliceToBob) expect(new TextDecoder().decode(await bob.decrypt(fromB64u(m.ct)))).toBe(m.pt);
    const alice = Ratchet.fromJSON(v.ratchet.aliceStateAfterSending);
    for (const m of v.ratchet.bobToAlice) expect(new TextDecoder().decode(await alice.decrypt(fromB64u(m.ct)))).toBe(m.pt);
  });
});
