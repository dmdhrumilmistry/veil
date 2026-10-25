import { useEffect, useRef, useState } from 'preact/hooks';
import { acceptInvite, closeConnect, createInvite, createInviteLink, DEFAULT_RELAY, openCode, setupMailbox, startJoin, submitAnswer } from '../state/app';
import { toast, useApp, type ConnectFlow } from '../state/store';
import { Icon } from './icons';
import { Qr } from './Qr';
import { Modal } from './Modal';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'success', 2000);
  } catch {
    toast('Copy failed - select and copy manually', 'error');
  }
}

async function share(link: string, title: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text: `${title} - open this link in your browser:`, url: link });
      return;
    } catch {
      /* user dismissed */
      return;
    }
  }
  await copy(link, 'Link');
}

function CodeActions({ link, code, title, copyLabel = 'Copy code' }: { link: string; code: string; title: string; copyLabel?: string }) {
  // Without a share sheet, "share" would just copy the same link: show a single button.
  if (!('share' in navigator) && link === code) {
    return (
      <div class="code-actions single">
        <button class="btn primary" onClick={() => void copy(link, 'Link')}>
          <Icon name="copy" size={18} /> Copy link
        </button>
      </div>
    );
  }
  return (
    <div class="code-actions">
      <button class="btn primary" onClick={() => void share(link, title)}>
        <Icon name="share" size={18} /> {'share' in navigator ? 'Share link' : 'Copy link'}
      </button>
      <button class="btn ghost" onClick={() => void copy(code, copyLabel === 'Copy link' ? 'Link' : 'Code')}>
        <Icon name="copy" size={18} /> {copyLabel}
      </button>
    </div>
  );
}

