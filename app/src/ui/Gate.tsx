import { useState } from 'preact/hooks';
import { createAccount, unlock, useHere, wipeEverything } from '../state/app';
import { detectPlatform, isStandalone } from '../state/install';
import { useApp } from '../state/store';
import { WrongPassphraseError } from '../storage/vault';
import { Icon, Logo } from './icons';
import { InstallCard } from './Install';
import { RestoreFlow } from './Backup';
import { MIN_PASSPHRASE, strength } from './passphrase';



export function Onboarding() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  // Preact 11's accessible input typings can't express a text/password union, so narrow it here.
  const passType = (show ? 'text' : 'password') as 'password';
  const [useRelays, setUseRelays] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const st = strength(pass);
  const valid = pass.length >= MIN_PASSPHRASE && st.score >= 2 && pass === confirm;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      await createAccount(name, pass, useRelays);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (step === 2) {
    return (
      <main class="gate">
        <div class="gate-card">
          <button type="button" class="icon-btn gate-back" aria-label="Back" onClick={() => setStep(0)}>
            <Icon name="back" />
          </button>
          <h1>Restore from backup</h1>
          <p class="muted">Bring your identity, contacts and chats from another device.</p>
          <RestoreFlow replacing={false} onCancel={() => setStep(0)} />
        </div>
      </main>
    );
  }

  if (step === 0) {
    return (
      <main class="gate">
        <div class="gate-card gate-hero">
          <Logo size={72} />
          <h1>Welcome to Veil</h1>
          <p class="lead">Private conversations that go straight from your device to theirs. No servers, no accounts, no phone numbers.</p>
          <ul class="pill-list">
            <li><Icon name="shieldCheck" size={18} /> Post-quantum end-to-end encryption</li>
            <li><Icon name="plug" size={18} /> Direct peer-to-peer over WebRTC</li>
            <li><Icon name="lock" size={18} /> Everything stays encrypted on this device</li>
          </ul>
          <button class="btn primary lg" onClick={() => setStep(1)}>Get started</button>
          <button class="btn ghost" onClick={() => setStep(2)}>
            <Icon name="download" size={18} /> Restore from a backup
          </button>
          {detectPlatform() === 'ios' && isStandalone() && (
            <div class="callout info">
              <Icon name="info" size={18} />
              <span>
                <b>Used Veil in Safari before?</b> On iPhone and iPad, the Home Screen app keeps its own separate data. In Safari, open Settings, create a backup, then choose "Restore from a backup" here.
              </span>
            </div>
          )}
          <InstallCard compact />
        </div>
      </main>
    );
  }

  return (
    <main class="gate">
      <form class="gate-card" onSubmit={submit}>
        <button type="button" class="icon-btn gate-back" aria-label="Back" onClick={() => setStep(0)}>
          <Icon name="back" />
        </button>
        <h1>Set up this device</h1>
        <p class="muted">Your identity is created locally. Nothing is uploaded anywhere.</p>

        <div class="field">
          <label for="ob-name">Display name</label>
          <input id="ob-name" aria-describedby="ob-name-hint" value={name} maxLength={48} autoComplete="nickname" placeholder="How contacts will see you" onInput={(e) => setName(e.currentTarget.value)} />
          <small id="ob-name-hint">Shared only with people you connect to.</small>
        </div>

        <div class="field">
          <label for="ob-pass">Passphrase</label>
          <div class="input-row">
            <input id="ob-pass" aria-describedby="ob-pass-hint" type={passType} value={pass} autoComplete="new-password" required minLength={MIN_PASSPHRASE} onInput={(e) => setPass(e.currentTarget.value)} />
            <button type="button" class="link-btn" aria-pressed={show} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
          </div>
          <div class={`meter s${st.score}`} aria-hidden="true"><i /><i /><i /><i /></div>
          <small id="ob-pass-hint" aria-live="polite">{pass ? `${st.label}${pass.length < MIN_PASSPHRASE ? ` - at least ${MIN_PASSPHRASE} characters` : ''}` : 'Encrypts all data on this device. Try 4+ random words.'}</small>
        </div>

        <div class="field">
          <label for="ob-confirm">Confirm passphrase</label>
          <input id="ob-confirm" type={passType} value={confirm} autoComplete="new-password" required onInput={(e) => setConfirm(e.currentTarget.value)} />
          {confirm && confirm !== pass && <small class="err">Passphrases do not match</small>}
        </div>

        <label class="toggle">
          <input type="checkbox" checked={useRelays} onChange={(e) => setUseRelays(e.currentTarget.checked)} />
          <span>
            Invite links and offline messages via public relays <small class="muted">(they only ever carry encrypted data; turn off for peer-to-peer only)</small>
          </span>
        </label>

        <div class="callout warn">
          <Icon name="alert" size={18} />
          <span>There is no recovery. If you forget this passphrase, your chats cannot be decrypted by anyone - including us.</span>
        </div>

        {error && <p class="err" role="alert">{error}</p>}
        <button class="btn primary lg" disabled={!valid || busy}>
          {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name="lock" size={18} />}
          {busy ? 'Creating keys...' : 'Create encrypted vault'}
        </button>
      </form>
    </main>
  );
}

