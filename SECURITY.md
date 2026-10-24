# Security

## Reporting a vulnerability

Please report security problems privately through **GitHub Security Advisories** ("Report a vulnerability" on the Security tab), not in public issues. Include steps to reproduce and the impact you expect. You should get an acknowledgement within a few days.

## Threat model

### What Veil protects against

| Adversary | Protection |
|---|---|
| **Network observer** (Wi-Fi, ISP, backbone) | Two encryption layers: WebRTC DTLS, then Veil's AES-256-GCM session encryption. |
| **"Harvest now, decrypt later"** with a future quantum computer | Session keys come from X25519 **and** ML-KEM-768. An attacker has to break both. |
| **Signaling man-in-the-middle** (someone alters the invite or reply in transit) | The handshake transcript includes both DTLS certificate fingerprints and is signed by both identity keys. Swapped certificates or identities make verification fail. Identity keys inside codes pin the peer. Safety numbers detect substitution on first contact. |
| **Infrastructure operators** (STUN/TURN) | They never see plaintext or keys. STUN learns IP addresses only. TURN relays ciphertext only. |
| **Later key compromise** | Ephemeral session keys and per-message key ratcheting mean a stolen device does not reveal past sessions' traffic. |
| **Tampering, replay, reordering** | AEAD with strict sequence numbers. Any failure tears down the session. Files are SHA-256 verified end to end. |
| **Device theft while locked** | All data is encrypted at rest. The passphrase is stretched with PBKDF2-SHA-256 (600,000 iterations). Lookup keys are HMAC tags, so even contact identifiers are not visible. |
| **XSS / script injection** | Strict CSP (`default-src 'none'`, `script-src 'self'`), Trusted Types enforced, no `innerHTML`, no inline scripts or styles, no third-party code. Only inert media types render inline. Everything else downloads as `application/octet-stream`. |
| **Notification leaks** | OS notifications never include message content or names. |

### What Veil does not protect against

- **A compromised device or browser.** Malware, malicious extensions, or someone with your unlocked device can read what you can read.
- **Metadata visible to the network.** Your peer, STUN servers and observers can see your IP address and when you are connected. Use a VPN or Tor-capable TURN setup if this matters to you.
- **The hosting origin.** The app is served from GitHub Pages. Whoever controls that origin could ship modified code, as with any web app. A service worker caches the app for offline use. For the strongest guarantees, build from source and self-host, or pin a reviewed release.
- **Weak passphrases.** PBKDF2 slows guessing but cannot save a short passphrase. Veil requires at least 10 characters and a minimum strength.
- **Unverified first contact.** If you never compare safety numbers and the invite channel was compromised, an active attacker could sit in the middle from the start (trust on first use).
- **Screenshots and the other person.** End-to-end encryption ends at the other person's screen.

### Known limitations

- No independent audit yet.
- JavaScript cannot guarantee secrets are wiped from memory. Veil zeroes buffers where it can and keeps long-term private keys as non-extractable `CryptoKey`s while unlocked.
- Disappearing messages are enforced by both Veil apps, but a modified client could ignore them.
- Message counts per conversation are visible in IndexedDB (as opaque encrypted records).

## Cryptographic details

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#protocol).
