import { useMemo, useState } from 'preact/hooks';
import { peerPub, safetyNumber, formatSafetyNumber } from '../crypto/identity';
import {
  revokeInvite,
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
import { MIN_PASSPHRASE, strength } from './passphrase';
import { Icon, Logo, type IconName } from './icons';
import { InstallCard } from './Install';
import { BackupCard } from './Backup';
import { RelaysCard } from './Mailbox';
import { notifyPermission, requestNotifyPermission, type NotifyPermission } from '../state/notify';
import { Qr } from './Qr';
import { canScan, Scanner } from './Scanner';

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
  const { myId, presence, offline } = useApp();
  const [alias, setAlias] = useState(contact.alias ?? '');
  const [danger, setDanger] = useState<'' | 'clear' | 'delete'>('');
  const [scanning, setScanning] = useState(false);
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
          <div class="row center wrap">
            <span class={`verify-chip ${contact.verified ? 'ok' : ''}`}>
              <Icon name={contact.verified ? 'shieldCheck' : 'shield'} size={16} />
              {contact.verified ? 'Verified' : 'Not verified'}
            </span>
            <span class={`verify-chip ${offline[contact.id] ? 'ok' : ''}`} title={contact.mailbox ? `Reads ${contact.mailbox.relays.length} public relays` : 'They have public relays turned off'}>
              <Icon name="mail" size={16} />
              {offline[contact.id] ? 'Offline messages on' : contact.mailbox ? 'Connect once to enable offline messages' : 'Live only'}
            </span>
          </div>
        </div>

        <div class="card">
          <h4>Safety number</h4>
          <p class="muted small">
            Compare these digits with {displayName(contact)} in person or on a call, or scan each other's QR code. If they match, only the two of you can read this chat - nobody is in between.
          </p>
          <div class="safety-grid" aria-label={`Safety number ${groups.join(' ')}`}>
            {groups.map((g) => <code>{g}</code>)}
          </div>
          {scanning ? (
            <Scanner
              hint={`Point at the safety QR code on ${displayName(contact)}'s screen`}
              accept={(raw) => /^\d{60}$/.test(raw)}
              onClose={() => setScanning(false)}
              onCode={(raw) => {
                setScanning(false);
                if (raw === number) {
                  void updateContact(contact.id, { verified: true });
                  toast(`Verified - only you and ${displayName(contact)} can read this chat`, 'success', 6000);
                } else {
                  toast(`Safety numbers do NOT match. Someone may be intercepting your chat with ${displayName(contact)}. Do not trust it until you can verify.`, 'error', 15000);
                }
              }}
            />
          ) : (
            <>
              <details class="qr-details">
                <summary>Show my QR for them to scan</summary>
                <div class="qr-wrap sm"><Qr value={number} label="Safety number QR code" /></div>
              </details>
              <div class="row wrap">
                {canScan && !contact.verified && (
                  <button class="btn primary" onClick={() => setScanning(true)}><Icon name="camera" size={18} /> Scan their code</button>
                )}
                <button class={`btn ${contact.verified || canScan ? 'ghost' : 'primary'}`} onClick={() => void updateContact(contact.id, { verified: !contact.verified })}>
                  <Icon name="shieldCheck" size={18} /> {contact.verified ? 'Clear verification' : 'The numbers match'}
                </button>
              </div>
            </>
          )}
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

const PERMISSION_HELP: Record<NotifyPermission, string | undefined> = {
  granted: undefined,
  default: undefined,
  denied: 'Notifications are blocked for this site. Allow them in your browser or system settings, then turn this on again.',
  unsupported: 'This browser does not support notifications.',
  'needs-install': 'On iPhone and iPad, notifications only work after you add Veil to your Home Screen (see Install above).',
};

function NotificationsCard() {
  const { settings } = useApp();
  const [perm, setPerm] = useState<NotifyPermission>(notifyPermission());
  const blocked = perm === 'denied' || perm === 'unsupported' || perm === 'needs-install';
  const on = settings.notifications && perm === 'granted';

  const toggle = async (want: boolean) => {
    if (want) {
      const p = await requestNotifyPermission();
      setPerm(p);
      if (p !== 'granted') return toast(PERMISSION_HELP[p] ?? 'Notifications were not allowed', 'error', 6000);
    }
    await saveSettings({ notifications: want });
  };

  return (
    <div class="card">
      <CardHead icon="bell" title="Notifications" />
      <label class="toggle">
        <input type="checkbox" checked={on} disabled={blocked} onChange={(e) => void toggle(e.currentTarget.checked)} />
        <span>Notify me about new messages and files</span>
      </label>
      {PERMISSION_HELP[perm] && <p class="callout warn"><Icon name="alert" size={18} /><span>{PERMISSION_HELP[perm]}</span></p>}
      {on && (
        <label class="toggle">
          <input type="checkbox" checked={settings.notifyNames} onChange={(e) => void saveSettings({ notifyNames: e.currentTarget.checked })} />
          <span>Show who it is from (visible on your lock screen)</span>
        </label>
      )}
      <small class="muted">
        Message text is never shown. Veil has no push server, so notifications arrive only while Veil is open or running in the background and connected. Phones may pause background apps after a while, and auto-lock disconnects you.
      </small>
    </div>
  );
}

function InvitesCard() {
  const { invites, settings } = useApp();
  if (!settings.useRelays) return null;
  const left = (t: number) => {
    const d = Math.ceil((t - Date.now()) / 86_400_000);
    return d <= 1 ? 'expires within a day' : `expires in ${d} days`;
  };
  return (
    <div class="card">
      <CardHead icon="link" title="Invite links" sub="Single-use links that connect automatically - no codes to send back." />
      <div class="field">
        <label for="set-invdays">New links work for</label>
        <select id="set-invdays" value={settings.inviteDays} onChange={(e) => void saveSettings({ inviteDays: Number(e.currentTarget.value) })}>
          {[1, 3, 7, 14, 30].map((d) => <option value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
        </select>
      </div>
      {invites.length === 0 ? (
        <p class="muted small">No active invite links.</p>
      ) : (
        <ul class="invite-list">
          {invites.map((i) => (
            <li class={i.conflict ? 'conflict' : ''}>
              <span class="grow">
                <b>
                  {i.conflict
                    ? `Possibly intercepted - verify ${i.by ?? 'this contact'}`
                    : i.used
                      ? `Used by ${i.by ?? 'a contact'}`
                      : i.claimed
                        ? `Opened by ${i.by ?? 'someone'} - connecting when you are both online`
                        : 'Waiting to be opened'}
                </b>
                <small class="muted">
                  {i.used ? 'Spent - kept until it expires to catch reuse' : `Created ${new Date(i.created).toLocaleDateString()}`} - {left(i.expires)}
                </small>
              </span>
              <button class="btn ghost sm danger-text" onClick={() => void revokeInvite(i.iid).then(() => toast(i.used ? 'Removed' : 'Invite revoked', 'success'))}>
                {i.used ? 'Remove' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardHead({ icon, title, sub }: { icon: IconName; title: string; sub?: string }) {
  return (
    <div class="card-head">
      <span class="card-icon"><Icon name={icon} size={18} /></span>
      <div>
        <h4>{title}</h4>
        {sub && <p class="small muted">{sub}</p>}
      </div>
    </div>
  );
}

function ThemePicker() {
  const { settings } = useApp();
  const opts: [typeof settings.theme, string][] = [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];
  return (
    <div class="seg three" role="radiogroup" aria-label="Theme">
      {opts.map(([v, l]) => (
        <button role="radio" aria-checked={settings.theme === v} class={settings.theme === v ? 'on' : ''} onClick={() => void saveSettings({ theme: v })}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel() {
  const { settings, profile, myId } = useApp();
  const [name, setName] = useState(profile.name);
  const [stun, setStun] = useState(settings.stunUrls.join('\n'));
  const [turn, setTurn] = useState({ url: settings.turnUrl, user: settings.turnUser, pass: settings.turnPass });
  const [wipe, setWipe] = useState(false);
  const [showKey, setShowKey] = useState(false);

  return (
    <section class="panel" aria-label="Settings">
      <PanelHead title="Settings" onBack={() => store.set({ view: 'chats' })} />
      <div class="panel-scroll">
        <div class="card profile-settings">
          <div class="me-row">
            <span class="avatar lg c0" aria-hidden="true">{(profile.name || '?').slice(0, 1).toUpperCase()}</span>
            <div class="grow">
              <div class="field">
                <label for="set-name">Display name</label>
                <div class="input-row">
                  <input id="set-name" value={name} maxLength={48} onInput={(e) => setName(e.currentTarget.value)} />
                  <button class="btn primary sm" disabled={name === profile.name} onClick={() => void saveProfileName(name).then(() => toast('Saved', 'success', 1500))}>Save</button>
                </div>
                <small>Shared with contacts when you connect.</small>
              </div>
            </div>
          </div>
          <button class="link-btn left" onClick={() => setShowKey(!showKey)} aria-expanded={showKey}>
            {showKey ? 'Hide' : 'Show'} my identity key
          </button>
          {showKey && <code class="key">{myId}</code>}
        </div>

        <BackupCard />

        <RelaysCard />

        <InvitesCard />

        <NotificationsCard />

        <InstallCard />

        <div class="card">
          <CardHead icon="lock" title="Privacy & security" sub="Locking closes connections and erases keys from memory." />
          <div class="field">
            <label for="set-lock">Auto-lock after inactivity</label>
            <select id="set-lock" value={settings.autoLockMins} onChange={(e) => void saveSettings({ autoLockMins: Number(e.currentTarget.value) })}>
              {[1, 5, 15, 60, 240, 0].map((v) => <option value={v}>{v === 0 ? 'Never' : v < 60 ? `${v} minutes` : `${v / 60} hour${v > 60 ? 's' : ''}`}</option>)}
            </select>
          </div>
          <label class="toggle">
            <input type="checkbox" checked={settings.autoConnect} onChange={(e) => void saveSettings({ autoConnect: e.currentTarget.checked })} />
            <span>Connect automatically <small class="muted">(when you open a chat, and when contacts reach out - they can tell you are online)</small></span>
          </label>
          <ChangePassphrase />
          <button class="btn ghost" onClick={() => lock()}><Icon name="lock" size={18} /> Lock now</button>
        </div>

        <div class="card">
          <CardHead icon="sun" title="Appearance & chats" />
          <ThemePicker />
          <label class="toggle">
            <input type="checkbox" checked={settings.enterToSend} onChange={(e) => void saveSettings({ enterToSend: e.currentTarget.checked })} />
            <span>Press Enter to send <small class="muted">(Shift+Enter for a new line)</small></span>
          </label>
          <div class="field">
            <label for="set-accept">Auto-accept files up to</label>
            <select id="set-accept" value={settings.autoAcceptMB} onChange={(e) => void saveSettings({ autoAcceptMB: Number(e.currentTarget.value) })}>
              {[0, 5, 25, 100, 500].map((v) => <option value={v}>{v === 0 ? 'Always ask' : `${v} MB`}</option>)}
            </select>
          </div>
        </div>

        <div class="card">
          <CardHead icon="globe" title="Network" sub="How your device finds others. No server ever sees your messages." />
          <label class="toggle">
            <input type="checkbox" checked={settings.useStun} onChange={(e) => void saveSettings({ useStun: e.currentTarget.checked })} />
            <span>Connect across networks with STUN <small class="muted">(off = same Wi-Fi only)</small></span>
          </label>
          {settings.useStun && (
            <div class="field">
              <label for="set-stun">STUN servers (one per line)</label>
              <textarea id="set-stun" rows={2} value={stun} spellcheck={false} onInput={(e) => setStun(e.currentTarget.value)} onBlur={() => void saveSettings({ stunUrls: stun.split(/\s+/).filter(Boolean) })} />
              <small>STUN only tells your device its public address.</small>
            </div>
          )}
          <details>
            <summary>Custom TURN relay (for strict networks)</summary>
            <p class="muted small">Relays traffic when a direct path is impossible. It only ever sees ciphertext. Use one you run or trust.</p>
            <label class="field"><span>URL</span><input value={turn.url} placeholder="turns:turn.example.com:5349" onInput={(e) => setTurn({ ...turn, url: e.currentTarget.value })} /></label>
            <label class="field"><span>Username</span><input value={turn.user} autoComplete="off" onInput={(e) => setTurn({ ...turn, user: e.currentTarget.value })} /></label>
            <label class="field"><span>Credential</span><input type="password" autoComplete="off" value={turn.pass} onInput={(e) => setTurn({ ...turn, pass: e.currentTarget.value })} /></label>
            <button class="btn ghost sm" onClick={() => void saveSettings({ turnUrl: turn.url, turnUser: turn.user, turnPass: turn.pass }).then(() => toast('TURN settings saved', 'success'))}>Save TURN</button>
          </details>
        </div>

        <div class="card danger-zone">
          <CardHead icon="trash" title="Erase this device" sub="Deletes every chat, file and key. Make a backup first." />
          {wipe ? (
            <>
              <p>Permanently erase everything on this device?</p>
              <div class="row">
                <button class="btn ghost sm" onClick={() => setWipe(false)}>Cancel</button>
                <button class="btn danger sm" onClick={() => void wipeEverything()}>Erase everything</button>
              </div>
            </>
          ) : (
            <button class="btn ghost danger-text" onClick={() => setWipe(true)}><Icon name="trash" size={18} /> Erase all data</button>
          )}
        </div>

        <div class="card about">
          <Logo size={36} />
          <div>
            <b>Veil {__APP_VERSION__}</b>
            <p class="small muted">Protocol v1 - X25519 + ML-KEM-768 - AES-256-GCM</p>
          </div>
          <nav class="about-links" aria-label="About Veil">
            <a href="../" target="_blank" rel="noopener">Website</a>
            <a href="https://github.com/dmdhrumilmistry/veil" target="_blank" rel="noopener noreferrer">Source</a>
            <a href="https://github.com/dmdhrumilmistry/veil/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer">Security</a>
          </nav>
        </div>
      </div>
    </section>
  );
}
