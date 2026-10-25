import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  acceptFile,
  cancelTransfer,
  createInvite,
  declineFile,
  deleteMessage,
  disconnect,
  displayName,
  fileUrl,
  formatTtl,
  markRead,
  openChat,
  sendFiles,
  sendText,
  sendTyping,
} from '../state/app';
import { store, toast, useApp } from '../state/store';
import { safeMime, type Contact, type Message } from '../storage/repo';
import { Avatar, formatBytes, formatDay, formatTime } from './common';
import { Icon } from './icons';

const GROUP_GAP_MS = 3 * 60_000;
const finePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches;

// ------------------------------------------------------------------ text rendering

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Turns http(s) URLs into safe links. Everything else stays plain text (no HTML parsing). */
function Linkified({ text }: { text: string }) {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? '';
    url = url.slice(0, url.length - trail.length);
    const start = m.index!;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <a href={url} target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
function isJumbo(text: string) {
  if (!EMOJI_ONLY.test(text) || /\d/.test(text)) return false;
  const n = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())].length;
  return n > 0 && n <= 3;
}

// ------------------------------------------------------------------ bits

function StatusIcon({ m }: { m: Message }) {
  if (m.dir === 'in') return null;
  const map = {
    sending: ['clock', 'Sending'],
    queued: ['mail', 'Waiting in their mailbox'],
    sent: ['check', 'Sent'],
    delivered: ['checks', 'Delivered'],
    read: ['checks', 'Read'],
    failed: ['alert', 'Failed to send'],
  } as const;
  const [icon, label] = map[m.status];
  return (
    <span class={`status ${m.status}`} title={label} aria-label={label}>
      <Icon name={icon} size={14} />
    </span>
  );
}

function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} class="lightbox" aria-label={name} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div class="lightbox-bar">
        <span class="lightbox-name">{name}</span>
        <a class="icon-btn" href={url} download={name} aria-label="Save"><Icon name="download" /></a>
        <button class="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>
      <img src={url} alt={name} onClick={onClose} />
    </dialog>
  );
}

function FilePreview({ m }: { m: Message }) {
  const f = m.file!;
  const [url, setUrl] = useState<string>();
  const [zoom, setZoom] = useState(false);
  const kind = safeMime(f.mime).split('/')[0];
  useEffect(() => {
    if (f.state !== 'done' || !f.chunks) return;
    // Decrypt small media for inline preview; everything else on demand.
    if ((kind === 'image' && f.size < 20 * 1024 * 1024) || ((kind === 'video' || kind === 'audio') && f.size < 50 * 1024 * 1024)) {
      void fileUrl(f).then(setUrl).catch(() => {});
    }
  }, [f.state, f.fileId]);

  const save = async () => {
    const u = url ?? (await fileUrl(f));
    const a = document.createElement('a');
    a.href = u;
    a.download = f.name;
    a.rel = 'noopener';
    a.click();
  };

  if (url && kind === 'image') {
    return (
      <>
        <button class="media" onClick={() => setZoom(true)} aria-label={`View ${f.name}`}>
          <img src={url} alt={f.name} loading="lazy" decoding="async" />
        </button>
        {zoom && <Lightbox url={url} name={f.name} onClose={() => setZoom(false)} />}
      </>
    );
  }
  if (url && kind === 'video') return <video class="media" src={url} controls preload="metadata" playsInline />;
  if (url && kind === 'audio') return <audio src={url} controls preload="metadata" />;
  return (
    <button class="btn ghost sm" onClick={() => void save()}>
      <Icon name="download" size={16} /> Save
    </button>
  );
}

