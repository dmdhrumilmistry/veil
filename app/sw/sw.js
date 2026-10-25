/* Veil service worker: offline app shell only. It never sees messages (those never touch the network
   as HTTP) and only caches same-origin GET responses for the app's own static files. */
const VERSION = '__VERSION__';
const CACHE = `veil-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('veil-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Network first so updates land quickly; fall back to the cached shell offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html', { ignoreSearch: true })),
    );
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});

// Tapping a notification focuses the open Veil window and opens that conversation. The payload is an
// opaque in-memory token, never a contact id; if Veil was closed meanwhile we simply open the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const token = event.notification.data?.token || '';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => w.focused) || wins[0];
      if (win) {
        await win.focus();
        win.postMessage({ type: 'veil-open', token });
        return;
      }
      await self.clients.openWindow('./');
    })(),
  );
});
