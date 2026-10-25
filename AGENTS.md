# AGENTS.md

Guidance for AI coding agents (and humans) working on Veil. Read this before changing anything. Security is the product.

## What Veil is

A private messenger shipped as an installable PWA. Live chat and files go peer-to-peer over WebRTC with a hybrid post-quantum handshake. Offline messages optionally go through a self-hosted, zero-knowledge mailbox relay using the Double Ratchet. All data is encrypted at rest on the device. Deep dives: `docs/ARCHITECTURE.md`, threat model: `SECURITY.md`, relay protocol: `relay/README.md`.

## Repository map

| Path | What | Notes |
|---|---|---|
| `app/src/crypto/` | `primitives.ts` (the only WebCrypto wrapper), `handshake.ts` (X25519 + ML-KEM-768 + Ed25519), `chain.ts` (live KDF chains), `ratchet.ts` (Double Ratchet), `identity.ts` (keys, safety numbers), `encoding.ts` | Security critical. Every change needs tests |
| `app/src/net/` | `peer.ts` (RTCPeerConnection, 2 pre-negotiated data channels), `signaling.ts` (manual one-time codes), `invite.ts` (v2 invite links + sealed join notes), `session.ts` (encrypted live session), `mailbox.ts` (relay client + padded envelopes) | |
| `app/src/storage/` | `vault.ts` (PBKDF2-wrapped master key, sealed records), `repo.ts` (typed records), `backup.ts` (`.veilbackup` format), `idb.ts` | Never store plaintext; all values go through the vault |
| `app/src/state/` | `app.ts` (controller: sessions, transfers, offline mail, rendezvous signaling, backup/restore), `store.ts` (reactive store), `notify.ts`, `install.ts`, `instance.ts` (single active window) | UI never touches crypto/net directly |
| `app/src/ui/` | Preact components; `app/src/styles/app.css` | |
| `app/sw/sw.js` | Service worker template (precache list injected at build) | |
| `app/test/` | Vitest unit tests | |
| `app/e2e/two-peers.mjs` | Playwright E2E: 2-3 browser profiles + a real relay | |
| `relay/` | Mailbox relay: `src/server.ts` (node:http + node:sqlite, zero runtime deps), Dockerfile, compose + Caddy, fly.toml | Node 24 runs the `.ts` directly (erasable syntax only) |
| `site/` | Static marketing site (no build step) | |
| `.github/workflows/` | `ci.yml`, `release.yml` (tag-driven), `pages.yml` (manual redeploy) | Actions pinned by commit SHA |

## Commands

Node **24+** is required everywhere.

```bash
# app
cd app
npm ci
npm run dev              # Vite dev server (no CSP injected in dev)
npm run typecheck
npm test                 # unit tests (crypto, ratchet, backup)
npm run build            # production build; injects CSP and generates sw.js
SIZE_MB=4 npm run test:e2e   # needs a build first + `npx playwright install chromium`

# relay
cd relay
npm ci
npm run typecheck
npm test                 # node:test
npm start                # PORT=8787 VEIL_RELAY_DATA=./data
```

Before you call work done: `typecheck`, unit tests and the E2E test pass in `app/`, and `typecheck` and tests pass in `relay/`.

## Non-negotiable security rules

1. **No new cryptography by hand.** Use `crypto/primitives.ts` (WebCrypto) or the audited `@noble/*` libraries. Never use `Math.random` for anything security related; use `randomBytes`/`randomId`.
2. **Every protocol or crypto change gets tests**, including negative tests (tamper, replay, reorder, truncation, wrong key). Look at `test/crypto.test.ts`, `test/ratchet.test.ts` and `test/backup.test.ts` for the style.
3. **Fail closed.** Authentication failure tears down the session or drops the message. Never "best effort" decrypt.
4. **Commit state only after authentication.** For example, the ratchet works on a copy and persists it *before* any ciphertext leaves the device.
5. **Never write plaintext to disk or to the relay.** All IndexedDB values go through `Vault`. Lookup keys are HMAC tags. The E2E test greps storage, backups and the relay database for plaintext.
6. **Never put ratchet state or mailbox credentials into backups**, since restoring them would reuse keys.
7. **Validate everything from peers and relays**: types, lengths, ranges, ids (`isId`). Unknown message types are ignored. Peer-supplied relay URLs must pass `normalizeRelayUrl` (https only).
8. **Keep the CSP strict.** No inline scripts or styles, no `style=` attributes (use classes or `rows`/`<progress>`), no `innerHTML`, no new origins in `script-src`. Trusted Types are enforced. Only inert media types render inline (`safeMime`).
9. **Notifications never contain message text.** Push payloads are empty.
10. **Dependencies:** add only when unavoidable, pin exact versions, commit the lockfile. The relay has zero runtime deps; keep it that way. Pin new GitHub Actions by commit SHA.
11. **No secrets in the repo**, ever. The relay generates its VAPID key at runtime into its data dir.

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess`. Match the surrounding style: small modules, doc comments that explain *why*, and the existing naming.
- Copy uses hyphens, never em or en dashes.
- UI: accessible by default (labels, `aria-*`, focus states, keyboard, reduced motion), works from 320 px phones to desktop, dark and light themes.
- The app is offline-first and must keep working with no relay configured.
- Wire changes must stay backward compatible (old peers ignore unknown message types; HKDF outputs are only extended, never reordered). Bump `PROTOCOL_VERSION` only for breaking handshake changes.

## Releasing

Releases are tag-driven. Bump `app/package.json`, commit, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The release workflow re-runs every check, publishes the GitHub Release (zips + checksums), deploys Pages, and pushes `ghcr.io/<owner>/veil-relay`. Do not tag without the user's go-ahead.
