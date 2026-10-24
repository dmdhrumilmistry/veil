import { useEffect, useState } from 'preact/hooks';

/**
 * PWA install support. Chromium browsers (Chrome, Edge, Samsung Internet, Opera) fire
 * `beforeinstallprompt`, so we can offer a one-tap install button. Firefox and Safari
 * never do, so for them we show the exact menu steps instead.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type Platform = 'ios' | 'android-firefox' | 'android-samsung' | 'android-chrome' | 'desktop-firefox' | 'desktop-safari' | 'desktop-chromium' | 'other';

let deferred: InstallPromptEvent | undefined;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const DISMISS_KEY = 'veil-install-dismissed';

if (typeof window !== 'undefined') {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  addEventListener('appinstalled', () => {
    installed = true;
    deferred = undefined;
    emit();
  });
}

export function isStandalone(): boolean {
  return (
    installed ||
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function detectPlatform(ua = navigator.userAgent): Platform {
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports as macOS
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return 'ios';
  if (/Android/.test(ua)) {
    if (/Firefox|FxiOS/.test(ua)) return 'android-firefox';
    if (/SamsungBrowser/.test(ua)) return 'android-samsung';
    return 'android-chrome';
  }
  if (/Firefox/.test(ua)) return 'desktop-firefox';
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return 'desktop-safari';
  if (/Chrome|Chromium|Edg\//.test(ua)) return 'desktop-chromium';
  return 'other';
}

/** Step-by-step instructions for browsers without a programmatic install prompt. */
export function installSteps(p: Platform): string[] | undefined {
  switch (p) {
    case 'ios':
      return ['Open this page in Safari', 'Tap the Share button', 'Choose "Add to Home Screen", then "Add"'];
    case 'android-firefox':
      return ['Tap the menu (three dots)', 'Choose "Add app to Home screen"', 'Confirm with "Add"'];
    case 'android-samsung':
      return ['Tap the menu (three lines)', 'Choose "Add page to" then "Home screen"'];
    case 'android-chrome':
      return ['Tap the menu (three dots)', 'Choose "Install app" or "Add to Home screen"'];
    case 'desktop-safari':
      return ['Click File in the menu bar', 'Choose "Add to Dock"'];
    case 'desktop-chromium':
      return ['Click the install icon at the right of the address bar', 'Confirm with "Install"'];
    case 'desktop-firefox':
      return ['Firefox on desktop cannot install web apps yet', 'Use Chrome, Edge or Safari to install, or keep using Veil in this tab'];
    default:
      return undefined;
  }
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = undefined;
  await e.prompt();
  const { outcome } = await e.userChoice;
  emit();
  return outcome === 'accepted';
}

export function dismissInstall() {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* storage disabled */
  }
  emit();
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    const mq = matchMedia('(display-mode: standalone)');
    mq.addEventListener('change', l);
    return () => {
      listeners.delete(l);
      mq.removeEventListener('change', l);
    };
  }, []);
  const platform = detectPlatform();
  return {
    standalone: isStandalone(),
    canPrompt: !!deferred,
    platform,
    steps: installSteps(platform),
    dismissed: dismissed(),
  };
}
