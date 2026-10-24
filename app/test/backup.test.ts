import { describe, expect, it } from 'vitest';
import { randomBytes, randomId, toB64u } from '../src/crypto/encoding';
import { BackupError, BackupWriter, readBackup, type BackupEntry } from '../src/storage/backup';

const ITER = 100_000; // keep tests fast; production uses 600k
const PASS = 'backup passphrase 123';

async function makeBackup(): Promise<{ blob: Blob; fileId: string; data: Uint8Array; frames: Uint8Array[] }> {
  const w = await BackupWriter.create(PASS, ITER);
  const fileId = randomId();
  const data = randomBytes(5000);
  const frames = [w.header, await w.json('profile', { name: 'Alice' }), await w.json('contact', { id: 'x', name: 'Bob' }), await w.chunk(fileId, 0, data), await w.end()];
  return { blob: new Blob(frames as BlobPart[]), fileId, data, frames };
}

async function all(blob: Blob, pass = PASS): Promise<BackupEntry[]> {
  const out: BackupEntry[] = [];
  for await (const e of readBackup(blob, pass)) out.push(e);
  return out;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof BackupError ? e.code : String(e);
  }
}

describe('encrypted backups', () => {
  it('round-trips json entries and file chunks', async () => {
    const { blob, fileId, data } = await makeBackup();
    const entries = await all(blob);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ type: 'json', k: 'profile', d: { name: 'Alice' } });
    const chunk = entries[2]!;
    expect(chunk.type === 'chunk' && chunk.fileId === fileId && toB64u(chunk.data) === toB64u(data)).toBe(true);
  });

  it('contains no plaintext', async () => {
    const { blob } = await makeBackup();
    const text = new TextDecoder().decode(await blob.arrayBuffer());
    expect(text).not.toContain('Alice');
    expect(text).not.toContain('Bob');
  });

  it('rejects a wrong passphrase', async () => {
    const { blob } = await makeBackup();
    expect(await code(all(blob, 'nope nope nope'))).toBe('wrong-passphrase');
  });

  it('detects truncation (missing end record)', async () => {
    const { frames } = await makeBackup();
    expect(await code(all(new Blob(frames.slice(0, -1) as BlobPart[])))).toBe('truncated');
    const cut = new Blob(frames as BlobPart[]).slice(0, new Blob(frames as BlobPart[]).size - 10);
    expect(await code(all(cut))).toBe('truncated');
  });

  it('detects reordered, dropped and tampered records', async () => {
    const { frames } = await makeBackup();
    const [h, a, b, c, end] = frames;
    expect(await code(all(new Blob([h, b, a, c, end] as BlobPart[])))).toBe('wrong-passphrase'); // record 0 fails
    expect(await code(all(new Blob([h, a, c, end] as BlobPart[])))).toBe('corrupt');
    const t = new Uint8Array(c!);
    t[t.length - 1]! ^= 1;
    expect(await code(all(new Blob([h, a, b, t, end] as BlobPart[])))).toBe('corrupt');
    expect(await code(all(new Blob([...frames, a] as BlobPart[])))).toBe('corrupt'); // trailing data
  });

  it('detects header tampering and non-backups', async () => {
    const { frames } = await makeBackup();
    const h = new Uint8Array(frames[0]!);
    h[h.length - 3]! ^= 1; // flips a byte inside the salt/iter JSON
    expect(['wrong-passphrase', 'corrupt', 'not-a-backup']).toContain(await code(all(new Blob([h, ...frames.slice(1)] as BlobPart[]))));
    expect(await code(all(new Blob(['hello world, definitely not a backup'])))).toBe('not-a-backup');
  });
});
