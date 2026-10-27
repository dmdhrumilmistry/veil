import { useMemo, useState } from 'preact/hooks';
import { createInvite, displayName, lock, openChat, startJoin } from '../state/app';
import { store, useApp } from '../state/store';
import { Avatar, relativeTime } from './common';
import { Icon, Logo } from './icons';
import { InstallCard } from './Install';
import { NotifyPrompt } from './NotifyPrompt';

export function Sidebar() {
  const { contacts, activeChat, presence, typing, profile, view } = useApp();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? contacts.filter((c) => displayName(c).toLowerCase().includes(s)) : contacts;
  }, [contacts, q]);

  return (
    <aside class="sidebar" aria-label="Conversations">
      <header class="side-head">
        <div class="brand">
          <Logo size={28} />
          <span>Veil</span>
        </div>
        <div class="row">
          <button class="icon-btn" aria-label="Lock now" title="Lock now" onClick={() => lock()}>
            <Icon name="lock" />
          </button>
          <button class={`icon-btn ${view === 'settings' ? 'on' : ''}`} aria-label="Settings" title="Settings" onClick={() => store.set({ view: 'settings', activeChat: undefined })}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div class="side-actions">
        <button class="btn primary grow" onClick={() => void createInvite()}>
          <Icon name="plus" size={18} /> New chat
        </button>
        <button class="btn ghost" onClick={startJoin} title="Join with an invite code">
          <Icon name="link" size={18} /> Join
        </button>
      </div>

      {contacts.length > 4 && (
        <div class="search">
          <input type="search" placeholder="Search" aria-label="Search contacts" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
      )}

      <nav class="contact-list" aria-label="Chats">
        {contacts.length === 0 && (
          <div class="side-empty">
            <div class="side-empty-art" aria-hidden="true"><Logo size={44} /></div>
            <h3>Start your first private chat</h3>
            <ol class="mini-steps">
              <li><span>1</span> Create an invite</li>
              <li><span>2</span> Send it to someone you trust</li>
              <li><span>3</span> Paste their reply - you are connected</li>
            </ol>
          </div>
        )}
        {contacts.length > 0 && list.length === 0 && <p class="muted center pad">No chats match "{q}"</p>}
        {list.map((c) => {
          const isTyping = (typing[c.id] ?? 0) > Date.now() - 4000;
          const online = presence[c.id] === 'online';
          const p = c.preview && (!c.preview.expiresAt || c.preview.expiresAt > Date.now()) ? c.preview : undefined;
          return (
            <button key={c.id} class={`contact ${activeChat === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}`} aria-current={activeChat === c.id ? 'true' : undefined} onClick={() => void openChat(c.id)}>
              <Avatar contact={c} online={online} />
              <span class="contact-main">
                <span class="contact-top">
                  <span class="contact-name">
                    {displayName(c)}
                    {c.verified && <Icon name="shieldCheck" size={14} class="verified" />}
                  </span>
                  <span class="contact-time">{relativeTime(p?.ts ?? c.lastSeen)}</span>
                </span>
                <span class="contact-sub">
                  <span class={`preview ${isTyping ? 'typing-text' : ''}`}>
                    {isTyping ? (
                      'typing...'
                    ) : p ? (
                      <>
                        {p.dir === 'out' && <span class="you">You: </span>}
                        {p.kind === 'file' && <Icon name="clip" size={13} />}
                        {p.text}
                      </>
                    ) : presence[c.id] === 'connecting' ? (
                      'Connecting...'
                    ) : online ? (
                      'Connected'
                    ) : (
                      'No messages yet'
                    )}
                  </span>
                  {c.unread > 0 && <span class="badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <NotifyPrompt />
      <InstallCard compact />

      <footer class="side-foot">
        <span class="me">
          <Icon name="user" size={16} /> {profile.name || 'You'}
        </span>
        <span class="e2e-tag">
          <Icon name="shieldCheck" size={14} /> E2E encrypted
        </span>
      </footer>
    </aside>
  );
}
