import { useEffect, useRef, useState } from 'preact/hooks';
import { closeConnect, createInvite, openCode, startJoin, submitAnswer } from '../state/app';
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

function CodeActions({ link, code, title }: { link: string; code: string; title: string }) {
  return (
    <div class="code-actions">
      <button class="btn primary" onClick={() => void share(link, title)}>
        <Icon name="share" size={18} /> {'share' in navigator ? 'Share link' : 'Copy link'}
      </button>
      <button class="btn ghost" onClick={() => void copy(code, 'Code')}>
        <Icon name="copy" size={18} /> Copy code
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
            const hit = found.find((f) => f.rawValue.includes('VEIL1'));
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
      if (t.includes('VEIL1')) onSubmit(t);
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

function InviteFlow({ c }: { c: Extract<ConnectFlow, { mode: 'invite' }> }) {
  if (c.step === 'creating') return <Busy text="Generating a one-time secure invite..." />;
  if (c.step === 'connecting') return <Busy text="Connecting and verifying keys..." />;
  if (c.step === 'error') return <ErrorState error={c.error} retry={() => void createInvite(c.forContact)} />;
  return (
    <>
      <Steps active={1} labels={['Share invite', 'Paste reply', 'Connected']} />
      <div class="qr-wrap">
        <Qr value={c.link!} label="Invite QR code" />
      </div>
      <p class="hint center">Let them scan this with their phone camera, or share the link through any app. Keep this window open.</p>
      <CodeActions link={c.link!} code={c.code!} title="Join me on Veil" />
      <div class="divider"><span>then</span></div>
      <PasteBox label="Their reply code" placeholder="Paste the reply they send back (VEIL1A...)" cta="Connect" onSubmit={(t) => void submitAnswer(t)} />
    </>
  );
}

function JoinFlow({ c }: { c: Extract<ConnectFlow, { mode: 'join' }> }) {
  if (c.step === 'input') {
    return <PasteBox label="Invite link or code" placeholder="Paste an invite link or code (VEIL1O...)" cta="Continue" onSubmit={(t) => void openCode(t)} />;
  }
  if (c.step === 'creating') return <Busy text="Preparing your secure reply..." />;
  if (c.step === 'error') return <ErrorState error={c.error} retry={startJoin} />;
  return (
    <>
      <Steps active={1} labels={['Open invite', 'Send reply', 'Connected']} />
      <p class="hint center">
        Send this reply back to <strong>{c.peerName || 'the person who invited you'}</strong>. You will connect automatically once they paste it.
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
  const { connect } = useApp();
  if (!connect) return null;
  const title = connect.mode === 'invite' ? (connect.forContact ? 'Reconnect' : 'Invite someone') : 'Join with an invite';
  return (
    <Modal title={title} onClose={closeConnect} wide>
      <div class="seg" role="tablist">
        <button role="tab" aria-selected={connect.mode === 'invite'} class={connect.mode === 'invite' ? 'on' : ''} onClick={() => connect.mode !== 'invite' && void createInvite()}>
          <Icon name="qr" size={16} /> Create invite
        </button>
        <button role="tab" aria-selected={connect.mode === 'join'} class={connect.mode === 'join' ? 'on' : ''} onClick={() => connect.mode !== 'join' && startJoin()}>
          <Icon name="link" size={16} /> I have a code
        </button>
      </div>
      {connect.mode === 'invite' ? <InviteFlow c={connect} /> : <JoinFlow c={connect} />}
      <p class="fine center">
        <Icon name="shield" size={14} /> Codes contain your public key and network address, never messages. Each one works once.
      </p>
    </Modal>
  );
}
