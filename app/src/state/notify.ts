import { randomId } from '../crypto/encoding';
import { isStandalone, detectPlatform } from './install';
import { store } from './store';

/**
 * Local notifications. Veil has no push server, so notifications are raised by the
 * running app itself when a message arrives on a live connection while Veil is in the
 * background. (If Veil is closed there is no connection, so nobody can message you.)
 *
 * Privacy rules:
 *   - Message content is never put in a notification.
 *   - Contact names only if the user opts in (they show on lock screens).
 *   - The notification payload carries a random per-session token, never a contact id.
 *     Tokens live only in memory and are forgotten on lock.
 *
 * Notifications are shown through the service worker where possible: Android browsers
 * and installed iOS apps do not allow `new Notification()` at all.
 */

export type NotifyPermission = 'granted' | 'default' | 'denied' | 'unsupported' | 'needs-install';

const TAG_PREFIX = 'veil-';
const tokens = new Map<string, string>(); // token -> chat
const tokenByChat = new Map<string, string>();
const pendingCount = new Map<string, number>(); // chat -> messages since last viewed

export function notifyPermission(): NotifyPermission {
  // iOS/iPadOS only exposes notifications to apps added to the Home Screen.
  if (detectPlatform() === 'ios' && !isStandalone()) return 'needs-install';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const p = notifyPermission();
  if (p !== 'default') return p;
  return Notification.requestPermission();
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg?.active) return reg;
  // During first load the worker may still be activating.
  return Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500))]);
}

function tokenFor(chat: string): string {
  let t = tokenByChat.get(chat);
  if (!t) {
    t = randomId();
    tokenByChat.set(chat, t);
    tokens.set(t, chat);
  }
  return t;
}

export interface NotifyInput {
  chat?: string;
  /** Shown as the title only when the user enabled sender names. */
  name?: string;
  kind: 'message' | 'file' | 'connected';
}

function text(n: NotifyInput, count: number, showNames: boolean): { title: string; body: string } {
  const who = showNames && n.name ? n.name : 'Veil';
  if (n.kind === 'connected') return { title: who, body: showNames && n.name ? 'Securely connected' : 'A contact securely connected' };
  if (n.kind === 'file') return { title: who, body: count > 1 ? `${count} new messages and files` : 'Sent you a file' };
  return { title: who, body: count > 1 ? `${count} new messages` : 'New message' };
}

/** Raise a notification if Veil is not in front and the user enabled them. */
export async function notify(n: NotifyInput): Promise<void> {
  const { settings } = store.state;
  if (!settings.notifications || document.visibilityState === 'visible') return;
  if (notifyPermission() !== 'granted') return;

  let count = 1;
  if (n.chat && n.kind !== 'connected') {
    count = (pendingCount.get(n.chat) ?? 0) + 1;
    pendingCount.set(n.chat, count);
  }
  const { title, body } = text(n, count, settings.notifyNames);
  const token = n.chat ? tokenFor(n.chat) : '';
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body,
    // One notification per conversation; newer messages replace it and buzz again.
    tag: TAG_PREFIX + (token || 'app'),
    renotify: true,
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [80, 40, 80],
    data: { token },
  };

  try {
    const reg = await registration();
    if (reg) return await reg.showNotification(title, options);
    const notif = new Notification(title, options);
    notif.onclick = () => {
      window.focus();
      openToken(token);
      notif.close();
    };
  } catch {
    /* platform refused - nothing else we can do without a server */
  }
}

/** Close notifications for one chat (or all) once the user has seen them. */
export async function clearNotifications(chat?: string): Promise<void> {
  if (chat) pendingCount.delete(chat);
  else pendingCount.clear();
  try {
    const reg = await registration();
    if (!reg) return;
    const tag = chat ? TAG_PREFIX + tokenFor(chat) : undefined;
    for (const n of await reg.getNotifications(tag ? { tag } : undefined)) {
      if (n.tag.startsWith(TAG_PREFIX)) n.close();
    }
  } catch {
    /* unsupported */
  }
}

let openHandler: ((chat: string) => void) | undefined;
export function onNotificationOpen(handler: (chat: string) => void) {
  openHandler = handler;
}

function openToken(token: string) {
  const chat = tokens.get(token);
  if (chat) openHandler?.(chat);
}

/** Forget every token and count (called on lock). */
export function resetNotifications() {
  void clearNotifications();
  tokens.clear();
  tokenByChat.clear();
}

/** Unread count on the app icon (installed PWAs) and in the tab title. */
let lastUnread = -1;
function syncUnread() {
  const s = store.state;
  const unread = s.phase === 'ready' ? s.contacts.reduce((n, c) => n + c.unread, 0) : 0;
  if (unread === lastUnread) return;
  lastUnread = unread;
  document.title = unread ? `(${unread > 99 ? '99+' : unread}) Veil` : 'Veil - private chat';
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (unread) void nav.setAppBadge?.(unread).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  } catch {
    /* Badging API unsupported */
  }
}

if (typeof window !== 'undefined') {
  store.subscribe(syncUnread);
  // Clicks on service-worker notifications arrive here.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data as { type?: string; token?: unknown };
    if (d?.type === 'veil-open' && typeof d.token === 'string') openToken(d.token);
  });
  document.addEventListener('visibilitychange', () => {
    const chat = store.state.activeChat;
    if (document.visibilityState === 'visible' && chat) void clearNotifications(chat);
  });
}
