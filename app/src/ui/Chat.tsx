import { Fragment } from 'preact';
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
import { store, useApp } from '../state/store';
import { safeMime, type Contact, type Message } from '../storage/repo';
import { Avatar, formatBytes, formatDay, formatTime } from './common';
import { Icon } from './icons';

function StatusIcon({ m }: { m: Message }) {
  if (m.dir === 'in') return null;
  const map = {
    sending: ['clock', 'Sending'],
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

function FilePreview({ m }: { m: Message }) {
  const f = m.file!;
  const [url, setUrl] = useState<string>();
  const kind = safeMime(f.mime).split('/')[0];
  useEffect(() => {
    if (f.state !== 'done' || !f.chunks) return;
    // Auto-decrypt small media for inline preview; everything else on demand.
    if ((kind === 'image' && f.size < 20 * 1024 * 1024) || (kind !== 'application' && f.size < 50 * 1024 * 1024)) {
      void fileUrl(f).then(setUrl).catch(() => {});
    }
  }, [f.state, f.fileId]);

  const download = async () => {
    const u = url ?? (await fileUrl(f));
    const a = document.createElement('a');
    a.href = u;
    a.download = f.name;
    a.rel = 'noopener';
    a.click();
  };

  if (url && kind === 'image') {
    return (
      <button class="media" onClick={() => void download()} aria-label={`Download ${f.name}`}>
        <img src={url} alt={f.name} loading="lazy" decoding="async" />
      </button>
    );
  }
  if (url && kind === 'video') return <video class="media" src={url} controls preload="metadata" />;
  if (url && kind === 'audio') return <audio src={url} controls preload="metadata" />;
  return (
    <button class="btn ghost sm" onClick={() => void download()}>
      <Icon name="download" size={16} /> Save
    </button>
  );
}

function FileCard({ m }: { m: Message }) {
  const { progress } = useApp();
  const f = m.file!;
  const done = progress[f.fileId] ?? (f.state === 'done' ? f.size : 0);
  const pct = f.size ? Math.min(100, Math.round((done / f.size) * 100)) : 100;
  const stateLabel: Record<string, string> = {
    offered: m.dir === 'out' ? 'Waiting for them to accept' : 'Wants to send you a file',
    transferring: `${pct}% - ${formatBytes(done)} of ${formatBytes(f.size)}`,
    done: formatBytes(f.size),
    failed: 'Transfer failed',
    declined: 'Declined',
    canceled: 'Canceled',
  };
  return (
    <div class={`file-card ${f.state}`}>
      <div class="file-row">
        <span class="file-icon"><Icon name="file" size={22} /></span>
        <span class="file-meta">
          <span class="file-name" title={f.name}>{f.name}</span>
          <span class="file-sub">{stateLabel[f.state]}</span>
        </span>
      </div>
      {f.state === 'transferring' && (
        <div class="file-progress">
          <progress max={100} value={pct} aria-label={`Transfer ${pct}%`} />
          <button class="icon-btn sm" aria-label="Cancel transfer" onClick={() => void cancelTransfer(m)}><Icon name="x" size={16} /></button>
        </div>
      )}
      {f.state === 'offered' && m.dir === 'in' && (
        <div class="row">
          <button class="btn ghost sm" onClick={() => void declineFile(m)}>Decline</button>
          <button class="btn primary sm" onClick={() => void acceptFile(m)}><Icon name="download" size={16} /> Accept {formatBytes(f.size)}</button>
        </div>
      )}
      {f.state === 'offered' && m.dir === 'out' && (
        <button class="btn ghost sm" onClick={() => void cancelTransfer(m)}>Cancel</button>
      )}
      {f.state === 'done' && <FilePreview m={m} />}
    </div>
  );
}

function Bubble({ m, contact }: { m: Message; contact: Contact }) {
  const [menu, setMenu] = useState(false);
  if (m.id.startsWith('sys-')) {
    return (
      <div class="sys-note" role="note">
        <Icon name="shield" size={14} /> {m.text}
      </div>
    );
  }
  return (
    <div class={`msg ${m.dir}`}>
      <div class="bubble" onContextMenu={(e) => { e.preventDefault(); setMenu(!menu); }} onDblClick={() => setMenu(!menu)}>
        {m.kind === 'text' ? <p class="text">{m.text}</p> : <FileCard m={m} />}
        <span class="meta">
          {m.expiresAt && <Icon name="clock" size={12} />}
          <time dateTime={new Date(m.ts).toISOString()}>{formatTime(m.ts)}</time>
          <StatusIcon m={m} />
        </span>
      </div>
      {menu && (
        <div class="msg-menu" role="menu">
          {m.kind === 'text' && (
            <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(m.text ?? ''); setMenu(false); }}>
              <Icon name="copy" size={16} /> Copy
            </button>
          )}
          <button role="menuitem" class="danger" onClick={() => void deleteMessage(m)}>
            <Icon name="trash" size={16} /> Delete for me
          </button>
        </div>
      )}
      <span class="sr-only">{m.dir === 'in' ? displayName(contact) : 'You'}</span>
    </div>
  );
}

