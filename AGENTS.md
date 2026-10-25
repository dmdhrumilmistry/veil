# AGENTS.md

Guidance for AI coding agents (and humans) working on Veil. Read this before changing anything. Security is the product.

## What Veil is

A private messenger shipped as an installable PWA. Live chat and files go peer-to-peer over WebRTC with a hybrid post-quantum handshake. Invite links, offline messages and reconnects use public Nostr relays as untrusted pipes (Double Ratchet + padded gift-wrap events, no servers of our own; users can turn this off). All data is encrypted at rest on the device. Deep dives: `docs/ARCHITECTURE.md`, threat model: `SECURITY.md`.

## Repository map

| Path | What | Notes |
|---|---|---|
| `app/src/crypto/` | `primitives.ts` (the only WebCrypto wrapper), `handshake.ts` (X25519 + ML-KEM-768 + Ed25519), `chain.ts` (live KDF chains), `ratchet.ts` (Double Ratchet), `identity.ts` (keys, safety numbers), `encoding.ts` | Security critical. Every change needs tests |
| `app/src/net/` | `peer.ts` (RTCPeerConnection, 2 pre-negotiated data channels), `signaling.ts` (manual one-time codes), `invite.ts` (v3 invite links + sealed join notes), `session.ts` (encrypted live session), `mailbox.ts` (padded envelopes), `nostr.ts` (gift-wrap events, relay pool) | |
| `app/src/storage/` | `vault.ts` (PBKDF2-wrapped master key, sealed records), `repo.ts` (typed records), `backup.ts` (`.veilbackup` format), `idb.ts` | Never store plaintext; all values go through the vault |
| `app/src/state/` | `app.ts` (controller: sessions, transfers, offline mail, rendezvous signaling, backup/restore), `store.ts` (reactive store), `notify.ts`, `install.ts`, `instance.ts` (single active window) | UI never touches crypto/net directly |
| `app/src/ui/` | Preact components; `app/src/styles/app.css` | |
| `app/sw/sw.js` | Service worker template (precache list injected at build) | |
| `app/test/` | Vitest unit tests | |
| `app/e2e/two-peers.mjs`, `nostr-relay.mjs` | Playwright E2E: up to 4 browser profiles + an in-process Nostr relay | `npm run test:e2e:public` runs it over real public relays |
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
```

Before you call work done: `typecheck`, unit tests and the E2E test pass in `app/`.

## Non-negotiable security rules

1. **No new cryptography by hand.** Use `crypto/primitives.ts` (WebCrypto) or the audited `@noble/*` libraries. Never use `Math.random` for anything security related; use `randomBytes`/`randomId`.
2. **Every protocol or crypto change gets tests**, including negative tests (tamper, replay, reorder, truncation, wrong key). Look at `test/crypto.test.ts`, `test/ratchet.test.ts` and `test/backup.test.ts` for the style.
3. **Fail closed.** Authentication failure tears down the session or drops the message. Never "best effort" decrypt.
4. **Commit state only after authentication.** For example, the ratchet works on a copy and persists it *before* any ciphertext leaves the device.
5. **Never write plaintext to disk or to relays.** All IndexedDB values go through `Vault`. Lookup keys are HMAC tags. Every relay event is padded ciphertext signed by a fresh throwaway key. The E2E test greps storage, backups and relay events for plaintext and checks signers are unlinkable.
6. **Never put ratchet state or the mailbox key into backups**, since restoring them would reuse keys.
7. **Validate everything from peers and relays**: types, lengths, ranges, ids (`isId`). Unknown message types are ignored. Peer-supplied relays must pass `parseCard`/`normalizeRelay` (wss only, max 6).
8. **Keep the CSP strict.** No inline scripts or styles, no `style=` attributes (use classes or `rows`/`<progress>`), no `innerHTML`, no new origins in `script-src`. Trusted Types are enforced. Only inert media types render inline (`safeMime`).
9. **Notifications never contain message text.** There is no push server.
10. **Dependencies:** add only when unavoidable, pin exact versions, commit the lockfile. Pin new GitHub Actions by commit SHA.
12. **No servers of our own.** Do not add a backend, hosted relay or push service. Third-party transport (public Nostr relays) must only ever carry end-to-end encrypted, padded, sender-unlinkable data, and the app must keep working with it switched off.
11. **No secrets in the repo**, ever.

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess`. Match the surrounding style: small modules, doc comments that explain *why*, and the existing naming.
- Copy uses hyphens, never em or en dashes.
- UI: accessible by default (labels, `aria-*`, focus states, keyboard, reduced motion), works from 320 px phones to desktop, dark and light themes.
- The app is offline-first and must keep working with public relays turned off (peer-to-peer only).
- Wire changes must stay backward compatible (old peers ignore unknown message types; HKDF outputs are only extended, never reordered). Bump `PROTOCOL_VERSION` only for breaking handshake changes.

## Releasing

Releases are tag-driven. Bump `app/package.json`, commit, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The release workflow re-runs every check, publishes the GitHub Release (zips + checksums) and deploys Pages. Do not tag without the user's go-ahead.
