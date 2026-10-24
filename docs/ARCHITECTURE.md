# Veil architecture

## Goals

1. **No servers in the data path.** Messages, files and keys never touch infrastructure Veil operates. Veil operates none.
2. **Defense in depth.** Do not rely on one layer (DTLS) alone. Authenticate everything. Fail closed.
3. **Small, auditable crypto surface.** Every primitive goes through `app/src/crypto/primitives.ts`. Only WebCrypto and the audited `@noble` libraries are used.
4. **Works everywhere a modern browser runs.** Installable PWA, offline app shell, responsive from 320 px phones to 4K.

## Components

```
┌──────────────────────────── UI (Preact) ─────────────────────────────┐
│ Gate (onboarding/lock) · Sidebar · Chat · ConnectSheet · Panels       │
└──────────────┬───────────────────────────────────────────────────────┘
               │ calls functions, renders store
┌──────────────▼──────────────── state/app.ts (controller) ────────────┐
│ vault lifecycle · auto-lock · contacts · messages · file transfers   │
│ pending invite · live sessions (one per contact) · cross-tab handoff │
└───────┬────────────────────────────┬─────────────────────────────────┘
        │                            │
┌───────▼─────── storage ──────┐ ┌───▼──────────────── net ────────────────┐
│ vault.ts  PBKDF2 → master     │ │ signaling.ts  offer/answer codes        │
│           → AES record key    │ │ peer.ts       RTCPeerConnection, 2 DCs  │
│           → HMAC index key    │ │ session.ts    handshake + KDF chains    │
│ repo.ts   typed records       │ └───────────────┬─────────────────────────┘
│ idb.ts    IndexedDB           │                 │
└───────────────────────────────┘ ┌───────────────▼── crypto ───────────────┐
                                  │ handshake.ts  X25519+ML-KEM-768, Ed25519 │
                                  │ chain.ts      HMAC KDF chain, AES-GCM    │
                                  │ identity.ts   keys, safety numbers       │
                                  └──────────────────────────────────────────┘
```

## Connection setup (out-of-band signaling)

WebRTC needs the two peers to swap an SDP offer and answer. Veil packs each into a **code**:

```
VEIL1O.<base64url(deflate-raw(JSON{ v, k:"offer",  sdp, id, name, ref }))>
VEIL1A.<base64url(deflate-raw(JSON{ v, k:"answer", sdp, id, name, ref }))>
```

- `id` is the sender's Ed25519 identity public key. The receiver pins the handshake to it.
- `ref` ties a reply to the invite it answers.
- ICE gathering finishes before the code is produced (no trickle), so one message per direction is enough. Codes are about 700 characters.
- Links put the code in the URL **fragment** (`#VEIL1O...`), which browsers never send to the web server. The app removes it from history immediately.
- When the inviter opens a *reply link*, it lands in a new tab. That tab forwards the code over a same-origin `BroadcastChannel` to the tab that holds the pending `RTCPeerConnection`.
- Decoding is bounded (24 KB code, 32 KB inflated) to block decompression bombs, and every field is validated.

Two **pre-negotiated** data channels share the SCTP association: `ctrl` (id 0) for chat and control, and `bulk` (id 1) for file data.

## Protocol

### Handshake (inside the DTLS channel, before any application data)

```
I → R   HELLO { v:1, id_I, eph_I, kem_pk_I, nonce_I }
R → I   HELLO { v:1, id_R, eph_R, kem_ct_R, nonce_R, sig_R }
I → R   FIN   { sig_I }

T      = SHA-256( lp("veil/v1/handshake", fp_I, fp_R,
                     id_I, eph_I, kem_pk_I, nonce_I,
                     id_R, eph_R, kem_ct_R, nonce_R) )         lp = length-prefixed
sig_R  = Ed25519_R("veil/v1/sig/R" || T)
sig_I  = Ed25519_I("veil/v1/sig/I" || T)
ss     = X25519(eph_I, eph_R) || ML-KEM-768.Decaps(kem_ct_R)
okm    = HKDF-SHA-256(ikm = ss, salt = T, info = "veil/v1/chains", L = 128)
       = ctrl_I→R || ctrl_R→I || bulk_I→R || bulk_R→I
```

- `fp_I` and `fp_R` are the DTLS certificate fingerprints each side saw in the SDP. If the signaling was tampered with, the two sides compute different `T` and the signatures fail.
- The responder keeps its keys **pending** until FIN proves the initiator holds its identity key.
- Wrong version, wrong field lengths, invalid ML-KEM keys, all-zero X25519 output, an unexpected message order, or a peer that presents our own key all abort the handshake.
- The handshake has a 20 s timeout.

### Records

For each direction and channel there is a KDF chain:

```
mk_n   = HMAC-SHA-256(ck_n, 0x01)
ck_n+1 = HMAC-SHA-256(ck_n, 0x02)        ck_n is wiped
frame  = seq_n (u64 BE) || AES-256-GCM(key = mk_n, iv = 0^32 || seq_n, aad = label || seq_n, pt)
```

