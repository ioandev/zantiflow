// Minimal service worker: makes the dashboard installable and serves an offline shell. It NEVER
// caches /api/v1 responses (account-specific + auth-gated). Web-push handlers arrive in Phase 6.
const CACHE = 'zantiflow-shell-v2'
const SHELL = ['/', '/dashboard', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never intercept API or SSE traffic — always go to the network.
  if (url.pathname.startsWith('/api/')) return
  if (event.request.method !== 'GET') return

  // Network-first for navigations, falling back to the cached shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/dashboard').then((r) => r || caches.match('/'))))
    return
  }
  // Cache-first for other same-origin GETs (static assets).
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(event.request).then((r) => r || fetch(event.request)))
  }
})

// Web Push (ADR-0006): show the notification the backend delivered (privacy-safe text only).
self.addEventListener('push', (event) => {
  let data = { title: 'zantiflow', body: 'You have a notification' }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {
    /* non-JSON payload → keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'zantiflow',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) return c.focus()
      }
      return self.clients.openWindow('/dashboard')
    }),
  )
})