function FileCard({ m }: { m: Message }) {
  const { progress } = useApp();
  const f = m.file!;
  const done = progress[f.fileId] ?? (f.state === 'done' ? f.size : 0);
  const pct = f.size ? Math.min(100, Math.round((done / f.size) * 100)) : 100;
  const isMedia = /^(image|video)\//.test(safeMime(f.mime));
  const stateLabel: Record<string, string> = {
    offered: m.dir === 'out' ? 'Waiting for them to accept' : `${formatBytes(f.size)} - accept to download`,
    transferring: `${pct}% - ${formatBytes(done)} of ${formatBytes(f.size)}`,
    done: formatBytes(f.size),
    failed: 'Transfer failed',
    declined: 'Declined',
    canceled: 'Canceled',
    removed: 'Not included in backup',
  };
  return (
    <div class={`file-card ${f.state} ${isMedia && f.state === 'done' ? 'is-media' : ''}`}>
      {!(isMedia && f.state === 'done') && (
        <div class="file-row">
          <span class="file-icon"><Icon name="file" size={22} /></span>
          <span class="file-meta">
            <span class="file-name" title={f.name}>{f.name}</span>
            <span class="file-sub">{stateLabel[f.state]}</span>
          </span>
        </div>
      )}
      {f.state === 'transferring' && (
        <div class="file-progress">
          <progress max={100} value={pct} aria-label={`Transfer ${pct}%`} />
          <button class="icon-btn sm" aria-label="Cancel transfer" onClick={() => void cancelTransfer(m)}><Icon name="x" size={16} /></button>
        </div>
      )}
      {f.state === 'offered' && m.dir === 'in' && (
        <div class="row">
          <button class="btn ghost sm" onClick={() => void declineFile(m)}>Decline</button>
          <button class="btn primary sm grow" onClick={() => void acceptFile(m)}><Icon name="download" size={16} /> Accept</button>
        </div>
      )}
      {f.state === 'offered' && m.dir === 'out' && (
        <button class="btn ghost sm" onClick={() => void cancelTransfer(m)}>Cancel</button>
      )}
      {f.state === 'done' && <FilePreview m={m} />}
    </div>
  );
}

// ------------------------------------------------------------------ message bubble

