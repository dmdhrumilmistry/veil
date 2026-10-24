import { useMemo, useState } from 'preact/hooks';
import { peerPub, safetyNumber, formatSafetyNumber } from '../crypto/identity';
import {
  changePassphrase,
  clearChat,
  deleteContact,
  displayName,
  lock,
  saveProfileName,
  saveSettings,
  setDisappearing,
  updateContact,
  wipeEverything,
} from '../state/app';
import { store, toast, useApp } from '../state/store';
import type { Contact } from '../storage/repo';
import { WrongPassphraseError } from '../storage/vault';
import { Avatar } from './common';
import { MIN_PASSPHRASE, strength } from './Gate';
import { Icon } from './icons';
import { InstallCard } from './Install';
import { Qr } from './Qr';

const TTL_OPTIONS: [number, string][] = [
  [0, 'Off'],
  [300, '5 minutes'],
  [3600, '1 hour'],
  [86400, '1 day'],
  [604800, '1 week'],
];

function PanelHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header class="panel-head">
      <button class="icon-btn" aria-label="Back" onClick={onBack}>
        <Icon name="back" />
      </button>
      <h2>{title}</h2>
    </header>
  );
}

export function ContactInfo({ contact }: { contact: Contact }) {
  const { myId, presence } = useApp();
  const [alias, setAlias] = useState(contact.alias ?? '');
  const [danger, setDanger] = useState<'' | 'clear' | 'delete'>('');
  const number = useMemo(() => safetyNumber(peerPub(myId), peerPub(contact.id)), [myId, contact.id]);
  const groups = formatSafetyNumber(number);

  return (
    <section class="panel" aria-label="Contact info">
      <PanelHead title="Contact info" onBack={() => store.set({ view: 'chats' })} />
      <div class="panel-scroll">
        <div class="profile-card">
          <Avatar contact={contact} size="lg" online={presence[contact.id] === 'online'} />
          <h3>{displayName(contact)}</h3>
          {contact.alias && contact.name && <p class="muted">Calls themselves "{contact.name}"</p>}
          <span class={`verify-chip ${contact.verified ? 'ok' : ''}`}>
            <Icon name={contact.verified ? 'shieldCheck' : 'shield'} size={16} />
            {contact.verified ? 'Verified' : 'Not verified'}
          </span>
        </div>

        <div class="card">
          <h4>Safety number</h4>
          <p class="muted small">
            Compare these digits with {displayName(contact)} in person or on a call. If they match on both devices, nobody is intercepting your conversation.
          </p>
          <div class="safety-grid" aria-label={`Safety number ${groups.join(' ')}`}>
            {groups.map((g) => <code>{g}</code>)}
          </div>
          <details class="qr-details">
            <summary>Show as QR</summary>
            <div class="qr-wrap sm"><Qr value={number} label="Safety number QR code" /></div>
          </details>
          <button class={`btn ${contact.verified ? 'ghost' : 'primary'}`} onClick={() => void updateContact(contact.id, { verified: !contact.verified })}>
            <Icon name="shieldCheck" size={18} /> {contact.verified ? 'Clear verification' : 'Mark as verified'}
          </button>
        </div>

        <div class="card">
          <label class="field">
            <span>Nickname</span>
            <div class="input-row">
              <input value={alias} maxLength={48} placeholder={contact.name || 'Add a nickname'} onInput={(e) => setAlias(e.currentTarget.value)} />
              <button class="btn ghost sm" disabled={alias === (contact.alias ?? '')} onClick={() => void updateContact(contact.id, { alias: alias.trim() || undefined })}>Save</button>
            </div>
          </label>
          <label class="field">
            <span><Icon name="clock" size={14} /> Disappearing messages</span>
            <select value={contact.disappearSecs} onChange={(e) => void setDisappearing(contact.id, Number(e.currentTarget.value))}>
              {TTL_OPTIONS.map(([v, l]) => <option value={v}>{l}</option>)}
            </select>
            <small>Applies to new messages on both devices.</small>
          </label>
        </div>

        <div class="card danger-zone">
          {danger ? (
            <>
              <p>{danger === 'clear' ? 'Delete all messages and files in this chat from this device?' : `Delete ${displayName(contact)} and all history from this device?`}</p>
              <div class="row">
                <button class="btn ghost sm" onClick={() => setDanger('')}>Cancel</button>
                <button class="btn danger sm" onClick={() => void (danger === 'clear' ? clearChat(contact.id).then(() => setDanger('')) : deleteContact(contact.id))}>Delete</button>
              </div>
            </>
          ) : (
            <>
              <button class="btn ghost danger-text" onClick={() => setDanger('clear')}><Icon name="trash" size={18} /> Clear chat</button>
              <button class="btn ghost danger-text" onClick={() => setDanger('delete')}><Icon name="trash" size={18} /> Delete contact</button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ChangePassphrase() {
  const [open, setOpen] = useState(false);
  const [oldP, setOld] = useState('');
  const [newP, setNew] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = newP.length >= MIN_PASSPHRASE && strength(newP).score >= 2 && !!oldP;
  if (!open) return <button class="btn ghost" onClick={() => setOpen(true)}><Icon name="lock" size={18} /> Change passphrase</button>;
  return (
    <form class="stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await changePassphrase(oldP, newP);
        toast('Passphrase changed', 'success');
        setOpen(false);
      } catch (err) {
        toast(err instanceof WrongPassphraseError ? 'Current passphrase is incorrect' : (err as Error).message, 'error');
      } finally {
        setBusy(false);
      }
    }}>
      <label class="field"><span>Current passphrase</span><input type="password" autoComplete="current-password" value={oldP} onInput={(e) => setOld(e.currentTarget.value)} /></label>
      <label class="field"><span>New passphrase</span><input type="password" autoComplete="new-password" value={newP} onInput={(e) => setNew(e.currentTarget.value)} />
        <small>{newP ? strength(newP).label : `At least ${MIN_PASSPHRASE} characters`}</small></label>
      <div class="row">
        <button type="button" class="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
        <button class="btn primary sm" disabled={!ok || busy}>{busy ? 'Re-encrypting...' : 'Change'}</button>
      </div>
    </form>
  );
}

export function SettingsPanel() {
  const { settings, profile, myId } = useApp();
  const [name, setName] = useState(profile.name);
  const [stun, setStun] = useState(settings.stunUrls.join('\n'));
  const [turn, setTurn] = useState({ url: settings.turnUrl, user: settings.turnUser, pass: settings.turnPass });
  const [wipe, setWipe] = useState(false);

  const enableNotifications = async (on: boolean) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications were blocked', 'error');
    }
    await saveSettings({ notifications: on });
  };

  return (
    <section class="panel" aria-label="Settings">
      <PanelHead title="Settings" onBack={() => store.set({ view: 'chats' })} />
      <div class="panel-scroll">
        <div class="card">
          <h4>Profile</h4>
          <label class="field">
            <span>Display name</span>
            <div class="input-row">
              <input value={name} maxLength={48} onInput={(e) => setName(e.currentTarget.value)} />
              <button class="btn ghost sm" disabled={name === profile.name} onClick={() => void saveProfileName(name).then(() => toast('Saved', 'success', 1500))}>Save</button>
            </div>
          </label>
          <div class="field">
            <span>Your identity key</span>
            <code class="key">{myId}</code>
            <small>This device's public key. It never leaves your device except inside invites you share.</small>
          </div>
        </div>

        <InstallCard />

        <div class="card">
          <h4>Appearance &amp; behaviour</h4>
          <label class="field">
            <span>Theme</span>
            <select value={settings.theme} onChange={(e) => void saveSettings({ theme: e.currentTarget.value as 'system' })}>
              <option value="system">Match system</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label class="toggle">
            <input type="checkbox" checked={settings.enterToSend} onChange={(e) => void saveSettings({ enterToSend: e.currentTarget.checked })} />
            <span>Press Enter to send</span>
          </label>
          <label class="toggle">
            <input type="checkbox" checked={settings.notifications} onChange={(e) => void enableNotifications(e.currentTarget.checked)} />
            <span>Notifications (content is never shown)</span>
          </label>
          <label class="field">
            <span>Auto-accept files up to</span>
            <select value={settings.autoAcceptMB} onChange={(e) => void saveSettings({ autoAcceptMB: Number(e.currentTarget.value) })}>
              {[0, 5, 25, 100, 500].map((v) => <option value={v}>{v === 0 ? 'Always ask' : `${v} MB`}</option>)}
            </select>
          </label>
        </div>

        <div class="card">
          <h4>Security</h4>
          <label class="field">
            <span>Auto-lock after inactivity</span>
            <select value={settings.autoLockMins} onChange={(e) => void saveSettings({ autoLockMins: Number(e.currentTarget.value) })}>
              {[1, 5, 15, 60, 240, 0].map((v) => <option value={v}>{v === 0 ? 'Never' : v < 60 ? `${v} min` : `${v / 60} h`}</option>)}
            </select>
            <small>Locking closes connections and erases keys from memory.</small>
          </label>
          <ChangePassphrase />
          <button class="btn ghost" onClick={() => lock()}><Icon name="lock" size={18} /> Lock now</button>
        </div>

        <div class="card">
          <h4>Network</h4>
          <label class="toggle">
            <input type="checkbox" checked={settings.useStun} onChange={(e) => void saveSettings({ useStun: e.currentTarget.checked })} />
            <span>Use STUN to connect across networks</span>
          </label>
          <small class="muted">
            STUN servers only tell your device its public address - they never see messages. Turn off to connect only on the same local network.
          </small>
          {settings.useStun && (
            <label class="field">
              <span>STUN servers (one per line)</span>
              <textarea rows={2} value={stun} spellcheck={false} onInput={(e) => setStun(e.currentTarget.value)} onBlur={() => void saveSettings({ stunUrls: stun.split(/\s+/).filter(Boolean) })} />
            </label>
          )}
          <details>
            <summary>Custom TURN relay (for strict networks)</summary>
            <p class="muted small">A TURN relay forwards traffic when a direct path is impossible. It only ever sees ciphertext. Use one you run or trust.</p>
            <label class="field"><span>URL</span><input value={turn.url} placeholder="turns:turn.example.com:5349" onInput={(e) => setTurn({ ...turn, url: e.currentTarget.value })} /></label>
            <label class="field"><span>Username</span><input value={turn.user} autoComplete="off" onInput={(e) => setTurn({ ...turn, user: e.currentTarget.value })} /></label>
            <label class="field"><span>Credential</span><input type="password" autoComplete="off" value={turn.pass} onInput={(e) => setTurn({ ...turn, pass: e.currentTarget.value })} /></label>
            <button class="btn ghost sm" onClick={() => void saveSettings({ turnUrl: turn.url, turnUser: turn.user, turnPass: turn.pass }).then(() => toast('TURN settings saved', 'success'))}>Save TURN</button>
          </details>
        </div>

        <div class="card danger-zone">
          <h4>Danger zone</h4>
          {wipe ? (
            <>
              <p>Permanently erase every chat, file and key on this device?</p>
              <div class="row">
                <button class="btn ghost sm" onClick={() => setWipe(false)}>Cancel</button>
                <button class="btn danger sm" onClick={() => void wipeEverything()}>Erase everything</button>
              </div>
            </>
          ) : (
            <button class="btn ghost danger-text" onClick={() => setWipe(true)}><Icon name="trash" size={18} /> Erase all data</button>
          )}
        </div>
        <p class="fine center">Veil {__APP_VERSION__} - protocol v1 - open source</p>
      </div>
    </section>
  );
}
