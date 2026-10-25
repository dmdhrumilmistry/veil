import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { randomId } from '../src/crypto/encoding';
import { PAGE_SIZE, Repo, type Message } from '../src/storage/repo';
import { Vault } from '../src/storage/vault';
import * as idb from '../src/storage/idb';

const msg = (chat: string, i: number): Message => ({ id: randomId(), chat, dir: 'in', ts: 1_000 + i, kind: 'text', text: `m${i}`, status: 'read' });

describe('paginated message storage', () => {
  it('opens a big chat by decrypting one page, then pages back in order', async () => {
    await idb.wipeDatabase();
    const repo = new Repo(await Vault.create('pass phrase 123!', 100_000));
    for (let i = 0; i < 150; i++) await repo.saveMessage(msg('chat-a', i));
    await repo.saveMessage(msg('chat-b', 0));

    const first = await repo.pageMessages('chat-a');
    expect(first.messages).toHaveLength(PAGE_SIZE);
    expect(first.more).toBe(true);
    expect(first.messages.at(-1)!.text).toBe('m149');
    const second = await repo.pageMessages('chat-a', first.messages[0]!.seq);
    expect(second.messages.at(-1)!.text).toBe('m89');
    const third = await repo.pageMessages('chat-a', second.messages[0]!.seq);
    expect(third.messages).toHaveLength(30);
    expect(third.more).toBe(false);
    expect(third.messages[0]!.text).toBe('m0');
    expect((await repo.listMessages('chat-b'))).toHaveLength(1);
  });

  it('updates in place and migrates legacy id-keyed messages in time order', async () => {
    await idb.wipeDatabase();
    const vault = await Vault.create('pass phrase 123!', 100_000);
    const repo = new Repo(vault);
    const m = msg('chat-c', 5);
    await repo.saveMessage(m);
    await repo.saveMessage({ ...m, status: 'read', text: 'edited' });
    expect((await repo.listMessages('chat-c')).map((x) => x.text)).toEqual(['edited']);

    // Simulate the pre-0.10 layout: `${chatTag}/${messageId}`.
    const tag = await vault.tag('chat:chat-d');
    for (const i of [3, 1, 2]) {
      const old = msg('chat-d', i);
      await vault.putJson('msgs', `${tag}/${old.id}`, old);
    }
    expect(await repo.migrateMessageKeys(['chat-d'])).toBe(3);
    expect((await repo.pageMessages('chat-d')).messages.map((x) => x.text)).toEqual(['m1', 'm2', 'm3']);
    expect(await repo.migrateMessageKeys(['chat-d'])).toBe(0);
  });
});
