import { describe, expect, it } from 'vitest';
import { newMailboxKey, normalizeRelay, verifyEvent, wrapEvent } from '../src/net/nostr';

describe('nostr transport', () => {
  it('signs gift-wrap events with a throwaway key per event', async () => {
    const { pk } = newMailboxKey();
    const a = await wrapEvent(pk, 'Y2lwaGVydGV4dA', 3600);
    const b = await wrapEvent(pk, 'Y2lwaGVydGV4dA', 3600);
    expect(verifyEvent(a)).toBe(true);
    expect(a.kind).toBe(1059);
    expect(a.pubkey).not.toBe(b.pubkey); // unlinkable senders
    expect(a.tags).toContainEqual(['p', pk]);
    expect(a.tags.find((t) => t[0] === 'expiration')).toBeTruthy();
  });

  it('rejects tampered or forged events', async () => {
    const ev = await wrapEvent(newMailboxKey().pk, 'abc', 60);
    expect(verifyEvent({ ...ev, content: 'abd' })).toBe(false);
    expect(verifyEvent({ ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === 'a' ? 'b' : 'a') })).toBe(false);
    expect(verifyEvent({ ...ev, kind: 1 })).toBe(false);
  });

  it('only accepts secure relay addresses', () => {
    expect(normalizeRelay('wss://nos.lol/')).toBe('wss://nos.lol');
    expect(() => normalizeRelay('ws://nos.lol')).toThrow();
    expect(() => normalizeRelay('https://nos.lol')).toThrow();
    expect(() => normalizeRelay('wss://user:pw@nos.lol')).toThrow();
    expect(() => normalizeRelay('ws://127.0.0.1:7000')).toThrow();
    expect(normalizeRelay('ws://127.0.0.1:7000', true)).toBe('ws://127.0.0.1:7000');
  });
});
