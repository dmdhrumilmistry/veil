/**
 * Veil Mailbox Relay - a zero-knowledge store-and-forward queue for offline messages.
 *
 * What it stores: opaque, padded ciphertext blobs in anonymous queues. No accounts, no
 * contact lists, no names, no plaintext, no IP logs. Each queue has two unlinkable
 * random ids: `sid` (given to contacts, can only append) and `rid` (kept by the owner,
 * can read/ack/delete, and every owner request is signed with the queue's Ed25519 key).
 *
 * Optional Web Push: an owner may register a push endpoint; the relay then sends an
 * *empty* push (no payload) when mail arrives, authenticated with the relay's own VAPID
 * key. Endpoints are restricted to known push services to prevent SSRF.
 *
 * Zero npm dependencies: node:http, node:sqlite, WebCrypto.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RelayConfig {
  port: number;
  dataDir: string;
  /** Use X-Forwarded-For for rate limiting (only behind a trusted reverse proxy). */
  trustProxy: boolean;
  /** VAPID "sub" contact (mailto: or https: URL). */
  contact: string;
  maxMessageBytes: number;
  maxQueueMessages: number;
  messageTtlDays: number;
  queueIdleDays: number;
}

export const DEFAULTS: RelayConfig = {
  port: 8787,
  dataDir: './data',
  trustProxy: false,
  contact: 'https://github.com/dmdhrumilmistry/veil',
  maxMessageBytes: 64 * 1024 + 64,
  maxQueueMessages: 2000,
  messageTtlDays: 30,
  queueIdleDays: 90,
};

const VERSION = '1.0.0';
const subtle = globalThis.crypto.subtle;
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];

// ---------------------------------------------------------------- helpers

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const randomId = () => b64u(crypto.getRandomValues(new Uint8Array(16)));
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);
const now = () => Date.now();

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Token-bucket rate limiter keyed by an opaque string (client IP), kept in memory only. */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly perSecond: number;
  constructor(capacity: number, perSecond: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
  }
  take(key: string): boolean {
    const t = now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSecond);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.buckets.clear();
    return true;
  }
}

// ---------------------------------------------------------------- VAPID / Web Push

interface Vapid {
  publicKey: Uint8Array; // uncompressed P-256 point (65 bytes)
  privateKey: CryptoKey;
}

async function loadVapid(dir: string): Promise<Vapid> {
  const file = join(dir, 'vapid.json');
  if (!existsSync(file)) {
    const kp = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = await subtle.exportKey('jwk', kp.privateKey);
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  const jwk = JSON.parse(readFileSync(file, 'utf8')) as JsonWebKey;
  const privateKey = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pubJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const pub = await subtle.importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return { publicKey: new Uint8Array(await subtle.exportKey('raw', pub)), privateKey };
}

async function vapidHeader(v: Vapid, endpoint: string, contact: string): Promise<string> {
  const enc = (o: object) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub: contact })}`;
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.privateKey, new TextEncoder().encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${b64u(v.publicKey)}`;
}

export function allowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- storage

