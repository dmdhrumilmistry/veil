import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { utf8 } from '../crypto/encoding';

/**
 * Minimal Nostr client used purely as a public, untrusted transport.
 *
 * Every Veil payload is already end-to-end encrypted and padded before it gets here.
 * Events follow the NIP-59 "gift wrap" shape:
 *   kind 1059, signed by a fresh random key per event (unlinkable senders),
 *   tag ["p", <recipient mailbox key>], tag ["expiration", ...] (NIP-40),
 *   content = base64url(ciphertext)
 * Relays therefore learn only that some pseudonymous mailbox key received a blob of a
 * padded size at some time - never who sent it or what it says.
 */

export const WRAP_KIND = 1059;
export const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.damus.io'];
export const MAX_RELAYS = 6;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Filter {
  kinds: number[];
  '#p': string[];
  since?: number;
}

export const isHexKey = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** Relay URLs must be wss:// (ws:// only for a relay on this machine while developing). */
export function normalizeRelay(input: string, allowLocal = false): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error(`Not a valid relay address: ${input}`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'wss:' && !(allowLocal && local && u.protocol === 'ws:')) throw new Error(`Relays must use wss:// (${input})`);
  if (u.username || u.password || u.search || u.hash) throw new Error(`Use a plain relay address (${input})`);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

export function newMailboxKey(): { sk: string; pk: string } {
  const sk = schnorr.utils.randomSecretKey();
  return { sk: bytesToHex(sk), pk: bytesToHex(schnorr.getPublicKey(sk)) };
}

/** Builds and signs a gift-wrap event with a throwaway key. */
export async function wrapEvent(recipientPk: string, content: string, ttlSeconds: number): Promise<NostrEvent> {
  const sk = schnorr.utils.randomSecretKey();
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  // Small random backdating blurs exact send times (NIP-59 style).
  const created_at = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 60);
  const tags = [['p', recipientPk], ['expiration', String(Math.floor(Date.now() / 1000) + ttlSeconds)]];
  const hash = sha256(utf8(JSON.stringify([0, pubkey, created_at, WRAP_KIND, tags, content])));
  const sig = bytesToHex(await schnorr.sign(hash, sk));
  sk.fill(0);
  return { id: bytesToHex(hash), pubkey, created_at, kind: WRAP_KIND, tags, content, sig };
}

/** Rejects malformed or forged events (cheap insurance against misbehaving relays). */
export function verifyEvent(ev: NostrEvent): boolean {
  try {
    if (!isHexKey(ev.pubkey) || ev.kind !== WRAP_KIND || typeof ev.content !== 'string' || ev.content.length > 200_000) return false;
    const hash = sha256(utf8(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
    return bytesToHex(hash) === ev.id && schnorr.verify(hexToBytes(ev.sig), hash, hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

type RelayState = 'connecting' | 'open' | 'closed';

class RelayConn {
  ws?: WebSocket;
  state: RelayState = 'closed';
  private backoff = 1000;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private acks = new Map<string, (ok: boolean) => void>();

  constructor(
    readonly url: string,
    private readonly pool: NostrPool,
    /** Publish-only connections never subscribe (do not reveal our mailbox to their relays). */
    private readonly subscribing = true,
  ) {
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    this.pool.changed();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.state = 'open';
      this.backoff = 1000;
      this.pool.changed();
      if (this.subscribing) this.pool.resubscribe(this);
    };
    ws.onmessage = (m) => this.onMessage(m.data);
    ws.onclose = () => {
      this.state = 'closed';
      for (const done of this.acks.values()) done(false);
      this.acks.clear();
      this.pool.changed();
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  private onMessage(data: unknown) {
    if (typeof data !== 'string' || data.length > 300_000) return;
    let msg: unknown[];
    try {
      msg = JSON.parse(data) as unknown[];
    } catch {
      return;
    }
    if (msg[0] === 'EVENT' && msg[2] && typeof msg[2] === 'object') this.pool.deliver(msg[2] as NostrEvent);
    else if (msg[0] === 'OK' && typeof msg[1] === 'string') {
      this.acks.get(msg[1])?.(msg[2] === true);
      this.acks.delete(msg[1]);
    }
  }

  send(frame: unknown[]) {
    if (this.state === 'open') this.ws!.send(JSON.stringify(frame));
  }

  publish(ev: NostrEvent): Promise<boolean> {
    if (this.state !== 'open') return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.acks.delete(ev.id);
        resolve(false);
      }, 8000);
      this.acks.set(ev.id, (ok) => {
        clearTimeout(t);
        resolve(ok);
      });
      this.send(['EVENT', ev]);
    });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.state = 'closed';
  }
}

/** A set of relays with one live subscription; deduplicates events across relays. */
export class NostrPool {
  private conns = new Map<string, RelayConn>();
  private filter?: Filter;
  private seen = new Set<string>();

  constructor(
    private readonly onEvent: (ev: NostrEvent) => void,
    private readonly onStatus: () => void = () => {},
  ) {}

  setRelays(urls: string[]) {
    for (const [url, c] of this.conns) {
      if (!urls.includes(url)) {
        c.close();
        this.conns.delete(url);
      }
    }
    for (const url of urls) if (!this.conns.has(url)) this.conns.set(url, new RelayConn(url, this));
    this.changed();
  }

  subscribe(filter: Filter) {
    this.filter = filter;
    for (const c of this.conns.values()) this.resubscribe(c);
  }

  /** @internal */
  resubscribe(c: RelayConn) {
    if (!this.filter) return;
    c.send(['CLOSE', 'veil']);
    c.send(['REQ', 'veil', this.filter]);
  }

  /** @internal */
  deliver(ev: NostrEvent) {
    if (typeof ev.id !== 'string' || this.seen.has(ev.id)) return;
    if (!this.filter || !ev.tags?.some((t) => t[0] === 'p' && this.filter!['#p'].includes(t[1]!))) return;
    if (!verifyEvent(ev)) return;
    this.seen.add(ev.id);
    if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
    this.onEvent(ev);
  }

  /** @internal */
  changed() {
    this.onStatus();
  }

  /** Publishes to the given relays (connecting ad hoc to ones we do not use); true if any accepted. */
  async publish(ev: NostrEvent, relays: string[]): Promise<boolean> {
    const temp: RelayConn[] = [];
    const targets = relays.map((url) => {
      let c = this.conns.get(url);
      if (!c) {
        c = new RelayConn(url, this, false);
        temp.push(c);
      }
      return c;
    });
    // Give fresh connections a moment to open.
    const deadline = Date.now() + 5000;
    while (targets.every((c) => c.state !== 'open') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const results = await Promise.all(targets.map((c) => c.publish(ev)));
    for (const c of temp) c.close();
    return results.some(Boolean);
  }

  status(): { url: string; state: RelayState }[] {
    return [...this.conns.values()].map((c) => ({ url: c.url, state: c.state }));
  }

  close() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}
