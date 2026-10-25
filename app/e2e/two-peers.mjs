/**
 * End-to-end test: two isolated browser profiles onboard, connect over a real WebRTC
 * link using only copy/paste signaling, exchange messages and a file, and verify the
 * strict CSP produced no violations. Run after `npm run build`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { startNostrRelay } from './nostr-relay.mjs';
import { chromium } from 'playwright';

const PORT = 4200 + Math.floor(Math.random() * 700);
const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS_DIR;
const PASS = 'correct horse battery staple';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });

// A local Nostr relay standing in for the public relays (CI never touches the internet).
const RELAY_PORT = PORT + 1000;
const nostr = startNostrRelay(RELAY_PORT);
// RELAY_URLS="wss://a wss://b" runs the same scenarios over real public relays instead.
const PUBLIC = (process.env.RELAY_URLS ?? '').split(/\s+/).filter(Boolean);
const RELAY = PUBLIC.length ? PUBLIC.join('\n') : nostr.url;
const fail = (msg) => {
  console.error('FAIL:', msg);
  server.kill('SIGKILL');
  process.exit(1);
};
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
  server.on('exit', () => reject(new Error('preview server exited')));
  setTimeout(() => reject(new Error('preview server timeout')), 20000);
});

const browser = await chromium.launch({
  channel: 'chromium', // full browser: headless-shell has no notification support
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream'],
});
const problems = [];

async function peer(name, viewport) {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write', 'notifications'] });
  // Force the download path; the native save picker cannot be driven headlessly.
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy|TrustedHTML|Trusted Type/i.test(m.text())) problems.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  await page.goto(BASE);
  const start = page.getByRole('button', { name: 'Get started' });
  if (!(await start.waitFor({ timeout: 15000 }).then(() => true, () => false))) {
    // Diagnose rather than hide: log what the page shows, then retry the load once.
    console.warn(`WARN ${name}: app did not render in 15s; page shows: ${JSON.stringify((await page.locator('body').innerText()).slice(0, 200))}`);
    await page.reload();
  }
  await start.click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await page.getByLabel('Confirm passphrase').fill(PASS);
  // Start peer-to-peer only; tests opt in to the local relay explicitly.
  await page.getByRole('checkbox', { name: /^Invite links and offline messages via public relays/ }).uncheck();
  await page.getByRole('button', { name: 'Create encrypted vault' }).click();
  await page.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20000 });
  return page;
}

async function useRelay(page, { fromChat, back }) {
  if (fromChat) await page.getByRole('button', { name: 'Back to chats' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Edit relays' }).click();
  await page.getByLabel(/^Relays \(wss/).fill(RELAY);
  await page.locator('#relays').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('checkbox', { name: /^Invite links, offline messages and one-tap reconnect/ }).click();
  await page.getByText(new RegExp(`Connected to [1-9] of ${PUBLIC.length || 1} relays`)).waitFor({ timeout: 30000 });
  // Keep the scripted scenarios deterministic: no automatic knocking in the background.
  await page.getByRole('checkbox', { name: /^Connect automatically/ }).uncheck();
  if (back) await page.getByRole('button', { name: 'Back', exact: true }).click();
}

const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
const shot = async (page, file) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${file}` });
};

try {
  const alice = await peer('Alice', { width: 1360, height: 860 });
  const bob = await peer('Bob', { width: 390, height: 844 });
  await shot(alice, 'desktop-welcome.png');

  // Alice creates an invite.
  await alice.getByRole('button', { name: 'New chat' }).click();
  await alice.getByRole('button', { name: 'Copy code' }).click();
  const offer = await clip(alice);
  if (!offer.startsWith('VEIL1O.')) fail(`unexpected offer code: ${offer.slice(0, 20)}`);
  console.log(`offer code: ${offer.length} chars`);
  await shot(alice, 'desktop-invite.png');

  // Bob pastes it.
  await bob.getByRole('button', { name: 'Join' }).click();
  await bob.getByLabel('Invite link or code').fill(offer);
  await bob.getByRole('button', { name: 'Continue' }).click();
  await bob.getByRole('button', { name: 'Copy code' }).click();
  const answer = await clip(bob);
  if (!answer.startsWith('VEIL1A.')) fail('unexpected answer code');
  console.log(`answer code: ${answer.length} chars`);
  await shot(bob, 'mobile-reply.png');

  // Alice completes the connection.
  await alice.getByLabel('Their reply code').fill(answer);
  await alice.getByRole('button', { name: 'Connect', exact: true }).click();
  await alice.getByText('End-to-end encrypted', { exact: true }).waitFor({ timeout: 20000 });
  await bob.getByText('End-to-end encrypted', { exact: true }).waitFor({ timeout: 20000 });
  console.log('connected + handshake verified');

  // Both point Veil at the (local) relay while connected, so mailbox cards travel live.
  await useRelay(alice, { fromChat: false, back: false });
  await useRelay(bob, { fromChat: true, back: true });
  await alice.getByRole('button', { name: /Bob/ }).first().click();
  await bob.getByRole('button', { name: /Alice/ }).first().click();
  console.log('relay transport enabled (local Nostr relay)');

  // Messages both ways.
  await alice.getByLabel('Message', { exact: true }).fill('Hello Bob, this never touches a server');
  await alice.keyboard.press('Enter');
  await bob.getByText('Hello Bob, this never touches a server').waitFor();
  await bob.getByLabel('Message', { exact: true }).fill('Hi Alice! Post-quantum and peer-to-peer');
  await bob.keyboard.press('Enter');
  await alice.getByText('Hi Alice! Post-quantum and peer-to-peer').waitFor();
  await alice.getByLabel('Read').first().waitFor({ timeout: 5000 });
  console.log('messages + read receipts ok');

  // Notifications: Bob enables them, backgrounds Veil, Alice writes.
  await bob.getByRole('button', { name: 'Back to chats' }).click();
  await bob.getByRole('button', { name: 'Settings' }).click();
  await bob.getByText('Notify me about new messages and files').click();
  await bob.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await alice.getByLabel('Message', { exact: true }).fill('secret notification test');
  await alice.keyboard.press('Enter');
  let notes = [];
  for (let i = 0; i < 50 && !notes.length; i++) {
    notes = await bob.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return ((await reg?.getNotifications()) ?? []).map((n) => ({ title: n.title, body: n.body }));
    });
    if (!notes.length) await bob.waitForTimeout(200);
  }
  if (!notes.length) fail('no notification shown');
  if (JSON.stringify(notes).includes('secret')) fail('notification leaked message content');
  if (notes[0].title !== 'Veil' || notes[0].body !== 'New message') fail(`unexpected notification ${JSON.stringify(notes)}`);
  if (!(await bob.title()).startsWith('(1)')) fail(`unread count missing from title: ${await bob.title()}`);
  await bob.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await bob.getByRole('button', { name: 'Back', exact: true }).click();
  await bob.getByRole('button', { name: /Alice/ }).first().click();
  await bob.getByText('secret notification test').waitFor();
  let left = -1;
  for (let i = 0; i < 25 && left !== 0; i++) {
    left = await bob.evaluate(async () => ((await (await navigator.serviceWorker.getRegistration())?.getNotifications()) ?? []).length);
    if (left) await bob.waitForTimeout(200);
  }
  if (left !== 0) fail('notification not cleared after opening chat');
  console.log('notifications ok (no content, unread badge, cleared on open)');

  // File transfer (auto-accepted under the 25 MB default).
  const size = Number(process.env.SIZE_MB || 3) * 1024 * 1024 + 12345;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  await alice.locator('input[type=file]').setInputFiles({ name: 'report.bin', mimeType: 'application/octet-stream', buffer: buf });
  await bob.locator('.file-card.transferring').waitFor({ timeout: 30000 });
  const t0 = Date.now();
  await bob.locator('.file-card.done').waitFor({ timeout: 60000 });
  await alice.locator('.file-card.done').waitFor({ timeout: 30000 });
  const ms = Date.now() - t0;
  console.log(`file transfer ok (${(size / 1024 / 1024).toFixed(1)} MB in ${ms} ms = ${(size / 1048576 / (ms / 1000)).toFixed(1)} MB/s, SHA-256 verified)`);

  // Bob saves the file and we compare bytes.
  const [dl] = await Promise.all([bob.waitForEvent('download'), bob.getByRole('button', { name: 'Save' }).click()]);
  const path = await dl.path();
  if (!readFileSync(path).equals(buf)) fail('downloaded file differs');
  console.log('downloaded bytes match');

  await shot(alice, 'desktop-chat.png');
  await shot(bob, 'mobile-chat.png');
  await bob.getByRole('button', { name: 'Contact info' }).first().click();
  await bob.getByText('Safety number').waitFor();
  const digitsA = await (async () => {
    await alice.getByRole('button', { name: 'Contact info' }).first().click();
    return alice.locator('.safety-grid').innerText();
  })();
  const digitsB = await bob.locator('.safety-grid').innerText();
  if (digitsA.replace(/\s/g, '') !== digitsB.replace(/\s/g, '')) fail('safety numbers differ');
  console.log('safety numbers match');
  await shot(bob, 'mobile-safety.png');

  // Lock, then unlock and confirm history decrypts from disk.
  await alice.getByRole('button', { name: 'Back', exact: true }).click();
  await alice.getByRole('button', { name: 'Lock now' }).click();
  await alice.getByRole('heading', { name: 'Veil is locked' }).waitFor();
  await shot(alice, 'desktop-lock.png');
  await alice.getByPlaceholder('Passphrase').fill('wrong passphrase!');
  await alice.getByRole('button', { name: 'Unlock' }).click();
  await alice.getByText('Incorrect passphrase').waitFor();
  await alice.getByPlaceholder('Passphrase').fill(PASS);
  await alice.getByRole('button', { name: 'Unlock' }).click();
  await alice.getByRole('button', { name: /Bob/ }).first().click();
  await alice.getByText('Hello Bob, this never touches a server').waitFor();
  console.log('lock/unlock + encrypted history ok');

  // Encrypted backup from Alice, restored onto a brand-new device.
  const BK = 'backup passphrase 2026!';
  await alice.getByRole('button', { name: 'Settings' }).click();
  await alice.getByRole('button', { name: 'Create backup' }).click();
  await alice.getByLabel('Backup passphrase').fill(BK);
  await alice.getByLabel('Confirm').fill(BK);
  const [bk] = await Promise.all([alice.waitForEvent('download', { timeout: 60000 }), alice.locator('dialog').getByRole('button', { name: 'Create backup' }).click()]);
  const bkPath = await bk.path();
  if (!bk.suggestedFilename().endsWith('.veilbackup')) fail('unexpected backup name');
  const bkBytes = readFileSync(bkPath);
  if (bkBytes.includes(Buffer.from('Hello Bob')) || bkBytes.includes(Buffer.from('Alice'))) fail('plaintext in backup file');
  await alice.getByRole('button', { name: 'Done' }).click();
  await alice.getByText('Last backup today').waitFor();
  console.log(`backup ok (${(bkBytes.length / 1024 / 1024).toFixed(1)} MB, no plaintext)`);
  await shot(alice, 'desktop-settings.png');

  const carolCtx = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  const carol = await carolCtx.newPage();
  carol.on('pageerror', (e) => problems.push(`Carol pageerror: ${e.message}`));
  await carol.goto(BASE);
  await carol.getByRole('button', { name: 'Restore from a backup' }).click();
  await carol.locator('input[type=file]').setInputFiles(bkPath);
  await carol.getByLabel('Backup passphrase').fill('definitely wrong passphrase');
  await carol.getByRole('button', { name: 'Unlock backup' }).click();
  await carol.getByText('Incorrect backup passphrase').waitFor({ timeout: 30000 });
  await carol.getByLabel('Backup passphrase').fill(BK);
  await carol.getByRole('button', { name: 'Unlock backup' }).click();
  await carol.getByText('Backup verified').waitFor({ timeout: 60000 });
  await shot(carol, 'restore-summary.png');
  await carol.getByRole('button', { name: 'Restore', exact: true }).click();
  await carol.getByRole('button', { name: /Bob/ }).first().waitFor({ timeout: 60000 });
  await carol.getByRole('button', { name: /Bob/ }).first().click();
  await carol.getByText('Hello Bob, this never touches a server').waitFor();
  await carol.locator('.file-card.done').first().waitFor();
  // The restored device unlocks with the backup passphrase and has Alice's identity.
  await carol.getByRole('button', { name: 'Lock now' }).click();
  await carol.getByPlaceholder('Passphrase').fill(BK);
  await carol.getByRole('button', { name: 'Unlock' }).click();
  await carol.getByRole('button', { name: /Bob/ }).first().waitFor();
  console.log('restore onto new device ok (identity, contacts, messages, files)');
  await shot(carol, 'restored-desktop.png');

  // Single active window: a second tab in the same browser (shared storage) must not
  // run alongside the first; taking over moves Veil cleanly.
  const alice2 = await alice.context().newPage();
  await alice2.goto(BASE);
  await alice2.getByRole('heading', { name: 'Veil is open in another window' }).waitFor();
  await alice2.getByRole('button', { name: 'Use Veil here' }).click();
  await alice.getByRole('heading', { name: 'Veil moved to another window' }).waitFor({ timeout: 10000 });
  await alice2.getByPlaceholder('Passphrase').fill(PASS);
  await alice2.getByRole('button', { name: 'Unlock' }).click();
  await alice2.getByRole('button', { name: /Bob/ }).first().waitFor();
  await shot(alice, 'elsewhere.png');
  // ...and back again.
  await alice.getByRole('button', { name: 'Use Veil here' }).click();
  await alice2.getByRole('heading', { name: 'Veil moved to another window' }).waitFor({ timeout: 10000 });
  await alice.getByRole('heading', { name: 'Veil is locked' }).waitFor();
  console.log('single active window handover ok');

  // Offline delivery: Alice and Bob are no longer connected (Alice locked earlier).
  await alice.getByPlaceholder('Passphrase').fill(PASS);
  await alice.getByRole('button', { name: 'Unlock' }).click();
  await alice.getByRole('button', { name: /Bob/ }).first().click();
  await alice.getByText('Bob is offline').waitFor();
  await alice.getByLabel('Message', { exact: true }).fill('sent while you were away');
  await alice.keyboard.press('Enter');
  // Queued on the relay (or already delivered: relay subscriptions are instant).
  await alice.locator('.msg.out', { hasText: 'sent while you were away' }).locator('.status.queued, .status.delivered, .status.read').waitFor({ timeout: 15000 });
  // Everything the relay holds: random signer keys, an opaque mailbox key, padded ciphertext.
  const relayBytes = PUBLIC.length ? Buffer.alloc(0) : Buffer.concat(nostr.events.map((e) => Buffer.concat([Buffer.from(JSON.stringify(e)), Buffer.from(e.content, 'base64url')])));
  if (['sent while you were away', 'Alice', 'Bob'].some((w) => relayBytes.includes(Buffer.from(w)))) fail('plaintext on the relay');
  if (!PUBLIC.length && new Set(nostr.events.map((e) => e.pubkey)).size !== nostr.events.length) fail('relay events share a signing key (sender linkable)');
  await shot(alice, 'offline-queued.png');
  // Bob comes back to the conversation.
  const wake = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // Wait for relay delivery (instant while subscribed; the nudge is harmless).
  const arrives = async (page, locator, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await locator.isVisible().catch(() => false)) return;
      await wake(page);
      await page.waitForTimeout(500);
    }
    await locator.waitFor({ timeout: 1000 });
  };
  await bob.getByRole('button', { name: 'Back', exact: true }).click();
  await arrives(bob, bob.locator('p.text', { hasText: 'sent while you were away' }));
  await shot(bob, 'offline-received.png');
  // Bob's read receipt travels back through Alice's mailbox.
  await arrives(alice, alice.locator('.msg.out.last', { hasText: 'sent while you were away' }).getByLabel('Read'));
  // ...and Bob can reply while Alice is "away" too.
  await bob.getByLabel('Message', { exact: true }).fill('got it, replying offline');
  await bob.keyboard.press('Enter');
  await bob.locator('.msg.out', { hasText: 'got it, replying offline' }).locator('.status.queued, .status.delivered, .status.read').waitFor({ timeout: 15000 });
  await arrives(alice, alice.locator('p.text', { hasText: 'got it, replying offline' }));
  console.log(PUBLIC.length ? `offline messages via public relays ok (${PUBLIC.join(', ')})` : `offline messages via relay ok (queued, delivered, read receipt, reply; relay held ${nostr.events.length} events: ciphertext only, unlinkable signers)`);

  // One-tap reconnect through the mailboxes: no codes. Bob is looking at Alice's chat.
  await alice.getByRole('button', { name: 'Connect', exact: true }).click();
  await arrives(bob, bob.getByText('End-to-end encrypted', { exact: true }), 30000);
  await arrives(alice, alice.getByText('End-to-end encrypted', { exact: true }), 30000);
  console.log('one-tap reconnect via relay ok (no codes)');

  // Invite link: Alice shares a link and goes away; Dave (no mailbox) accepts it later.
  await alice.getByRole('button', { name: 'New chat' }).click();
  await alice.getByText('Your invite link is ready').waitFor();
  await alice.getByRole('button', { name: 'Copy link' }).click();
  const inviteLink = await clip(alice);
  if (!inviteLink.includes('#VEIL3I.')) fail(`unexpected invite link ${inviteLink.slice(0, 60)}`);
  console.log(`invite link: ${inviteLink.length} chars`);
  await shot(alice, 'invite-link.png');
  await alice.getByRole('button', { name: 'Done' }).click();
  await alice.getByRole('button', { name: 'Lock now' }).click();
  await alice.getByRole('heading', { name: 'Veil is locked' }).waitFor();

  const dave = await peer('Dave', { width: 390, height: 844 });
  await useRelay(dave, { fromChat: false, back: true });
  await dave.goto(inviteLink);
  await dave.getByRole('heading', { name: 'Alice invited you to chat' }).waitFor({ timeout: 15000 });
  await shot(dave, 'invite-confirm.png');
  await dave.getByRole('button', { name: 'Connect', exact: true }).click();
  await dave.getByRole('heading', { name: /Asking Alice to connect/ }).waitFor({ timeout: 15000 });
  await shot(dave, 'invite-requested.png');
  // Alice comes back: her Veil finds the join note and the two devices meet on their own.
  await alice.getByPlaceholder('Passphrase').fill(PASS);
  await alice.getByRole('button', { name: 'Unlock' }).click();
  await arrives(dave, dave.getByText('End-to-end encrypted', { exact: true }), 45000);
  await alice.getByRole('button', { name: /Dave/ }).first().waitFor({ timeout: 15000 });
  await dave.getByLabel('Message', { exact: true }).fill('joined from a link, no codes');
  await dave.keyboard.press('Enter');
  await alice.getByRole('button', { name: /Dave/ }).first().click();
  await alice.locator('p.text', { hasText: 'joined from a link, no codes' }).waitFor({ timeout: 15000 });
  console.log('invite link ok (inviter offline at join time, auto-connect on return)');

  // Data at rest must not contain plaintext.
  const leaked = await alice.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('veil'); q.onsuccess = () => r(q.result); });
    const all = [];
    for (const s of db.objectStoreNames) {
      const vals = await new Promise((r) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => r(q.result); });
      all.push(...vals);
    }
    const dec = new TextDecoder();
    const text = JSON.stringify(all, (_, v) => (v instanceof Uint8Array ? dec.decode(v) : v));
    return ['Hello Bob, this never', 'Hi Alice! Post-quantum', 'report.bin'].filter((w) => text.includes(w));
  });
  if (leaked.length) fail(`plaintext found in IndexedDB: ${leaked}`);
  console.log('no plaintext at rest');

  const real = problems.filter((p) => !/favicon|session error/.test(p));
  if (real.length) fail(`console problems:\n${real.join('\n')}`);
  console.log('no CSP violations or console errors');
  console.log("\nE2E PASSED");
} catch (e) {
  console.error(problems.join('\n'));
  for (const ctx of browser.contexts()) {
    for (const pg of ctx.pages()) console.error(`page ${pg.url().slice(0, 40)} shows: ${JSON.stringify((await pg.locator('body').innerText().catch(() => '')).slice(0, 400))}`);
  }
  fail(e.stack || e.message);
} finally {
  server.kill('SIGKILL');
  await nostr.close();
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]);
}
process.exit(0);
