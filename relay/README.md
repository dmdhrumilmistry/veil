# Veil Mailbox Relay

A tiny, zero-knowledge store-and-forward queue that lets Veil contacts message you while you are offline. Run your own in a minute. It has no npm runtime dependencies (only Node.js built-ins: `node:http`, `node:sqlite`, WebCrypto).

## What the relay can and cannot see

| The relay sees | The relay never sees |
|---|---|
| That some client appended an opaque, padded blob to an anonymous queue | Message content, file names, display names, contact lists |
| The IP address of whoever connects (not logged, used only for in-memory rate limits) | Who the sender is (there is no sender id; envelopes are encrypted with a key only the two contacts share) |
| Approximate message sizes (padded to 1 / 4 / 16 / 64 KiB buckets) and timing | Double Ratchet headers, message counters, identity keys |
| Your push endpoint, if you enable push | Anything about message content in pushes: they are **empty** |

Messages are deleted as soon as the owner acknowledges them, after 30 days if never collected, and idle queues are removed after 90 days. SQLite runs with `secure_delete`.

## Protocol (v1)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/v1/info` | - | Service info and the relay's VAPID public key |
| `POST` | `/v1/queues` | rate limited | Create a queue for `{ key: Ed25519 public key }`, returns `{ rid, sid }` |
| `POST` | `/v1/send/{sid}` | send capability (`sid`) | Append one ciphertext (max 64 KiB) |
| `GET` | `/v1/recv/{rid}?after=n` | owner signature | List up to 100 messages |
| `POST` | `/v1/recv/{rid}/ack` | owner signature | Delete messages up to `upTo` |
| `PUT` / `DELETE` | `/v1/recv/{rid}/push` | owner signature | Set or clear the Web Push endpoint |
| `DELETE` | `/v1/recv/{rid}` | owner signature | Delete the queue and all its messages |
| `GET` | `/healthz` | - | Health check |

- `rid` (read) and `sid` (send) are independent 128-bit random ids. Contacts only ever learn `sid`, which can append but never read.
- Owner requests carry `Veil-Auth: <unix-ms>.<Ed25519 signature>` over `veil-relay/v1\n{METHOD}\n{path}\n{ts}\n{sha256(body)}`. The timestamp must be within 5 minutes.
- Push endpoints are restricted to known push services (FCM, Mozilla, Apple, Windows) to prevent SSRF. Pushes are empty and coalesced to at most one per queue every 20 seconds.
- Limits: 2,000 queued messages per queue, per-IP token buckets for sending, owner calls and queue creation, plus strict header and body timeouts.

## Deploy

### Option 1: Docker Compose with automatic HTTPS (recommended)

On any small VPS or home server with ports 80 and 443 reachable, and a DNS record pointing at it:

```bash
git clone https://github.com/dmdhrumilmistry/veil && cd veil/relay
VEIL_RELAY_DOMAIN=relay.example.com docker compose up -d
```

Caddy obtains and renews a Let's Encrypt certificate automatically. The relay container runs as a non-root user with a read-only filesystem, no capabilities, and memory and PID limits.

### Option 2: Fly.io

```bash
cd relay
fly launch --copy-config --no-deploy
fly volumes create relay_data --size 1
fly deploy
```

### Option 3: Plain Node.js (24+)

```bash
cd relay && PORT=8787 VEIL_RELAY_DATA=./data npm start
```

Put it behind any HTTPS reverse proxy and set `VEIL_RELAY_TRUST_PROXY=1`. The Veil app refuses plain-HTTP relays, except on `localhost` for development.

### Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `VEIL_RELAY_DATA` | `./data` | SQLite database and VAPID key (back up this directory) |
| `VEIL_RELAY_TRUST_PROXY` | off | Read client IPs from `X-Forwarded-For` (only behind your own proxy) |
| `VEIL_RELAY_CONTACT` | project URL | `mailto:` or `https:` contact sent to push services (VAPID `sub`) |
| `VEIL_RELAY_TTL_DAYS` | `30` | How long uncollected messages are kept |

The container image `ghcr.io/dmdhrumilmistry/veil-relay` is built for `amd64` and `arm64` (Raspberry Pi works) by the release workflow.

## Use it

In Veil: **Settings → Offline messages → Relay address → Set up**. Contacts learn your mailbox the next time you connect live, and from then on they can message you while you are away. Turn on **Wake this device** to get a push notification when mail arrives.

## Develop

```bash
npm ci
npm run typecheck
npm test
```