function MessageMenu({ m, onClose }: { m: Message; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  return (
    <div class="msg-menu" role="menu" ref={ref}>
      {m.kind === 'text' && (
        <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(m.text ?? '').then(() => toast('Copied', 'success', 1500)); onClose(); }}>
          <Icon name="copy" size={16} /> Copy text
        </button>
      )}
      <div class="menu-info" role="presentation">
        {new Date(m.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
        {m.expiresAt && <> - disappears {new Date(m.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</>}
      </div>
      <button role="menuitem" class="danger" onClick={() => { void deleteMessage(m); onClose(); }}>
        <Icon name="trash" size={16} /> Delete for me
      </button>
    </div>
  );
}

function Bubble({ m, first, last }: { m: Message; first: boolean; last: boolean }) {
  const [menu, setMenu] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout>>();
  if (m.id.startsWith('sys-')) {
    return (
      <div class="sys-note" role="note">
        <Icon name="shield" size={14} /> {m.text}
      </div>
    );
  }
  const jumbo = m.kind === 'text' && isJumbo(m.text ?? '');
  // Long-press opens the menu on touch screens (iOS has no contextmenu on long-press).
  const startPress = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    press.current = setTimeout(() => {
      navigator.vibrate?.(10);
      setMenu(true);
    }, 450);
  };
  const endPress = () => clearTimeout(press.current);

  return (
    <div class={`msg ${m.dir} ${first ? 'first' : ''} ${last ? 'last' : ''}`}>
      <div class="bubble-row">
        <div
          class={`bubble ${jumbo ? 'jumbo' : ''} ${m.kind === 'file' ? 'has-file' : ''}`}
          onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
          onPointerDown={startPress}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onPointerMove={endPress}
        >
          {m.kind === 'text' ? <p class="text"><Linkified text={m.text ?? ''} /></p> : <FileCard m={m} />}
          <span class="meta">
            {m.expiresAt && <Icon name="clock" size={11} />}
            <time dateTime={new Date(m.ts).toISOString()}>{formatTime(m.ts)}</time>
            <StatusIcon m={m} />
          </span>
        </div>
        <button class="msg-more" aria-label="Message options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Icon name="more" size={16} />
        </button>
      </div>
      {menu && <MessageMenu m={m} onClose={() => setMenu(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ composer

function Composer({ chat, enabled, name, live }: { chat: string; enabled: boolean; name: string; live: boolean }) {
  const { settings } = useApp();
  const [text, setText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // Auto-grow by adjusting `rows` (inline styles are blocked by our CSP).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.rows = 1;
    if (!text) return; // placeholder text must not grow the box
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    const pad = 22;
    el.rows = Math.max(1, Math.min(7, Math.round((el.scrollHeight - pad) / line)));
  }, [text]);

  useEffect(() => {
    if (finePointer && enabled) area.current?.focus();
  }, [chat, enabled]);

  const submit = () => {
    if (!text.trim() || !enabled) return;
    void sendText(chat, text);
    setText('');
    area.current?.focus();
  };

  return (
    <form class="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <button type="button" class="icon-btn attach" aria-label="Attach files" title={live ? 'Attach files' : 'Files need a live connection'} disabled={!live} onClick={() => fileInput.current?.click()}>
        <Icon name="plus" />
      </button>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const f = e.currentTarget.files; if (f?.length) void sendFiles(chat, f); e.currentTarget.value = ''; }} />
      <div class="input-shell">
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={!enabled}
          maxLength={16000}
          placeholder={!enabled ? 'Reconnect to send messages' : live ? `Message ${name}` : `Leave ${name} a message`}
          aria-label="Message"
          enterkeyhint={settings.enterToSend ? 'send' : 'enter'}
          onInput={(e) => { setText(e.currentTarget.value); sendTyping(chat); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && settings.enterToSend && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files?.length && live) {
              e.preventDefault();
              void sendFiles(chat, files);
            }
          }}
        />
        {text.length > 15000 && <span class="char-count">{16000 - text.length}</span>}
      </div>
      <button class={`send-btn ${text.trim() ? 'ready' : ''}`} aria-label="Send" disabled={!text.trim() || !enabled}>
        <Icon name="send" />
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ chat

export function Chat({ contact }: { contact: Contact }) {
  const { messages, presence, typing, offline } = useApp();
  const list = messages[contact.id];
  const online = presence[contact.id] === 'online';
  const mailable = !!offline[contact.id];
  const isTyping = (typing[contact.id] ?? 0) > Date.now() - 4000;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const seen = useRef(0);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [drag, setDrag] = useState(false);
  const name = displayName(contact);

  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stick.current = true;
    setUnseen(0);
  };

  useLayoutEffect(() => {
    const n = list?.length ?? 0;
    if (stick.current) toBottom();
    else if (n > seen.current) setUnseen((u) => u + (n - seen.current));
    seen.current = n;
  }, [list?.length, isTyping, contact.id]);

  useEffect(() => {
    stick.current = true;
    setUnseen(0);
    const onVis = () => void markRead(contact.id);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [contact.id]);

  const rows: ComponentChildren[] = [];
  let lastDay = '';
  list?.forEach((m, i) => {
    const day = formatDay(m.ts);
    if (day !== lastDay) {
      rows.push(<div class="day-sep" key={`d-${day}`}><span>{day}</span></div>);
      lastDay = day;
    }
    const prev = list[i - 1];
    const next = list[i + 1];
    const sameAs = (o?: Message) => !!o && !o.id.startsWith('sys-') && o.dir === m.dir && Math.abs(o.ts - m.ts) < GROUP_GAP_MS && formatDay(o.ts) === day;
    rows.push(
      <Fragment key={m.id}>
        <Bubble m={m} first={!sameAs(prev)} last={!sameAs(next)} />
      </Fragment>,
    );
  });

  return (
    <section
      class={`chat ${drag ? 'dragging' : ''}`}
      aria-label={`Conversation with ${name}`}
      onDragOver={(e) => { if (online && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer?.files; if (f?.length && online) void sendFiles(contact.id, f); }}
    >
      <header class="chat-head">
        <button class="icon-btn back" aria-label="Back to chats" onClick={() => void openChat(undefined)}>
          <Icon name="back" />
        </button>
        <button class="chat-who" onClick={() => store.set({ view: 'info' })} aria-label={`${name} - contact info`}>
          <Avatar contact={contact} online={online} />
          <span>
            <span class="chat-name">
              {name}
              {contact.verified && <Icon name="shieldCheck" size={15} class="verified" />}
            </span>
            <span class={`chat-status ${online ? 'on' : ''} ${isTyping ? 'typing' : ''}`}>
              {isTyping ? 'typing...' : online ? (<><Icon name="lock" size={11} /> End-to-end encrypted</>) : mailable ? (<><Icon name="mail" size={11} /> Offline - messages wait in their mailbox</>) : 'Offline'}
              {contact.disappearSecs > 0 && <span class="ttl-chip"><Icon name="clock" size={11} /> {formatTtl(contact.disappearSecs)}</span>}
            </span>
          </span>
        </button>
        <div class="row">
          {online && (
            <button class="icon-btn" aria-label="Disconnect" title="Disconnect" onClick={() => disconnect(contact.id)}>
              <Icon name="unplug" />
            </button>
          )}
          <button class="icon-btn" aria-label="Contact info" title="Contact info" onClick={() => store.set({ view: 'info' })}>
            <Icon name="info" />
          </button>
        </div>
      </header>

      {!online && (
        <div class={`offline-banner ${mailable ? 'mailable' : ''}`} role="status">
          <span class="ob-icon"><Icon name={mailable ? 'mail' : 'plug'} size={16} /></span>
          <span class="ob-text">
            <b>{mailable ? `${name} is offline` : 'Not connected'}</b>
            <span>{mailable ? 'Messages are encrypted and wait in their mailbox. Reconnect to send files.' : 'Reconnect with a fresh invite to keep chatting.'}</span>
          </span>
          <button class={`btn ${mailable ? 'ghost' : 'primary'} sm`} onClick={() => void createInvite(contact.id)}>Reconnect</button>
        </div>
      )}

      <div
        class="messages"
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = atBottom;
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
          if (atBottom) setUnseen(0);
        }}
      >
        {!list && <div class="center muted pad">Decrypting...</div>}
        {list?.length === 0 && (
          <div class="chat-empty">
            <div class="chat-empty-art"><Icon name="shieldCheck" size={36} /></div>
            <h3>Say hi to {name}</h3>
            <p>Messages and files travel directly between your devices, end-to-end encrypted. Nothing is stored anywhere else.</p>
            {!contact.verified && (
              <button class="btn ghost sm" onClick={() => store.set({ view: 'info' })}><Icon name="shield" size={16} /> Verify safety number</button>
            )}
          </div>
        )}
        {rows}
        {isTyping && (
          <div class="msg in first last">
            <div class="bubble typing" aria-label={`${name} is typing`}><i /><i /><i /></div>
          </div>
        )}
      </div>

      {(away || unseen > 0) && (
        <button class="jump" onClick={() => toBottom(true)} aria-label={unseen ? `${unseen} new messages - jump to latest` : 'Jump to latest'}>
          <Icon name="down" size={18} />
          {unseen > 0 && <span class="badge">{unseen}</span>}
        </button>
      )}

      <Composer chat={contact.id} enabled={online || mailable} live={online} name={name} />
      {drag && <div class="drop-overlay" aria-hidden="true"><Icon name="clip" size={36} /><p>Drop to send to {name}</p></div>}
    </section>
  );
}
