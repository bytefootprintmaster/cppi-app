/**
 * CPPI service worker.
 *
 * Deliberately conservative: it exists so the app is installable and so a
 * flaky connection still opens the shell. It never touches /api, so sessions,
 * presigned S3 URLs and file uploads always go straight to the network.
 */
const CACHE = 'cppi-shell-v1'

const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never cache the API — auth and download URLs must always be live.
  if (url.pathname.startsWith('/api')) return

  // Navigations go to the network first so a deploy is picked up immediately,
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')))
    return
  }

  // Fingerprinted build output is immutable, so serve it from cache.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
    })
  )
})
