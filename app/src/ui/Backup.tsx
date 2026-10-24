import { useMemo, useRef, useState } from 'preact/hooks';
import { backupFileName, createBackup, inspectBackup, restoreBackup, type BackupProgress } from '../state/app';
import { toast, useApp } from '../state/store';
import { BackupError } from '../storage/backup';
import { formatBytes } from './common';
import { MIN_PASSPHRASE, strength } from './passphrase';
import { Icon } from './icons';
import { Modal } from './Modal';

function pct(p?: BackupProgress) {
  return p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
}

function since(ts: number): string {
  if (!ts) return 'Never backed up';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days === 0) return 'Last backup today';
  if (days === 1) return 'Last backup yesterday';
  return `Last backup ${days} days ago`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function PassFields({ value, onChange, confirm, onConfirm, label }: { value: string; onChange: (s: string) => void; confirm: string; onConfirm: (s: string) => void; label: string }) {
  const st = strength(value);
  return (
    <>
      <div class="field">
        <label for="bk-pass">{label}</label>
        <input id="bk-pass" type="password" autoComplete="new-password" value={value} onInput={(e) => onChange(e.currentTarget.value)} aria-describedby="bk-pass-hint" />
        <div class={`meter s${st.score}`} aria-hidden="true"><i /><i /><i /><i /></div>
        <small id="bk-pass-hint">{value ? `${st.label}${value.length < MIN_PASSPHRASE ? ` - at least ${MIN_PASSPHRASE} characters` : ''}` : 'You will need this to restore. It can differ from your device passphrase.'}</small>
      </div>
      <div class="field">
        <label for="bk-confirm">Confirm</label>
        <input id="bk-confirm" type="password" autoComplete="new-password" value={confirm} onInput={(e) => onConfirm(e.currentTarget.value)} />
        {confirm && confirm !== value && <small class="err">Passphrases do not match</small>}
      </div>
    </>
  );
}

export const passOk = (p: string, c: string) => p.length >= MIN_PASSPHRASE && strength(p).score >= 2 && p === c;