- Data channels are reliable and ordered, so the receiver requires `seq == expected`. A gap, replay or reorder kills the session.
- Labels (`veil/v1/ctrl`, `veil/v1/bulk`) stop frames from being moved across channels.
- `ctrl` plaintext is JSON. `bulk` plaintext is `fileId(16) || index(u32) || bytes`.

### Application messages (`ctrl`)

`profile`, `msg`, `receipt` (delivered/read), `typing`, `disappear`, `file-offer`, `file-accept`, `file-decline`, `file-cancel`, `file-done`. Every field is type- and length-checked. Unknown types are ignored, for forward compatibility.

### File transfer

1. Sender → `file-offer { fileId, name, size, mime }`. The receiver auto-accepts up to a configurable size (default 25 MB) or asks the user.
2. On `file-accept`, the sender streams the file. It reads 1 MiB blocks, hashes them (SHA-256), seals a local copy, and sends `bulk` frames of about 64 KiB. Sends are pipelined and bounded by an 8 MiB buffered-amount high-water mark (resuming at 1 MiB).
3. The receiver checks frame order and the announced size, hashes the data incrementally, and buffers it into 1 MiB blocks sealed into IndexedDB. Awaiting storage applies natural backpressure.
4. `file-done { sha256, size }`. The receiver waits for the bulk stream to catch up, then verifies the digest. On a mismatch the data is discarded.

## Storage

```
meta/vault  = { kdf: PBKDF2-SHA-256, iter: 600000, salt, iv, wrapped = AES-GCM(KEK, master, aad="veil/vault/v1/wrap") }
master ─HKDF→ recordKey (AES-256-GCM, non-extractable) + indexKey (HMAC)

kv/identity                    sealed { Ed25519 pub, PKCS#8 }
kv/profile, kv/settings        sealed JSON
kv/contact/<HMAC(contact id)>  sealed contact
msgs/<HMAC(chat)>/<msgId>      sealed message
chunks/<HMAC(file)>/<index>    sealed 1 MiB file block
```

Every record has a fresh 96-bit IV and uses its slot name as AAD, so records cannot be swapped. Changing the passphrase re-wraps the master key without re-encrypting data. Locking (manual, idle timeout, or `pagehide`) closes sessions, drops all keys and revokes object URLs.

## Notifications

Veil has no push server, and Web Push would need one: a server holding your push subscription and waking your device, which reveals when you get messages. So notifications are **local**. The running app raises them when a message, file or new connection arrives on a live session while Veil is not in front. That covers the cases that matter: if Veil is fully closed there is no connection, so nobody can message you.

- Shown through the service worker (`registration.showNotification`). Android browsers and installed iOS apps reject `new Notification()`. On iOS/iPadOS, notifications require Veil to be added to the Home Screen.
- **Never** includes message text. The sender's name is opt-in (`Show who it is from`), since it appears on lock screens.
- One notification per conversation (`tag`). Newer messages replace it with a count and vibrate again (`renotify`).
- The payload carries a random in-memory token, not a contact id. Tapping the notification focuses Veil and opens that chat (`notificationclick` → `postMessage`). Tokens are forgotten on lock.
- Opening a chat or returning to the app clears its notifications. The unread total shows in the tab title and as an app-icon badge (Badging API, installed apps).
- While Veil is visible but you are in another chat, an in-app toast appears instead.
- Limits: phones suspend background web apps after a while (iOS within minutes), which drops the connection, and auto-lock disconnects on purpose.

## Web platform hardening

- CSP (meta tag, since GitHub Pages cannot set headers): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types veil-sw`.
- One Trusted Types policy, which only allows the service worker URL `./sw.js`.
- `referrer: no-referrer`. No external fonts, images or scripts.
- The service worker caches only same-origin GET requests for the app shell. Navigation is network-first so updates land quickly.
- Dependencies are pinned exactly and the lockfile is committed. CI runs `npm audit`, typecheck, unit tests, a build and a two-browser E2E test. GitHub Actions are pinned by commit SHA, and Dependabot keeps them current.

## Testing

- `app/test/crypto.test.ts` covers handshake correctness, DTLS-fingerprint MITM detection, identity pinning, tampered hello, forged FIN, version and junk rejection, chain replay/reorder/tamper/cross-channel rejection, and safety number symmetry.
- `app/e2e/two-peers.mjs` covers two isolated browser profiles, onboarding, copy/paste signaling, a real WebRTC connection, messages and read receipts, a multi-MB file with a byte-exact download, matching safety numbers, lock/unlock with a wrong passphrase, a scan of IndexedDB for plaintext, and zero console or CSP errors.

## Roadmap ideas

- Voice and video calls (renegotiated over the existing authenticated channel)
- Group chats (pairwise sessions or MLS)
- Resumable transfers
- Encrypted backup/export between your own devices
- Optional self-hostable rendezvous for one-tap reconnects (it would only ever see encrypted, signed signaling blobs)
