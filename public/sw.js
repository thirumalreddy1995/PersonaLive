// PersonaLive Desktop Studio - Service Worker
// Provides offline runtime caching and instant auto-updates when new changes are pushed.

const CACHE_NAME = 'personalive-v2.4.1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
];

// Install: Cache essential app shell and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => {
      // Force this service worker to become active without waiting
      return self.skipWaiting();
    })
  );
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
