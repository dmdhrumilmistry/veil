import { useState } from 'preact/hooks';
import { reconnectRelays, setRelays, setRelaysEnabled } from '../state/app';
import { toast, useApp } from '../state/store';
import { DEFAULT_RELAYS } from '../net/nostr';
import { Icon } from './icons';

/** Settings card: public Nostr relays used as encrypted, untrusted pipes. */
export function RelaysCard() {
  const { settings, relayStatus } = useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(settings.relays.join('\n'));
  const [busy, setBusy] = useState(false);
  const open = relayStatus.filter((r) => r.state === 'open').length;

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

  return (
    <div class="card" id="relays">
      <div class="card-head">
        <span class="card-icon"><Icon name="globe" size={18} /></span>
        <div>
          <h4>Public relays</h4>
          <p class="small muted">
            {!settings.useRelays ? 'Off - peer-to-peer only, connect with one-time codes' : open ? `Connected to ${open} of ${relayStatus.length} relays` : 'Connecting...'}
          </p>
        </div>
      </div>

      <label class="toggle">
        <input type="checkbox" checked={settings.useRelays} disabled={busy} onChange={(e) => void run(() => setRelaysEnabled(e.currentTarget.checked))} />
        <span>Invite links, offline messages and one-tap reconnect</span>
      </label>
      <p class="muted small">
        Uses independent public Nostr relays as delivery pipes. Everything is end-to-end encrypted and padded before it leaves your device, and each message is signed by a throwaway key, so relays cannot read anything or tell who sent it. They can see your IP address and when your anonymous mailbox receives something.
      </p>

      <>
        {settings.useRelays && (
          <ul class="relay-list" aria-label="Relay status">
            {relayStatus.map((r) => (
              <li>
                <span class={`dot ${r.state}`} aria-hidden="true" />
                <span class="grow">{r.url.replace(/^wss?:\/\//, '')}</span>
                <small class="muted">{r.state === 'open' ? 'connected' : r.state}</small>
              </li>
            ))}
          </ul>
        )}
          {editing ? (
            <div class="stack">
              <div class="field">
                <label for="relay-list">Relays (wss://, one per line, up to 6)</label>
                <textarea id="relay-list" rows={4} spellcheck={false} value={text} onInput={(e) => setText(e.currentTarget.value)} />
                <small>Contacts learn your new list the next time you are in touch.</small>
              </div>
              <div class="row wrap">
                <button class="btn ghost sm" onClick={() => { setText(DEFAULT_RELAYS.join('\n')); }}>Restore defaults</button>
                <button class="btn ghost sm" onClick={() => { setEditing(false); setText(settings.relays.join('\n')); }}>Cancel</button>
                <button class="btn primary sm" disabled={busy} onClick={() => void run(() => setRelays(text.split(/\s+/)), 'Relays updated').then(() => setEditing(false))}>Save</button>
              </div>
            </div>
          ) : (
            <div class="row wrap">
              <button class="btn ghost sm" onClick={() => setEditing(true)}>Edit relays</button>
              {settings.useRelays && <button class="btn ghost sm" onClick={reconnectRelays}>Reconnect</button>}
            </div>
          )}
      </>
    </div>
  );
}