function CreateBackupModal({ onClose }: { onClose: () => void }) {
  const { messages, contacts } = useApp();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [files, setFiles] = useState(true);
  const [progress, setProgress] = useState<BackupProgress>();
  const [done, setDone] = useState<Blob | 'saved'>();
  const [error, setError] = useState('');
  const loadedFileBytes = useMemo(
    () => Object.values(messages).flat().reduce((n, m) => n + (m.file?.state === 'done' ? m.file.size : 0), 0),
    [messages],
  );

  const run = async (e: Event) => {
    e.preventDefault();
    setError('');
    setProgress({ phase: 'preparing', done: 0, total: 1 });
    try {
      const blob = await createBackup(pass, files, setProgress);
      if (blob) download(blob, backupFileName());
      setDone(blob ?? 'saved');
    } catch (err) {
      setProgress(undefined);
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    }
  };

  if (done) {
    return (
      <Modal title="Backup ready" onClose={onClose}>
        <div class="result">
          <div class="success-ring"><Icon name="check" size={32} /></div>
          <p>Your encrypted backup {done === 'saved' ? 'was saved.' : 'is downloading.'}</p>
          <ul class="tips">
            <li><Icon name="lock" size={16} /> Without the backup passphrase, nobody can open it - not even you.</li>
            <li><Icon name="file" size={16} /> Keep it somewhere safe, like a USB drive or your own cloud storage.</li>
            <li><Icon name="shield" size={16} /> It contains your identity key. Anyone with the file and passphrase can be "you".</li>
          </ul>
          {done !== 'saved' && <button class="btn ghost" onClick={() => download(done, backupFileName())}><Icon name="download" size={18} /> Download again</button>}
          <button class="btn primary" onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  if (progress) {
    return (
      <Modal title="Creating backup" onClose={() => {}}>
        <div class="busy">
          <span class="spinner lg" aria-hidden="true" />
          <p>{progress.phase === 'preparing' ? 'Deriving keys and gathering your data...' : `Encrypting files... ${pct(progress)}%`}</p>
          <progress max={100} value={pct(progress)} aria-label="Backup progress" />
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create encrypted backup" onClose={onClose}>
      <form class="stack" onSubmit={run}>
        <p class="muted small">
          Saves your identity, {contacts.length} contact{contacts.length === 1 ? '' : 's'}, chats and settings into one file encrypted with AES-256-GCM. Use it to move Veil to a new device or recover after a reset.
        </p>
        <PassFields label="Backup passphrase" value={pass} onChange={setPass} confirm={confirm} onConfirm={setConfirm} />
        <label class="toggle">
          <input type="checkbox" checked={files} onChange={(e) => setFiles(e.currentTarget.checked)} />
          <span>Include photos and files{loadedFileBytes ? ` (at least ${formatBytes(loadedFileBytes)})` : ''}</span>
        </label>
        {error && <p class="err" role="alert">{error}</p>}
        <button class="btn primary lg" disabled={!passOk(pass, confirm)}>
          <Icon name="lock" size={18} /> Create backup
        </button>
      </form>
    </Modal>
  );
}

/** Multi-step restore: pick file -> unlock -> review -> choose device passphrase. */
export function RestoreFlow({ replacing, onCancel }: { replacing: boolean; onCancel: () => void }) {
  const [file, setFile] = useState<File>();
  const [backupPass, setBackupPass] = useState('');
  const [summary, setSummary] = useState<{ contacts: number; messages: number; name: string }>();
  const [same, setSame] = useState(true);
  const [devPass, setDevPass] = useState('');
  const [devConfirm, setDevConfirm] = useState('');
  const [busy, setBusy] = useState<BackupProgress>();
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f?: File | null) => {
    if (!f) return;
    setFile(f);
    setError('');
    setSummary(undefined);
  };

  const verify = async (e: Event) => {
    e.preventDefault();
    setError('');
    setBusy({ phase: 'verifying', done: 0, total: 1 });
    try {
      setSummary(await inspectBackup(file!, backupPass, setBusy));
    } catch (err) {
      setError(err instanceof BackupError ? err.message : (err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const restore = async (e: Event) => {
    e.preventDefault();
    setError('');
    try {
      await restoreBackup(file!, backupPass, same ? backupPass : devPass, () => {});
    } catch (err) {
      toast(`Restore failed: ${(err as Error).message}`, 'error', 7000);
    }
  };

  if (busy) {
    return (
      <div class="busy">
        <span class="spinner lg" aria-hidden="true" />
        <p>Decrypting and checking every record... {pct(busy)}%</p>
        <progress max={100} value={pct(busy)} aria-label="Verification progress" />
      </div>
    );
  }

  if (!file) {
    return (
      <div class="stack">
        <button
          type="button"
          class={`dropzone ${drag ? 'over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer?.files[0]); }}
        >
          <Icon name="file" size={32} />
          <b>Choose your .veilbackup file</b>
          <span class="muted small">or drop it here</span>
        </button>
        <input ref={input} type="file" hidden onChange={(e) => pick(e.currentTarget.files?.[0])} />
        <button type="button" class="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    );
  }

  if (!summary) {
    return (
      <form class="stack" onSubmit={verify}>
        <div class="file-chip">
          <Icon name="file" size={18} />
          <span class="grow">{file.name}<small class="muted"> - {formatBytes(file.size)}</small></span>
          <button type="button" class="link-btn" onClick={() => setFile(undefined)}>Change</button>
        </div>
        <div class="field">
          <label for="rs-pass">Backup passphrase</label>
          <input id="rs-pass" type="password" autoFocus autoComplete="current-password" value={backupPass} onInput={(e) => setBackupPass(e.currentTarget.value)} />
        </div>
        {error && <p class="err" role="alert">{error}</p>}
        <div class="row">
          <button type="button" class="btn ghost" onClick={onCancel}>Cancel</button>
          <button class="btn primary grow" disabled={!backupPass}>Unlock backup</button>
        </div>
      </form>
    );
  }

  return (
    <form class="stack" onSubmit={restore}>
      <div class="summary">
        <div><b>{summary.name || 'Unnamed'}</b><span>Profile</span></div>
        <div><b>{summary.contacts}</b><span>Contacts</span></div>
        <div><b>{summary.messages}</b><span>Messages</span></div>
      </div>
      <p class="muted small"><Icon name="shieldCheck" size={14} /> Backup verified - every record decrypted and authenticated.</p>
      {replacing && (
        <div class="callout warn"><Icon name="alert" size={18} /><span>Restoring replaces everything currently on this device.</span></div>
      )}
      <label class="toggle">
        <input type="checkbox" checked={same} onChange={(e) => setSame(e.currentTarget.checked)} />
        <span>Use the backup passphrase to unlock this device</span>
      </label>
      {!same && (
        <PassFields label="New device passphrase" value={devPass} onChange={setDevPass} confirm={devConfirm} onConfirm={setDevConfirm} />
      )}
      <div class="row">
        <button type="button" class="btn ghost" onClick={onCancel}>Cancel</button>
        <button class={`btn ${replacing ? 'danger' : 'primary'} grow`} disabled={!same && !passOk(devPass, devConfirm)}>
          {replacing ? 'Replace and restore' : 'Restore'}
        </button>
      </div>
    </form>
  );
}

export function BackupCard() {
  const { settings } = useApp();
  const [modal, setModal] = useState<'' | 'create' | 'restore'>('');
  const stale = !settings.lastBackupAt || Date.now() - settings.lastBackupAt > 30 * 86_400_000;
  return (
    <div class="card" id="backup">
      <div class="card-head">
        <span class="card-icon"><Icon name="shield" size={18} /></span>
        <div>
          <h4>Backup &amp; restore</h4>
          <p class={`small ${stale ? 'warn-text' : 'muted'}`}>{since(settings.lastBackupAt)}</p>
        </div>
      </div>
      <p class="muted small">Veil has no cloud. If you lose this device or forget your passphrase, a backup is the only way to get your chats back.</p>
      <div class="row wrap">
        <button class="btn primary" onClick={() => setModal('create')}><Icon name="download" size={18} /> Create backup</button>
        <button class="btn ghost" onClick={() => setModal('restore')}><Icon name="share" size={18} /> Restore</button>
      </div>
      {modal === 'create' && <CreateBackupModal onClose={() => setModal('')} />}
      {modal === 'restore' && (
        <Modal title="Restore from backup" onClose={() => setModal('')}>
          <RestoreFlow replacing onCancel={() => setModal('')} />
        </Modal>
      )}
    </div>
  );
}

export function RestoringScreen() {
  const { restoring } = useApp();
  const p = restoring ? Math.min(100, Math.round((restoring.done / Math.max(1, restoring.total)) * 100)) : 0;
  return (
    <main class="gate">
      <div class="gate-card narrow" aria-live="polite">
        <span class="spinner lg" aria-hidden="true" />
        <h1>{restoring?.phase === 'restoring' ? 'Restoring your data' : 'Checking backup'}</h1>
        <p class="muted">{restoring?.phase === 'restoring' ? 'Re-encrypting everything for this device. Keep Veil open.' : 'Decrypting and verifying every record...'}</p>
        <progress max={100} value={p} aria-label={`${p}%`} />
        <p class="small muted">{p}%</p>
      </div>
    </main>
  );
}
