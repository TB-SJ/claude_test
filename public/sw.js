/* Service worker: app-shell caching (PWA/offline) + push notifications. */
'use strict';

// Bump this to force old shell caches to be dropped on the next activate.
const CACHE = 'app-shell-v1';
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell so updates always win, with a cache fallback
// so the app opens offline. API/data requests are never intercepted — they go
// straight to the network so nothing stale or private is served from cache.
function isShell(url) {
  return url.origin === self.location.origin
    && (url.pathname === '/' || SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const shell = request.mode === 'navigate' || isShell(url);
  if (!shell) return; // let API + everything else hit the network directly
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request.mode === 'navigate' ? '/' : request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request.mode === 'navigate' ? '/' : request).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Reminder', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Calendar';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