function openDb(dir: string) {
  const db = new DatabaseSync(join(dir, 'relay.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS queues (
      rid TEXT PRIMARY KEY, sid TEXT UNIQUE NOT NULL, key BLOB NOT NULL,
      push TEXT, last_push INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT NOT NULL, ts INTEGER NOT NULL, body BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_rid ON messages (rid, id);
  `);
  return db;
}

// ---------------------------------------------------------------- server

export async function startRelay(partial: Partial<RelayConfig> = {}) {
  const cfg: RelayConfig = { ...DEFAULTS, ...partial };
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const db = openDb(cfg.dataDir);
  const vapid = await loadVapid(cfg.dataDir);
  const sendLimiter = new RateLimiter(120, 2);
  const createLimiter = new RateLimiter(10, 10 / 3600);
  const ownerLimiter = new RateLimiter(240, 4);

  const q = {
    insertQueue: db.prepare('INSERT INTO queues (rid, sid, key, created, seen) VALUES (?, ?, ?, ?, ?)'),
    queueBySid: db.prepare('SELECT rid, push, last_push FROM queues WHERE sid = ?'),
    queueByRid: db.prepare('SELECT rid, key FROM queues WHERE rid = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE rid = ?'),
    insertMsg: db.prepare('INSERT INTO messages (rid, ts, body) VALUES (?, ?, ?)'),
    list: db.prepare('SELECT id, ts, body FROM messages WHERE rid = ? AND id > ? ORDER BY id LIMIT 100'),
    ack: db.prepare('DELETE FROM messages WHERE rid = ? AND id <= ?'),
    seen: db.prepare('UPDATE queues SET seen = ? WHERE rid = ?'),
    setPush: db.prepare('UPDATE queues SET push = ? WHERE rid = ?'),
    pushed: db.prepare('UPDATE queues SET last_push = ? WHERE rid = ?'),
    dropQueue: db.prepare('DELETE FROM queues WHERE rid = ?'),
    dropMsgs: db.prepare('DELETE FROM messages WHERE rid = ?'),
    expireMsgs: db.prepare('DELETE FROM messages WHERE ts < ?'),
    idleQueues: db.prepare('SELECT rid FROM queues WHERE seen < ?'),
  };

  const sweep = () => {
    q.expireMsgs.run(now() - cfg.messageTtlDays * 86_400_000);
    for (const row of q.idleQueues.all(now() - cfg.queueIdleDays * 86_400_000) as { rid: string }[]) {
      q.dropMsgs.run(row.rid);
      q.dropQueue.run(row.rid);
    }
  };
  sweep();
  const sweepTimer = setInterval(sweep, 3600_000);
  sweepTimer.unref();

  async function notify(rid: string, push: string | null, lastPush: number) {
    // Coalesce: at most one wake-up per queue every 20 seconds.
    if (!push || now() - lastPush < 20_000) return;
    q.pushed.run(now(), rid);
    try {
      const res = await fetch(push, {
        method: 'POST',
        headers: { TTL: '86400', Urgency: 'high', Authorization: await vapidHeader(vapid, push, cfg.contact), 'Content-Length': '0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404 || res.status === 410) q.setPush.run(null, rid); // subscription gone
    } catch {
      /* push services are best-effort */
    }
  }

  /** Owner requests carry `Veil-Auth: <unix-ms>.<base64url Ed25519 signature>`. */
  async function verifyOwner(req: IncomingMessage, path: string, rid: string, body: Buffer) {
    const row = q.queueByRid.get(rid) as { rid: string; key: Uint8Array } | undefined;
    if (!row) throw new HttpError(404, 'no such queue');
    const auth = String(req.headers['veil-auth'] ?? '');
    const m = auth.match(/^(\d{10,16})\.([A-Za-z0-9_-]{86})$/);
    if (!m) throw new HttpError(401, 'missing signature');
    const ts = Number(m[1]);
    if (Math.abs(now() - ts) > 5 * 60_000) throw new HttpError(401, 'stale signature');
    const digest = Buffer.from(await subtle.digest('SHA-256', new Uint8Array(body))).toString('hex');
    const msg = new TextEncoder().encode(`veil-relay/v1\n${req.method}\n${path}\n${ts}\n${digest}`);
    const key = await subtle.importKey('raw', row.key as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    if (!(await subtle.verify({ name: 'Ed25519' }, key, fromB64u(m[2]!) as BufferSource, msg))) throw new HttpError(401, 'bad signature');
    q.seen.run(now(), rid);
  }

  function clientKey(req: IncomingMessage): string {
    const fwd = cfg.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : '';
    return fwd || req.socket.remoteAddress || 'unknown';
  }

  function send(res: ServerResponse, status: number, body?: unknown) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Type',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Strict-Transport-Security': 'max-age=63072000',
    });
    res.end(payload);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://relay');
    const path = url.pathname;
    const ip = clientKey(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Veil-Auth',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && (path === '/v1/info' || path === '/')) {
      return send(res, 200, { service: 'veil-relay', v: 1, version: VERSION, vapid: b64u(vapid.publicKey), maxMessage: cfg.maxMessageBytes, ttlDays: cfg.messageTtlDays });
    }

    // Create a queue: { key: base64url Ed25519 public key }
    if (req.method === 'POST' && path === '/v1/queues') {
      if (!createLimiter.take(ip)) throw new HttpError(429, 'slow down');
      const body = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}') as { key?: unknown };
      const key = typeof body.key === 'string' ? fromB64u(body.key) : new Uint8Array();
      if (key.length !== 32) throw new HttpError(400, 'key must be a 32-byte Ed25519 public key');
      const rid = randomId();
      const sid = randomId();
      q.insertQueue.run(rid, sid, key, now(), now());
      return send(res, 201, { rid, sid });
    }

    // Anyone holding the send capability may append one ciphertext.
    let m = path.match(/^\/v1\/send\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'POST' && m) {
      if (!sendLimiter.take(ip)) throw new HttpError(429, 'slow down');
      const sid = m[1]!;
      if (!isId(sid)) throw new HttpError(404, 'no such queue');
      const row = q.queueBySid.get(sid) as { rid: string; push: string | null; last_push: number } | undefined;
      if (!row) throw new HttpError(404, 'no such queue');
      const body = await readBody(req, cfg.maxMessageBytes);
      if (body.length < 32) throw new HttpError(400, 'empty message');
      if ((q.count.get(row.rid) as { n: number }).n >= cfg.maxQueueMessages) throw new HttpError(507, 'mailbox full');
      q.insertMsg.run(row.rid, now(), body);
      void notify(row.rid, row.push, row.last_push);
      return send(res, 202, {});
    }

    m = path.match(/^\/v1\/recv\/([A-Za-z0-9_-]+)(\/ack|\/push)?$/);
    if (m) {
      if (!ownerLimiter.take(ip)) throw new HttpError(429, 'slow down');
      const rid = m[1]!;
      if (!isId(rid)) throw new HttpError(404, 'no such queue');
      const body = await readBody(req, 4096);
      await verifyOwner(req, path, rid, body);
      const sub = m[2];
      if (!sub && req.method === 'GET') {
        const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
        const rows = q.list.all(rid, after) as { id: number; ts: number; body: Uint8Array }[];
        return send(res, 200, { messages: rows.map((r) => ({ id: r.id, ts: r.ts, body: b64u(r.body) })), more: rows.length === 100 });
      }
      if (!sub && req.method === 'DELETE') {
        q.dropMsgs.run(rid);
        q.dropQueue.run(rid);
        return send(res, 204);
      }
      if (sub === '/ack' && req.method === 'POST') {
        const { upTo } = JSON.parse(body.toString('utf8') || '{}') as { upTo?: unknown };
        if (typeof upTo !== 'number' || !Number.isSafeInteger(upTo)) throw new HttpError(400, 'upTo required');
        q.ack.run(rid, upTo);
        return send(res, 204);
      }
      if (sub === '/push' && req.method === 'PUT') {
        const { endpoint } = JSON.parse(body.toString('utf8') || '{}') as { endpoint?: unknown };
        if (!allowedPushEndpoint(endpoint)) throw new HttpError(400, 'unsupported push endpoint');
        q.setPush.run(endpoint, rid);
        return send(res, 204);
      }
      if (sub === '/push' && req.method === 'DELETE') {
        q.setPush.run(null, rid);
        return send(res, 204);
      }
    }
    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error('[relay] internal error:', (err as Error).message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (err as Error).message });
      else res.end();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweepTimer);
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