function Composer({ chat, enabled }: { chat: string; enabled: boolean }) {
  const { settings } = useApp();
  const [text, setText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (!text.trim() || !enabled) return;
    void sendText(chat, text);
    setText('');
    area.current?.focus();
  };

  return (
    <form class="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <button type="button" class="icon-btn" aria-label="Attach files" disabled={!enabled} onClick={() => fileInput.current?.click()}>
        <Icon name="clip" />
      </button>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const f = e.currentTarget.files; if (f?.length) void sendFiles(chat, f); e.currentTarget.value = ''; }} />
      <textarea
        ref={area}
        rows={1}
        value={text}
        disabled={!enabled}
        maxLength={16000}
        placeholder={enabled ? 'Message' : 'Reconnect to send messages'}
        aria-label="Message"
        onInput={(e) => { setText(e.currentTarget.value); sendTyping(chat); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && settings.enterToSend && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          const files = e.clipboardData?.files;
          if (files?.length && enabled) {
            e.preventDefault();
            void sendFiles(chat, files);
          }
        }}
      />
      <button class="send-btn" aria-label="Send" disabled={!text.trim() || !enabled}>
        <Icon name="send" />
      </button>
    </form>
  );
}

export function Chat({ contact }: { contact: Contact }) {
  const { messages, presence, typing } = useApp();
  const list = messages[contact.id];
  const online = presence[contact.id] === 'online';
  const isTyping = (typing[contact.id] ?? 0) > Date.now() - 4000;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [drag, setDrag] = useState(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list?.length, isTyping, contact.id]);

  useEffect(() => {
    stick.current = true;
    const onVis = () => void markRead(contact.id);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [contact.id]);

  let lastDay = '';
  return (
    <section
      class={`chat ${drag ? 'dragging' : ''}`}
      aria-label={`Conversation with ${displayName(contact)}`}
      onDragOver={(e) => { if (online) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer?.files; if (f?.length && online) void sendFiles(contact.id, f); }}
    >
      <header class="chat-head">
        <button class="icon-btn back" aria-label="Back to chats" onClick={() => void openChat(undefined)}>
          <Icon name="back" />
        </button>
        <button class="chat-who" onClick={() => store.set({ view: 'info' })} aria-label="Contact info">
          <Avatar contact={contact} online={online} />
          <span>
            <span class="chat-name">
              {displayName(contact)}
              {contact.verified && <Icon name="shieldCheck" size={15} class="verified" />}
            </span>
            <span class={`chat-status ${online ? 'on' : ''}`}>
              {isTyping ? 'typing...' : online ? 'Connected - end-to-end encrypted' : 'Offline'}
              {contact.disappearSecs > 0 && <> - <Icon name="clock" size={12} /> {formatTtl(contact.disappearSecs)}</>}
            </span>
          </span>
        </button>
        <div class="row">
          {online ? (
            <button class="icon-btn" aria-label="Disconnect" title="Disconnect" onClick={() => disconnect(contact.id)}>
              <Icon name="unplug" />
            </button>
          ) : (
            <button class="btn primary sm" onClick={() => void createInvite(contact.id)}>
              <Icon name="plug" size={16} /> Reconnect
            </button>
          )}
          <button class="icon-btn" aria-label="Contact info" onClick={() => store.set({ view: 'info' })}>
            <Icon name="info" />
          </button>
        </div>
      </header>

      {!online && (
        <div class="offline-banner" role="status">
          <Icon name="plug" size={16} />
          <span>Not connected. Veil has no servers, so reconnecting takes a fresh invite - tap Reconnect and send it to {displayName(contact)}.</span>
        </div>
      )}

      <div
        class="messages"
        ref={scroller}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!list && <div class="center muted pad">Decrypting...</div>}
        {list?.length === 0 && (
          <div class="chat-empty">
            <Icon name="shieldCheck" size={40} />
            <p>Messages and files here are end-to-end encrypted and travel directly between your devices.</p>
          </div>
        )}
        {list?.map((m) => {
          const day = formatDay(m.ts);
          const sep = day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={m.id}>
              {sep && <div class="day-sep"><span>{day}</span></div>}
              <Bubble m={m} contact={contact} />
            </Fragment>
          );
        })}
        {isTyping && (
          <div class="msg in">
            <div class="bubble typing" aria-label="typing"><i /><i /><i /></div>
          </div>
        )}
      </div>

      <Composer chat={contact.id} enabled={online} />
      {drag && <div class="drop-overlay" aria-hidden="true"><Icon name="clip" size={36} /><p>Drop to send securely</p></div>}
    </section>
  );
}
