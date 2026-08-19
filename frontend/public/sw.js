// Deliberately hand-rolled instead of a build-time-generated precache list:
// Vite content-hashes JS/CSS filenames, so a stale cached bundle is simply
// never requested again once a fresh index.html (fetched network-first)
// points at new hashed URLs - no manual versioning of asset entries needed.
// Only the cache *name* below needs bumping if the strategy itself changes.
const CACHE = 'life-cache-v1'
const API_ORIGIN = 'https://lifefolders-api.onrender.com'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// The app shell: always try the network first so a deploy shows up on the
// very next load, falling back to the last cached copy when offline or the
// backend's cold-starting.
async function networkFirst(request) {
  try {
    const fresh = await fetch(request)
    const cache = await caches.open(CACHE)
    cache.put(request, fresh.clone())
    return fresh
  } catch (err) {
    const cached = await caches.match(request)
    if (cached) return cached
    throw err
  }
}

// Static assets and API reads: serve the cached copy instantly if there is
// one (so offline/flaky-network doesn't mean a blank list), then refresh it
// in the background for next time.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((fresh) => {
      cache.put(request, fresh.clone())
      return fresh
    })
    .catch(() => undefined)
  return cached ?? (await network) ?? Response.error()
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  // Writes (POST/PATCH/DELETE) always go straight to network, uncached -
  // this also leaves sendBeacon (focus session end-on-close) untouched.
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Hash routing means there's exactly one navigable document.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  if (url.origin === self.location.origin || url.origin === API_ORIGIN) {
    event.respondWith(staleWhileRevalidate(request))
  }
})
