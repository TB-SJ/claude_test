/* Service worker: app-shell caching (PWA/offline) + push notifications. */
'use strict';

// Bump this to force old shell caches to be dropped on the next activate.
const CACHE = 'app-shell-v2';
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
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined,
    // Keep everything the click handler needs (url + which task/event to act on).
    data: { url: data.url || '/', type: data.type, eventId: data.eventId, taskId: data.taskId },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an open window or open a new one at `url`.
function openApp(url) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(url || '/');
  });
}

const postJSON = (url, body) =>
  fetch(url, { method: url.startsWith('/tasks/') ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' }).catch(() => {});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();

  // Action buttons act without opening the app (cookies flow with the fetch).
  if (event.action === 'done' && d.taskId) {
    event.waitUntil(postJSON(`/tasks/${d.taskId}`, { done: true }));
    return;
  }
  if (event.action === 'snooze' && d.eventId) {
    event.waitUntil(postJSON('/push/snooze', { eventId: d.eventId, minutes: 10 }));
    return;
  }
  // Body tap or the explicit "Open" action → focus/open the app.
  event.waitUntil(openApp(d.url || '/'));
});