export function LockScreen() {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [restore, setRestore] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!pass || busy) return;
    setBusy(true);
    setError('');
    try {
      await unlock(pass);
    } catch (err) {
      setError(err instanceof WrongPassphraseError ? 'Incorrect passphrase' : (err as Error).message);
      setBusy(false);
      // Small delay discourages rapid guessing from the UI (PBKDF2 already makes each guess costly).
      await new Promise((r) => setTimeout(r, 600));
    }
  };

  if (restore) {
    return (
      <main class="gate">
        <div class="gate-card">
          <h1>Restore from backup</h1>
          <p class="muted">Your current data on this device will be replaced.</p>
          <RestoreFlow replacing onCancel={() => setRestore(false)} />
        </div>
      </main>
    );
  }

  return (
    <main class="gate">
      <form class="gate-card narrow" onSubmit={submit}>
        <div class="lock-badge">
          <Logo size={56} />
        </div>
        <h1>Veil is locked</h1>
        <p class="muted">Enter your passphrase to decrypt your conversations.</p>
        <label class="field">
          <span class="sr-only">Passphrase</span>
          <input type="password" value={pass} autoFocus autoComplete="current-password" placeholder="Passphrase" onInput={(e) => setPass(e.currentTarget.value)} aria-invalid={!!error} />
        </label>
        {error && <p class="err" role="alert">{error}</p>}
        <button class="btn primary lg" disabled={!pass || busy}>
          {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name="lock" size={18} />}
          {busy ? 'Unlocking...' : 'Unlock'}
        </button>
        <div class="gate-foot">
          {confirmWipe ? (
            <div class="callout danger">
              <span>Erase all chats, files and keys on this device? This cannot be undone.</span>
              <div class="row">
                <button type="button" class="btn ghost sm" onClick={() => setConfirmWipe(false)}>Cancel</button>
                <button type="button" class="btn danger sm" onClick={() => void wipeEverything()}>Erase everything</button>
              </div>
            </div>
          ) : (
            <div class="stack center">
              <button type="button" class="link-btn" onClick={() => setRestore(true)}>Forgot passphrase? Restore from a backup</button>
              <button type="button" class="link-btn muted" onClick={() => setConfirmWipe(true)}>Reset this device</button>
            </div>
          )}
        </div>
      </form>
    </main>
  );
}

export function Unsupported() {
  return (
    <main class="gate">
      <div class="gate-card narrow">
        <Logo size={56} />
        <h1>Browser not supported</h1>
        <p class="muted">
          Veil needs a modern browser with WebRTC and Ed25519/X25519 WebCrypto support. Please update to the latest Chrome, Edge, Firefox or Safari.
        </p>
      </div>
    </main>
  );
}

export function Handoff() {
  const { handoffMessage } = useApp();
  return (
    <main class="gate">
      <div class="gate-card narrow">
        <div class="success-ring"><Icon name="check" size={36} /></div>
        <h1>Reply delivered</h1>
        <p class="muted">{handoffMessage}</p>
      </div>
    </main>
  );
}

export function Elsewhere() {
  const { elsewhere } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <main class="gate">
      <div class="gate-card narrow">
        <div class="lock-badge"><Icon name="copy" size={36} /></div>
        <h1>{elsewhere === 'taken' ? 'Veil moved to another window' : 'Veil is open in another window'}</h1>
        <p class="muted">
          {elsewhere === 'taken'
            ? 'You opened Veil somewhere else, so this window stepped aside. Your chats are safe.'
            : 'Veil runs in one window at a time so your chats and connections stay in sync.'}
        </p>
        <button class="btn primary lg" disabled={busy} onClick={() => { setBusy(true); void useHere().finally(() => setBusy(false)); }}>
          Use Veil here
        </button>
        <p class="fine">The other window will lock and disconnect.</p>
      </div>
    </main>
  );
}
