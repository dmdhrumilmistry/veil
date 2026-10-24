import { useMemo, useState } from 'preact/hooks';
import { createInvite, displayName, lock, openChat, startJoin } from '../state/app';
import { store, useApp } from '../state/store';
import { Avatar, relativeTime } from './common';
import { Icon, Logo } from './icons';
import { InstallCard } from './Install';

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

      <nav class="contact-list">
        {list.length === 0 && contacts.length === 0 && (
          <div class="side-empty">
            <p>No contacts yet.</p>
            <p class="muted">Create an invite and send it to someone you trust.</p>
          </div>
        )}
        {list.map((c) => {
          const isTyping = (typing[c.id] ?? 0) > Date.now() - 4000;
          const online = presence[c.id] === 'online';
          return (
            <button key={c.id} class={`contact ${activeChat === c.id ? 'active' : ''}`} aria-current={activeChat === c.id ? 'true' : undefined} onClick={() => void openChat(c.id)}>
              <Avatar contact={c} online={online} />
              <span class="contact-main">
                <span class="contact-top">
                  <span class="contact-name">
                    {displayName(c)}
                    {c.verified && <Icon name="shieldCheck" size={14} class="verified" />}
                  </span>
                  <span class="contact-time">{relativeTime(c.lastSeen)}</span>
                </span>
                <span class="contact-sub">
                  <span class={isTyping ? 'typing-text' : 'muted'}>{isTyping ? 'typing...' : online ? 'Connected' : 'Offline'}</span>
                  {c.unread > 0 && <span class="badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

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
