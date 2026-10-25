/**
 * Live interop: the TypeScript handshake against the Dart one (flutter/veil_core),
 * exchanging the real JSON messages, in both roles, then live frames both ways.
 * Runs when VEIL_DART_PEER points at a compiled `tool/interop_peer.dart` binary
 * (CI builds it); skipped otherwise.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { RecvChain, SendChain } from '../src/crypto/chain';
import { fromB64u, toB64u, toHex, utf8 } from '../src/crypto/encoding';
import { Handshake, type HandshakeMessage, type Role } from '../src/crypto/handshake';
import { generateIdentity } from '../src/crypto/identity';
import { sha256 } from '../src/crypto/primitives';

const PEER = process.env.VEIL_DART_PEER;
const FP_TS = 'sha-256 11:22:33';
const FP_DART = 'sha-256 44:55:66';

function dartPeer() {
  const proc = spawn(PEER!, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  return {
    async call(msg: object): Promise<Record<string, unknown>> {
      proc.stdin.write(JSON.stringify(msg) + '\n');
      const { value } = await lines.next();
      const res = JSON.parse(value as string);
      if (res.error) throw new Error(`dart: ${res.error}`);
      return res;
    },
    close: () => proc.kill(),
  };
}

async function run(tsRole: Role) {
  const dart = dartPeer();
  const me = (await generateIdentity()).identity;
  const dartRole = tsRole === 'initiator' ? 'responder' : 'initiator';
  const init = await dart.call({ cmd: 'init', role: dartRole, fpLocal: FP_DART, fpRemote: FP_TS, expectedPeer: toB64u(me.pub) });
  const hs = new Handshake({ role: tsRole, identity: me, localFingerprint: FP_TS, remoteFingerprint: FP_DART, expectedPeer: fromB64u(init.id as string) });

  let keys;
  let dartDone: Record<string, unknown> | undefined;
  let toDart: HandshakeMessage | undefined = tsRole === 'initiator' ? await hs.start() : undefined;
  let fromDart = init.hs as object | undefined;
  for (let i = 0; i < 4 && !(keys && dartDone); i++) {
    if (fromDart) {
      const r = await hs.receive(JSON.parse(JSON.stringify(fromDart)));
      if (r.keys) keys = r.keys;
      toDart = r.reply;
      fromDart = undefined;
    }
    if (toDart) {
      const res = await dart.call({ cmd: 'hs', msg: toDart });
      if (res.done) dartDone = res;
      fromDart = (res.hs as object | null) ?? undefined;
      toDart = undefined;
    }
  }
  expect(keys && dartDone).toBeTruthy();
  expect(dartDone!.asyncRoot).toBe(toHex(await sha256(keys!.asyncRoot)));
  expect(dartDone!.peer).toBe(toB64u(me.pub));

  const tx = new SendChain(keys!.ctrlSend, 'veil/v1/ctrl');
  const rx = new RecvChain(keys!.ctrlRecv, 'veil/v1/ctrl');
  const frames = [toB64u(await tx.seal(utf8('hello dart'))), toB64u(await tx.seal(utf8('second')))];
  const res = await dart.call({ cmd: 'frames', in: frames, send: ['hello web', 'from flutter'] });
  expect(res.opened).toEqual(['hello dart', 'second']);
  const back: string[] = [];
  for (const f of res.out as string[]) back.push(new TextDecoder().decode(await rx.open(fromB64u(f)))); // strictly in order
  expect(back).toEqual(['hello web', 'from flutter']);
  dart.close();
}

describe.skipIf(!PEER)('live interop with the Dart core', () => {
  it('web initiator <-> Dart responder', () => run('initiator'), 60_000);
  it('Dart initiator <-> web responder', () => run('responder'), 60_000);
});
