import { createInvite, startJoin } from '../state/app';
import { useApp } from '../state/store';
import { RestoringScreen } from './Backup';
import { Chat } from './Chat';
import { ConnectSheet } from './ConnectSheet';
import { Elsewhere, Handoff, LockScreen, Onboarding, Unsupported } from './Gate';
import { Icon, Logo } from './icons';
import { ContactInfo, SettingsPanel } from './Panels';
import { Sidebar } from './Sidebar';

function Toasts() {
  const { toasts } = useApp();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={18} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Welcome() {
  return (
    <section class="welcome">
      <div class="welcome-art" aria-hidden="true">
        <Logo size={88} />
      </div>
      <h2>Private by design</h2>
      <p class="muted">Start a conversation by creating an invite. Your contact opens it, sends a reply back, and you are connected directly - no servers in between.</p>
      <div class="row center">
        <button class="btn primary lg" onClick={() => void createInvite()}><Icon name="plus" size={18} /> Create invite</button>
        <button class="btn ghost lg" onClick={startJoin}><Icon name="link" size={18} /> I have a code</button>
      </div>
      <ul class="facts">
        <li><Icon name="shieldCheck" size={18} /><span><b>Hybrid post-quantum</b> X25519 + ML-KEM-768 handshake</span></li>
        <li><Icon name="lock" size={18} /><span><b>AES-256-GCM</b> with a fresh key for every message</span></li>
        <li><Icon name="plug" size={18} /><span><b>Peer-to-peer</b> WebRTC - nothing stored in the cloud</span></li>
      </ul>
    </section>
  );
}

function UpdateBanner() {
  const { updateReady } = useApp();
  if (!updateReady) return null;
  return (
    <div class="update-banner" role="status">
      <Icon name="download" size={16} />
      <span>A new version of Veil is ready.</span>
      <button class="btn primary sm" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}

function Main() {
  const { contacts, activeChat, view } = useApp();
  const contact = contacts.find((c) => c.id === activeChat);
  const showPane = !!contact || view === 'settings';
  let pane;
  if (view === 'settings') pane = <SettingsPanel />;
  else if (contact && view === 'info') pane = <ContactInfo contact={contact} key={contact.id} />;
  else if (contact) pane = <Chat contact={contact} key={contact.id} />;
  else pane = <Welcome />;
  return (
    <div class={`shell ${showPane ? 'pane-open' : ''}`}>
      <Sidebar />
      <main class="pane" id="main">{pane}</main>
      <ConnectSheet />
      <UpdateBanner />
    </div>
  );
}

export function App() {
  const { phase } = useApp();
  return (
    <>
      {phase === 'loading' && <div class="splash"><Logo size={64} /></div>}
      {phase === 'unsupported' && <Unsupported />}
      {phase === 'onboarding' && <Onboarding />}
      {phase === 'locked' && <LockScreen />}
      {phase === 'handoff' && <Handoff />}
      {phase === 'restoring' && <RestoringScreen />}
      {phase === 'elsewhere' && <Elsewhere />}
      {phase === 'ready' && <Main />}
      <Toasts />
    </>
  );
}
