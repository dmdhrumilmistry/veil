<p align="center">
  <img src="site/favicon.svg" width="72" alt="Veil logo" />
</p>

<h1 align="center">Veil</h1>

<p align="center">
  Private peer-to-peer chat and file sharing with post-quantum end-to-end encryption.<br/>
  No accounts. No phone numbers. No servers of our own: everything stays on your devices.<br/>
  Invite links and offline messages ride public Nostr relays as encrypted, unlinkable blobs.
</p>

<p align="center">
  <a href="https://dmdhrumilmistry.github.io/veil/">Website</a> -
  <a href="https://dmdhrumilmistry.github.io/veil/app/">Open the app</a> -
  <a href="docs/ARCHITECTURE.md">Architecture</a> -
  <a href="SECURITY.md">Security</a>
</p>

---

## What it is

Veil is an installable web app (PWA) that runs on desktop, Android, iOS and tablets. Two devices connect **directly** over WebRTC data channels and talk through a layered, authenticated, end-to-end encrypted protocol. There is no backend of our own. For invite links and offline messages, Veil uses existing public Nostr relays purely as untrusted pipes, and you can switch them off.

| | |
|---|---|
| **Transport** | WebRTC data channels (DTLS 1.2+/SCTP), one channel for chat and one for bulk file data so chat never waits behind a transfer |
| **Key exchange** | Hybrid **X25519 + ML-KEM-768** (FIPS 203), mutually authenticated with **Ed25519** signatures over the full transcript and bound to the DTLS certificate fingerprints |
| **Message encryption** | **AES-256-GCM** with a fresh key per message from a Signal-style HMAC KDF chain, which gives forward secrecy |
| **Verification** | 60-digit safety numbers plus QR, identity pinning from invite codes, and warnings when a key changes |
| **Storage** | IndexedDB, every record sealed with AES-256-GCM under a random master key wrapped by **PBKDF2-SHA-256 (600k)**. Lookup keys are HMAC tags, never plaintext ids |
| **Offline messages** | Over public **Nostr** relays: Signal **Double Ratchet** encrypted (seeded from the post-quantum handshake), padded, and wrapped in gift-wrap events signed by a throwaway key each time. Relays see only ciphertext addressed to a pseudonymous mailbox key, never content or senders |
| **Backups** | Optional encrypted `.veilbackup` file (AES-256-GCM, PBKDF2-SHA-256 600k, authenticated records with truncation detection) for moving devices or recovering after a forgotten passphrase |
| **Files** | Any size up to 4 GB, streamed in encrypted 64 KiB frames with backpressure, stored in 1 MiB sealed chunks, SHA-256 verified on arrival |
| **Hardening** | Strict CSP, Trusted Types, no third-party scripts, no analytics, no inline code, pinned dependencies, pinned CI actions |

## How connecting works

Without a server, the two devices exchange connection details out of band:

1. **Alice** taps *New chat*. Veil creates a one-time invite (link + QR).
2. **Bob** opens the link or scans the QR. His Veil creates a **reply** code.
3. Bob sends the reply back over any channel. Alice pastes it, or opens the reply link and it is handed to her open Veil tab automatically.
4. The devices connect directly, run the authenticated handshake, and the chat opens. They can compare **safety numbers** to rule out interception.

Codes carry the sender's public identity key, so if you exchange them in person (QR) the handshake is pinned and a man-in-the-middle is impossible. Each new session needs a fresh invite because there is no server to meet at. That is the cost of having no server.

**NAT traversal:** public STUN servers (Google and Cloudflare by default) only help each device learn its public address. They never see content, and you can turn them off. Very strict networks (symmetric NAT, some corporate or mobile carriers) need a TURN relay, which you can add in Settings. A TURN relay only ever sees ciphertext.

## Repository layout

```
app/                 The Veil PWA (TypeScript + Preact + Vite)
  src/crypto/        Primitives, handshake, KDF chains, identity and safety numbers
  src/net/           WebRTC peer setup, out-of-band signaling codes, encrypted session
  src/storage/       IndexedDB, the encrypted vault, and the typed repository
  src/state/         App controller (sessions, transfers, auto-lock) and reactive store
  src/ui/            Components
  test/              Unit tests (handshake, tamper/replay rejection, MITM detection, ...)
  e2e/               Two-browser end-to-end test over a real WebRTC connection
site/                Marketing website (static, no build step)
docs/                Architecture and threat model
```

## Invite links (no codes to send back)

**New chat** gives you one short link that works for 7 days for one person. Share it any way you like and go offline. When they open it and tap Connect, both apps find each other through public Nostr relays and connect on their own the next time you are both online. Existing contacts reconnect with one tap, or automatically when you open their chat. There are no codes at all.

## Offline messages

When a contact is offline, your message is Double Ratchet encrypted, sealed in a padded envelope, and published to their relays as a gift-wrap event signed by a throwaway key. Relays hold only ciphertext and drop it after 30 days. Their Veil picks it up the moment it is open, and receipts and replies come back the same way. Files still need a live connection.

**No servers of our own, and no setup:** every user gets a pseudonymous mailbox key automatically, and contacts learn it during their first live connection. The relays you use are listed in **Settings → Public relays** (defaults: nos.lol, relay.primal.net, nostr.mom, relay.damus.io; edit freely). Turn the switch off to stay purely peer-to-peer with one-time codes.

**Limits:**
- Relays can see IP addresses and timing (not content).
- Delivery is best-effort, since relays are run by third parties.
- Background notifications only work while Veil is running, because push notifications would require a server of our own.

## Develop

```bash
cd app
npm ci
npm run dev          # http://localhost:5173
npm test             # unit tests
npm run build        # production build with CSP injected
npm run test:e2e     # real browsers + an in-process Nostr relay: chat, files, offline mail, invites, backup/restore
npm run test:e2e:public   # same scenarios over real public relays (manual, needs internet)
```

The E2E tests need `npx playwright install chromium`. Node 24+ is required.

Pushing to `main` runs CI (audit, typecheck, unit tests, build, two-browser E2E).

## Releasing

Releases are tag-driven (`.github/workflows/release.yml`):

```bash
cd app && npm version 0.3.0 --no-git-tag-version && cd ..   # bump app/package.json
git commit -am "Release v0.3.0" && git push
git tag v0.3.0 && git push origin v0.3.0
```

The tag must match `app/package.json`. The workflow re-runs every check, then:

- publishes a **GitHub Release** with `veil-app-vX.Y.Z.zip` (self-hostable app), `veil-website-and-app-vX.Y.Z.zip`, `SHA256SUMS.txt` and auto-generated notes
- signs **build provenance** (once the repo is public; GitHub does not offer it for personal private repos), so anyone can verify a zip came from this repo's CI: `gh attestation verify veil-app-vX.Y.Z.zip --repo dmdhrumilmistry/veil`
- deploys to **GitHub Pages**. Tags with a suffix (`v1.0.0-rc.1`) become pre-releases and are not deployed.

Installed apps pick up the new version on their next launch (the service worker cache is versioned per build). To roll back, run the **Redeploy GitHub Pages** workflow manually with an older tag.

## Status

This is early software and has not had an independent security audit. The cryptography uses standard, well-reviewed primitives (WebCrypto plus the audited `@noble` libraries) composed in a documented way, but do not rely on it where your safety depends on it until it has been reviewed. See [SECURITY.md](SECURITY.md) for the threat model and known limitations.

## License

MIT
