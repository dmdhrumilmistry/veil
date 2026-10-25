import { useState } from 'preact/hooks';
import { pollMailbox, removeMailbox, setMailboxPush, setupMailbox } from '../state/app';
import { notifyPermission, requestNotifyPermission } from '../state/notify';
import { toast, useApp } from '../state/store';
import { Icon } from './icons';

const DEPLOY_DOCS = 'https://github.com/dmdhrumilmistry/veil/blob/main/relay/README.md';

/** Settings card: offline messages through a self-hosted mailbox relay. */
export function MailboxCard() {
  const { mailbox, mailboxError } = useApp();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    } finally {
      setBusy(false);
    }
  };

  const togglePush = (on: boolean) =>
    run(async () => {
      if (on && (await requestNotifyPermission()) !== 'granted') throw new Error('Allow notifications first');
      await setMailboxPush(on);
    }, on ? 'This device will be woken when mail arrives' : undefined);

  return (
    <div class="card" id="mailbox">
      <div class="card-head">
        <span class="card-icon"><Icon name="mail" size={18} /></span>
        <div>
          <h4>Offline messages</h4>
          <p class="small muted">{mailbox ? `Mailbox on ${new URL(mailbox.relay).host}` : 'Off - contacts can only reach you while you are online'}</p>
        </div>
      </div>

      {!mailbox ? (
        <form class="stack" onSubmit={(e) => { e.preventDefault(); void run(() => setupMailbox(url), 'Mailbox ready. Contacts learn about it the next time you connect.'); }}>
          <p class="muted small">
            A mailbox relay holds end-to-end encrypted messages while you are offline. It only ever sees padded ciphertext - no names, no contacts, no content. Run your own in a minute with Docker, or use one you trust.
          </p>
          <div class="field">
            <label for="mb-url">Relay address</label>
            <div class="input-row">
              <input id="mb-url" inputMode="url" autoComplete="off" spellcheck={false} placeholder="https://relay.example.com" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
              <button class="btn primary sm" disabled={!url.trim() || busy}>{busy ? 'Connecting...' : 'Set up'}</button>
            </div>
          </div>
          <a class="link-btn left" href={DEPLOY_DOCS} target="_blank" rel="noopener noreferrer">How to run a relay</a>
        </form>
      ) : (
        <>
          {mailboxError ? (
            <div class="callout warn"><Icon name="alert" size={18} /><span>{mailboxError}</span></div>
          ) : (
            <p class="muted small"><Icon name="shieldCheck" size={14} /> Contacts you connect with can message you while you are away. Messages are fetched and deleted from the relay as soon as you open Veil.</p>
          )}
          <label class="toggle">
            <input type="checkbox" checked={mailbox.push} disabled={busy || notifyPermission() === 'unsupported' || notifyPermission() === 'needs-install'} onChange={(e) => void togglePush(e.currentTarget.checked)} />
            <span>Wake this device when mail arrives <small class="muted">(push, no content)</small></span>
          </label>
          {notifyPermission() === 'needs-install' && <small class="muted">On iPhone and iPad, install Veil to the Home Screen to receive push.</small>}
          <div class="row wrap">
            <button class="btn ghost sm" disabled={busy} onClick={() => void run(pollMailbox, 'Mailbox checked')}>Check now</button>
            {confirmRemove ? (
              <>
                <button class="btn ghost sm" onClick={() => setConfirmRemove(false)}>Keep</button>
                <button class="btn danger sm" disabled={busy} onClick={() => void run(removeMailbox, 'Mailbox removed')}>Remove mailbox</button>
              </>
            ) : (
              <button class="btn ghost sm danger-text" onClick={() => setConfirmRemove(true)}>Remove</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
