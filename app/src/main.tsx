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
    navigator.serviceWorker
      .register(policy ? policy.createScriptURL('./sw.js') : './sw.js', { scope: './' })
      .then((reg) => {
        // Installed apps can stay open for days: look for new versions regularly.
        const check = () => void reg.update().catch(() => {});
        setInterval(check, 60 * 60_000);
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      })
      .catch(() => {});
  });

  // A new worker took control: the code on screen is outdated. Reload right away unless
  // the user is mid-conversation, in which case offer a reload instead of interrupting.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, not an update
    if (store.state.phase === 'ready') store.set({ updateReady: true });
    else location.reload();
  });
}
