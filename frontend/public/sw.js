// Deliberately hand-rolled instead of a build-time-generated precache list:
// Vite content-hashes JS/CSS filenames, so a stale cached bundle is simply
// never requested again once a fresh index.html (fetched network-first)
// points at new hashed URLs - no manual versioning of asset entries needed.
// Only the cache *name* below needs bumping if the strategy itself changes.
const CACHE = 'life-cache-v2'
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

// Static assets only: serve the cached copy instantly if there is one, then
// refresh it in the background for next time. NOT used for API reads - the
// app refetches these right after every write expecting the fresh result,
// so handing back a stale cached response there would silently show you
// yesterday's data until some later revalidation happened to catch up.
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

  // Static build assets: instant from cache, refreshed in the background.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request))
    return
  }

  // API reads: always prefer a live answer so you see your own writes right
  // away; only fall back to the last cached response when actually offline.
  if (url.origin === API_ORIGIN) {
    event.respondWith(networkFirst(request))
  }
})
