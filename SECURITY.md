# Security

## Reporting a vulnerability

Please report security problems privately through **GitHub Security Advisories** ("Report a vulnerability" on the Security tab), not in public issues. Include steps to reproduce and the impact you expect. You should get an acknowledgement within a few days.

## Threat model

### What Veil protects against

| Adversary | Protection |
|---|---|
| **Network observer** (Wi-Fi, ISP, backbone) | Two encryption layers: WebRTC DTLS, then Veil's AES-256-GCM session encryption. |
| **"Harvest now, decrypt later"** with a future quantum computer | Session keys come from X25519 **and** ML-KEM-768. An attacker has to break both. |
| **Intercepted invite link** (someone grabs the link and joins first) | Invites are single-use and kept as spent records until they expire. A second identity presenting the link is told it was already used, and the inviter gets a loud warning naming the contact who claimed it, with a prompt to verify their safety number. |
| **Signaling man-in-the-middle** (someone alters the invite or reply in transit) | The handshake transcript includes both DTLS certificate fingerprints and is signed by both identity keys. Swapped certificates or identities make verification fail. Identity keys inside codes pin the peer. Safety numbers detect substitution on first contact. |
| **Infrastructure operators** (STUN/TURN) | They never see plaintext or keys. STUN learns IP addresses only. TURN relays ciphertext only. |
| **Later key compromise** | Ephemeral session keys and per-message key ratcheting mean a stolen device does not reveal past sessions' traffic. |
| **Tampering, replay, reordering** | AEAD with strict sequence numbers. Any failure tears down the session. Files are SHA-256 verified end to end. |
| **Device theft (native app)** | A random 32-byte master key lives in the OS keystore (hardware-backed where available) and is released only after biometrics or the device PIN. App data is excluded from Android cloud backups. |
| **Device theft while locked** | All data is encrypted at rest. The passphrase is stretched with PBKDF2-SHA-256 (600,000 iterations). Lookup keys are HMAC tags, so even contact identifiers are not visible. |
| **XSS / script injection** | Strict CSP (`default-src 'none'`, `script-src 'self'`), Trusted Types enforced, no `innerHTML`, no inline scripts or styles, no third-party code. Only inert media types render inline. Everything else downloads as `application/octet-stream`. |
| **Public Nostr relay operators** (invite links, offline messages, reconnect; can be turned off) | See only padded ciphertext addressed to a pseudonymous mailbox key, each event signed by a fresh throwaway key, so they cannot read content or link messages to a sender. Offline messages use the Double Ratchet seeded from the post-quantum handshake, and signaling is end-to-end encrypted too. A malicious relay can drop or delay messages, but cannot forge or alter them. |
| **Backup file theft** | Backups are encrypted with AES-256-GCM under a separate passphrase (PBKDF2-SHA-256, 600k) and authenticated record by record. Tampering or truncation is detected before anything is restored. |
| **Silent message loss** (peer app killed mid-session) | Live messages require a delivery receipt; otherwise they are re-sent through the mailbox with the same id and deduplicated on arrival. |
| **Notification leaks** | OS notifications never include message content. Sender names are opt-in. Notification payloads carry a random in-memory token, never a contact id. |

### What Veil does not protect against

- **A compromised device or browser.** Malware, malicious extensions, or someone with your unlocked device can read what you can read.
- **Relay metadata.** With public relays on, relay operators can see your IP address, when your pseudonymous mailbox key receives something, roughly how much (padded sizes), and that you are subscribed. Several independent operators each see this for the relays you use. Use a VPN, or turn public relays off (peer-to-peer only), if that matters.
- **Relay availability.** Public relays are run by third parties and may go down, rate-limit or delete data early. Veil publishes to several relays and retries from an outbox, but offline delivery is best-effort.
- **Metadata visible to the network.** Your peer, STUN servers and observers can see your IP address and when you are connected. Use a VPN or Tor-capable TURN setup if this matters to you.
- **The hosting origin.** The app is served from GitHub Pages. Whoever controls that origin could ship modified code, as with any web app. A service worker caches the app for offline use. For the strongest guarantees, build from source and self-host, or pin a reviewed release.
- **Backup handling.** A backup contains your identity key. Anyone holding the file *and* its passphrase can impersonate you, so store it like a password vault export. Restoring the same backup on two devices gives both the same identity.
- **Weak passphrases.** PBKDF2 slows guessing but cannot save a short passphrase. Veil requires at least 10 characters and a minimum strength.
- **Unverified first contact.** Only the two devices that connected can read a chat, but until you compare safety numbers you cannot be sure the other device is the person you meant. If the channel you sent the invite over was compromised, an attacker could have joined in their place, or even relayed between both of you. Veil flags unverified chats, detects reused invites, and makes verification a one-tap QR scan. Verify every contact you care about.
- **Screenshots and the other person.** End-to-end encryption ends at the other person's screen.

### Known limitations

- No independent audit yet. This covers both implementations (TypeScript and Dart). Cross-implementation vectors and a live interop test keep them identical on the wire, but each still needs review.
- JavaScript cannot guarantee secrets are wiped from memory. Veil zeroes buffers where it can and keeps long-term private keys as non-extractable `CryptoKey`s while unlocked.
- Disappearing messages are enforced by both Veil apps, but a modified client could ignore them.
- Message counts per conversation are visible in IndexedDB (as opaque encrypted records).

## Cryptographic details

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#protocol).
