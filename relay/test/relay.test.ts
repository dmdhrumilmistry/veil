import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { allowedPushEndpoint, startRelay } from '../src/server.ts';

const subtle = globalThis.crypto.subtle;
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

let base = '';
let relay: Awaited<ReturnType<typeof startRelay>>;
let dir = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veil-relay-'));
  relay = await startRelay({ port: 0, dataDir: dir, maxQueueMessages: 5 });
  base = `http://127.0.0.1:${relay.port}`;
});
after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

async function owner() {
  const kp = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const res = await fetch(`${base}/v1/queues`, { method: 'POST', body: JSON.stringify({ key: b64u(pub) }) });
  assert.equal(res.status, 201);
  const { rid, sid } = (await res.json()) as { rid: string; sid: string };
  const signed = async (method: string, path: string, body = '', key = kp.privateKey, ts = Date.now()) => {
    const digest = Buffer.from(await subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('hex');
    const sig = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(`veil-relay/v1\n${method}\n${path}\n${ts}\n${digest}`)));
    return fetch(`${base}${path}`, { method, body: body || undefined, headers: { 'Veil-Auth': `${ts}.${b64u(sig)}` } });
  };
  return { rid, sid, signed };
}

const blob = (n = 64, fill = 7) => new Uint8Array(n).fill(fill);

describe('veil relay', () => {
  it('reports its info and VAPID key', async () => {
    const info = (await (await fetch(`${base}/v1/info`)).json()) as { service: string; vapid: string };
    assert.equal(info.service, 'veil-relay');
    assert.equal(Buffer.from(info.vapid, 'base64url').length, 65);
  });

  it('stores, lists and acks messages for the owner only', async () => {
    const o = await owner();
    assert.notEqual(o.rid, o.sid);
    assert.equal((await fetch(`${base}/v1/send/${o.sid}`, { method: 'POST', body: blob(64, 1) })).status, 202);
    assert.equal((await fetch(`${base}/v1/send/${o.sid}`, { method: 'POST', body: blob(64, 2) })).status, 202);

    const list = (await (await o.signed('GET', `/v1/recv/${o.rid}`)).json()) as { messages: { id: number; body: string }[] };
    assert.equal(list.messages.length, 2);
    assert.deepEqual(Buffer.from(list.messages[1]!.body, 'base64url'), Buffer.from(blob(64, 2)));

    assert.equal((await o.signed('POST', `/v1/recv/${o.rid}/ack`, JSON.stringify({ upTo: list.messages[0]!.id }))).status, 204);
    const rest = (await (await o.signed('GET', `/v1/recv/${o.rid}`)).json()) as { messages: unknown[] };
    assert.equal(rest.messages.length, 1);
  });

  it('rejects unsigned, wrongly signed, stale and cross-queue owner requests', async () => {
    const a = await owner();
    const b = await owner();
    assert.equal((await fetch(`${base}/v1/recv/${a.rid}`)).status, 401);
    const other = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    assert.equal((await a.signed('GET', `/v1/recv/${a.rid}`, '', other.privateKey)).status, 401);
    assert.equal((await a.signed('GET', `/v1/recv/${a.rid}`, '', undefined, Date.now() - 10 * 60_000)).status, 401);
    // b's key cannot read a's queue.
    assert.equal((await b.signed('GET', `/v1/recv/${a.rid}`)).status, 401);
    // The send id is not a read capability.
    assert.equal((await a.signed('GET', `/v1/recv/${a.sid}`)).status, 404);
  });

  it('enforces size and quota limits', async () => {
    const o = await owner();
    assert.equal((await fetch(`${base}/v1/send/${o.sid}`, { method: 'POST', body: blob(70_000) })).status, 413);
    assert.equal((await fetch(`${base}/v1/send/${o.sid}`, { method: 'POST', body: blob(8) })).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/v1/send/${o.sid}`, { method: 'POST', body: blob() })).status, 202);
    assert.equal((await fetch(`${base}/v1/send/${o.sid}`, { method: 'POST', body: blob() })).status, 507);
    assert.equal((await fetch(`${base}/v1/send/AAAAAAAAAAAAAAAAAAAAAA`, { method: 'POST', body: blob() })).status, 404);
  });

  it('deletes queues and only accepts real push services', async () => {
    const o = await owner();
    assert.equal((await o.signed('PUT', `/v1/recv/${o.rid}/push`, JSON.stringify({ endpoint: 'http://169.254.169.254/latest' }))).status, 400);
    assert.equal((await o.signed('PUT', `/v1/recv/${o.rid}/push`, JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }))).status, 204);
    assert.equal((await o.signed('DELETE', `/v1/recv/${o.rid}`)).status, 204);
    assert.equal((await fetch(`${base}/v1/send/${o.sid}`, { method: 'POST', body: blob() })).status, 404);
  });

  it('validates push endpoints strictly (SSRF protection)', () => {
    assert.ok(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x'));
    assert.ok(allowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
    assert.ok(allowedPushEndpoint('https://web.push.apple.com/abc'));
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://localhost/x', 42]) {
      assert.equal(allowedPushEndpoint(bad), false, String(bad));
    }
  });
});
