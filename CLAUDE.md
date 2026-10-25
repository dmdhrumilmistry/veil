# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Treat `app/src/crypto/`, `app/src/net/session.ts`, `app/src/net/mailbox.ts`, `app/src/storage/vault.ts`, `app/src/storage/backup.ts` and `relay/src/server.ts` as security-critical. Explain protocol-level changes before making them, and add negative tests.
- After UI changes, run the E2E test with `SHOTS_DIR=/tmp/veil-shots` and look at the screenshots (desktop and 390 px mobile, light theme in headless).
- The E2E test uses the full Chromium channel (the headless shell lacks notifications) and starts its own relay on a random port.
- Ask before pushing tags, changing GitHub settings, or publishing images. Those actions are outward-facing.
