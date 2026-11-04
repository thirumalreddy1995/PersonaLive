// PersonaLive Desktop Studio - Service Worker
// Provides offline runtime caching and instant auto-updates when new changes are pushed.

// __BUILD_ID__ is replaced at build time (see vite.config.ts) so every deploy ships a new worker.
const BUILD_ID = '__BUILD_ID__';
const CACHE_NAME = `personalive-${BUILD_ID}`;
// Resolve the app shell relative to where this worker is served (works at / and at /<repo>/).
const BASE = new URL('./', self.location.href).href;
const STATIC_ASSETS = ['', 'index.html', 'manifest.json', 'icon.svg'].map((f) => BASE + f);

// Install: cache the app shell. The new worker then stays in the "waiting" state until the user
// clicks "Update Ready — Restart" (which posts SKIP_WAITING, see below) or the app is relaunched.
// Activating immediately here would trigger `controllerchange` and reload the page mid-session.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
});

// Activate: Clean up old caches and take control of all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => {
      // Take control of all pages immediately so the new version is live
      return self.clients.claim();
    })
  );
});

// Fetch: Network-first for HTML / code bundles (so updates are seen immediately),
// with fallback to cache for offline desktop use
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Bypass chrome-extension and external analytics
  if (!url.protocol.startsWith('http')) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Clone and store valid responses in cache
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // If network fails (offline), serve from cache
        return caches.match(event.request);
      })
  );
});

// Listen for skip waiting messages from the UI
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
