import { render } from 'preact';
import { activity, boot, lock } from './state/app';
import './state/install'; // must load early to catch beforeinstallprompt
import { store } from './state/store';
import { App } from './ui/App';
import './styles/app.css';

render(<App />, document.getElementById('app')!);
void boot();

// Any user interaction postpones auto-lock.
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
  addEventListener(ev, activity, { passive: true, capture: true });
}

// Keep keys out of the back/forward cache snapshot.
addEventListener('pagehide', () => {
  if (store.state.phase === 'ready') lock();
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Trusted Types are enforced by our CSP; this single policy only ever yields our own worker URL.
  const tt = (window as unknown as { trustedTypes?: { createPolicy(n: string, p: object): { createScriptURL(s: string): string } } }).trustedTypes;
  const policy = tt?.createPolicy('veil-sw', {
    createScriptURL: (u: string) => {
      if (u !== './sw.js') throw new TypeError('blocked script URL');
      return u;
    },
  });
  addEventListener('load', () => {
    navigator.serviceWorker.register(policy ? policy.createScriptURL('./sw.js') : './sw.js', { scope: './' }).catch(() => {});
  });
}