/** Uses the native BarcodeDetector where available (Chrome Android/macOS, Edge). */
function Scanner({ onCode, onClose }: { onCode: (s: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const detector = new (window as unknown as { BarcodeDetector: new (o: object) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (stopped) return;
          try {
            const found = await detector.detect(v);
            const hit = found.find((f) => /VEIL(1|2I)/.test(f.rawValue));
            if (hit) return onCode(hit.rawValue);
          } catch {
            /* frame not ready */
          }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch {
        toast('Camera unavailable', 'error');
        onClose();
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return (
    <div class="scanner">
      <video ref={video} playsInline muted />
      <div class="scanner-frame" aria-hidden="true" />
      <button class="btn ghost sm" onClick={onClose}>Cancel scan</button>
    </div>
  );
}

const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices;

function PasteBox({ label, placeholder, onSubmit, cta }: { label: string; placeholder: string; onSubmit: (s: string) => void; cta: string }) {
  const [text, setText] = useState('');
  const [scan, setScan] = useState(false);
  const pasteClip = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setText(t);
      if (/VEIL(1|2I)/.test(t)) onSubmit(t);
    } catch {
      toast('Clipboard access denied - paste manually', 'error');
    }
  };
  if (scan) return <Scanner onCode={(c) => { setScan(false); onSubmit(c); }} onClose={() => setScan(false)} />;
  return (
    <form class="paste-box" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSubmit(text); }}>
      <label class="field">
        <span>{label}</span>
        <textarea rows={3} value={text} placeholder={placeholder} spellcheck={false} autoComplete="off" onInput={(e) => setText(e.currentTarget.value)} />
      </label>
      <div class="row wrap">
        {'clipboard' in navigator && 'readText' in navigator.clipboard && (
          <button type="button" class="btn ghost" onClick={() => void pasteClip()}><Icon name="paste" size={18} /> Paste</button>
        )}
        {canScan && <button type="button" class="btn ghost" onClick={() => setScan(true)}><Icon name="camera" size={18} /> Scan QR</button>}
        <button class="btn primary grow" disabled={!text.trim()}>{cta}</button>
      </div>
    </form>
  );
}

function Steps({ active, labels }: { active: number; labels: string[] }) {
  return (
    <ol class="steps" aria-label="Progress">
      {labels.map((l, i) => (
        <li class={i < active ? 'done' : i === active ? 'active' : ''} aria-current={i === active ? 'step' : undefined}>
          <span class="dot">{i < active ? <Icon name="check" size={14} /> : i + 1}</span>
          <span class="lbl">{l}</span>
        </li>
      ))}
    </ol>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <div class="busy">
      <span class="spinner lg" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function expiresIn(ts?: number) {
  if (!ts) return '';
  const days = Math.round((ts - Date.now()) / 86_400_000);
  return days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'less than a day';
}

/** Shown in the live-code flow when there is no mailbox yet: the way out of copy-paste. */
function MailboxNudge() {
  const { mailbox } = useApp();
  const [busy, setBusy] = useState(false);
  if (mailbox) return null;
  const host = DEFAULT_RELAY ? new URL(DEFAULT_RELAY).host : '';
  return (
    <div class="nudge">
      <Icon name="mail" size={18} />
      <div class="grow">
        <b>Skip the codes next time</b>
        <p>With a mailbox, invites become a single link that works for days - no need to be online together or send anything back.</p>
        {DEFAULT_RELAY ? (
          <button class="btn primary sm" disabled={busy} onClick={() => { setBusy(true); void setupMailbox(DEFAULT_RELAY!).then(() => createInviteLink()).catch((e) => toast((e as Error).message, 'error')).finally(() => setBusy(false)); }}>
            {busy ? 'Setting up...' : `Use ${host} and get a link`}
          </button>
        ) : (
          <a class="link-btn left" href="#mailbox" onClick={(e) => { e.preventDefault(); closeConnect(); document.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click(); }}>Set up a mailbox in Settings</a>
        )}
      </div>
    </div>
  );
}

function InviteFlow({ c }: { c: Extract<ConnectFlow, { mode: 'invite' }> }) {
  if (c.step === 'creating') return <Busy text="Creating a secure invite..." />;
  if (c.step === 'connecting') return <Busy text="Connecting and verifying keys..." />;
  if (c.step === 'error') return <ErrorState error={c.error} retry={() => void createInvite(c.forContact)} />;
  if (c.step === 'link') {
    return (
      <>
        <div class="link-hero">
          <span class="link-badge"><Icon name="link" size={22} /></span>
          <div>
            <b>Your invite link is ready</b>
            <p>Send it any way you like. When they open it, you connect automatically - even if you are offline right now.</p>
          </div>
        </div>
        <div class="qr-wrap"><Qr value={c.link!} label="Invite QR code" /></div>
        <CodeActions link={c.link!} code={c.link!} title="Chat with me privately on Veil" copyLabel="Copy link" />
        <ul class="facts compact">
          <li><Icon name="clock" size={16} /><span>Works for {expiresIn(c.expires)}, for one person</span></li>
          <li><Icon name="shieldCheck" size={16} /><span>Only carries your public key and an encrypted mailbox address</span></li>
        </ul>
        <button class="btn ghost" onClick={closeConnect}>Done</button>
        <button class="link-btn" onClick={() => void createInvite(undefined, true)}>Both online right now? Use a one-time code instead</button>
      </>
    );
  }
  return (
    <>
      <Steps active={1} labels={['Share code', 'Paste reply', 'Connected']} />
      <div class="qr-wrap">
        <Qr value={c.link!} label="Invite QR code" />
      </div>
      <p class="hint center">Let them scan this, or share the link. <b>Keep this screen open</b> until they send their reply - the code stops working if Veil closes.</p>
      <CodeActions link={c.link!} code={c.code!} title="Join me on Veil" />
      <div class="divider"><span>then</span></div>
      <PasteBox label="Their reply code" placeholder="Paste the reply they send back (VEIL1A...)" cta="Connect" onSubmit={(t) => void submitAnswer(t)} />
      <MailboxNudge />
    </>
  );
}

function JoinFlow({ c }: { c: Extract<ConnectFlow, { mode: 'join' }> }) {
  if (c.step === 'input') {
    return <PasteBox label="Invite link or code" placeholder="Paste an invite link or code" cta="Continue" onSubmit={(t) => void openCode(t)} />;
  }
  if (c.step === 'creating') return <Busy text="Preparing a secure connection..." />;
  if (c.step === 'error') return <ErrorState error={c.error} retry={startJoin} />;
  if (c.step === 'confirm') {
    return (
      <div class="confirm-invite">
        <div class="invite-from">
          <span class="avatar lg c1" aria-hidden="true">{(c.peerName || '?').slice(0, 1).toUpperCase()}</span>
          <h3>{c.peerName || 'Someone'} invited you to chat</h3>
          <p class="muted small">End-to-end encrypted, peer-to-peer. Compare safety numbers after connecting to be sure it is really them.</p>
        </div>
        <button class="btn primary lg" onClick={() => void acceptInvite()}><Icon name="plug" size={18} /> Connect</button>
        <button class="btn ghost" onClick={closeConnect}>Not now</button>
      </div>
    );
  }
  if (c.step === 'requested') {
    return (
      <div class="requested">
        <div class="radar" aria-hidden="true"><span /><span /><Icon name="mail" size={26} /></div>
        <h3>Asking {c.peerName || 'them'} to connect...</h3>
        <p class="muted">
          If {c.peerName || 'they'} has Veil open, you will be connected in a few seconds. Otherwise it happens automatically the next time you are both online. You can close this.
        </p>
        <button class="btn ghost" onClick={closeConnect}>Close</button>
      </div>
    );
  }
  return (
    <>
      <Steps active={1} labels={['Open code', 'Send reply', 'Connected']} />
      <p class="hint center">
        Send this reply back to <strong>{c.peerName || 'the person who invited you'}</strong>. You will connect as soon as they paste it.
      </p>
      <div class="qr-wrap">
        <Qr value={c.link!} label="Reply QR code" />
      </div>
      <CodeActions link={c.link!} code={c.code!} title="My Veil reply" />
      <div class="waiting"><span class="pulse" aria-hidden="true" /> Waiting for them to connect...</div>
    </>
  );
}

function ErrorState({ error, retry }: { error?: string; retry: () => void }) {
  return (
    <div class="error-state">
      <div class="err-icon"><Icon name="alert" size={28} /></div>
      <p>{error || 'Something went wrong'}</p>
      <button class="btn primary" onClick={retry}>Try again</button>
    </div>
  );
}

export function ConnectSheet() {
  const { connect, mailbox } = useApp();
  if (!connect) return null;
  const title =
    connect.mode === 'invite' ? (connect.forContact ? 'Reconnect' : 'Invite someone') : connect.step === 'confirm' || connect.step === 'requested' ? 'Invitation' : 'Join with an invite';
  const tabs = !(connect.mode === 'join' && (connect.step === 'confirm' || connect.step === 'requested'));
  return (
    <Modal title={title} onClose={closeConnect} wide>
      {tabs && (
        <div class="seg" role="tablist">
          <button role="tab" aria-selected={connect.mode === 'invite'} class={connect.mode === 'invite' ? 'on' : ''} onClick={() => connect.mode !== 'invite' && void createInvite()}>
            <Icon name="qr" size={16} /> {mailbox ? 'Invite link' : 'Create invite'}
          </button>
          <button role="tab" aria-selected={connect.mode === 'join'} class={connect.mode === 'join' ? 'on' : ''} onClick={() => connect.mode !== 'join' && startJoin()}>
            <Icon name="link" size={16} /> I have a link
          </button>
        </div>
      )}
      {connect.mode === 'invite' ? <InviteFlow c={connect} /> : <JoinFlow c={connect} />}
      <p class="fine center">
        <Icon name="shield" size={14} /> Invites carry your public key and how to reach you - never messages.
      </p>
    </Modal>
  );
}
