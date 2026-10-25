/**
 * Tiny in-memory Nostr relay for the E2E test (NIP-01 subset: EVENT, REQ, CLOSE).
 * It keeps everything it receives so the test can prove relays only ever see ciphertext.
 */
import { WebSocketServer } from 'ws';

export function startNostrRelay(port) {
  const events = [];
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const subs = new Map(); // ws -> Map(subId -> filter)
  const matches = (f, ev) =>
    (!f.kinds || f.kinds.includes(ev.kind)) &&
    (!f['#p'] || ev.tags.some((t) => t[0] === 'p' && f['#p'].includes(t[1]))) &&
    (!f.since || ev.created_at >= f.since);

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg[0] === 'EVENT') {
        const ev = msg[1];
        if (!events.some((e) => e.id === ev.id)) events.push(ev);
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        for (const [client, s] of subs) for (const [id, f] of s) if (matches(f, ev)) client.send(JSON.stringify(['EVENT', id, ev]));
      } else if (msg[0] === 'REQ') {
        const [, id, f] = msg;
        subs.get(ws).set(id, f);
        for (const ev of events) if (matches(f, ev)) ws.send(JSON.stringify(['EVENT', id, ev]));
        ws.send(JSON.stringify(['EOSE', id]));
      } else if (msg[0] === 'CLOSE') {
        subs.get(ws).delete(msg[1]);
      }
    });
    ws.on('close', () => subs.delete(ws));
  });
  const close = () =>
    new Promise((r) => {
      for (const c of wss.clients) c.terminate(); // do not wait for browsers to hang up
      wss.close(() => r());
      setTimeout(r, 1000);
    });
  return { url: `ws://127.0.0.1:${port}`, events, close };
}
