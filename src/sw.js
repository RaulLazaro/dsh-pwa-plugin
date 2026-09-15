const CACHE_NAME = 'dsh-pwa-v4';
const STATIC_CACHE = 'dsh-static-v4';

// Assets to pre-cache on install
const PRE_CACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png'
];

// Offline fallback page
const OFFLINE_PAGE = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH - Offline</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; padding: 2rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { color: #94a3b8; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>You're offline</h1>
    <p>DeepSeek Harness needs a network connection.</p>
    <p>Please check your connection and try again.</p>
  </div>
</body>
</html>`;

// Safe cache put — swallows errors for unsupported schemes (chrome-extension://, etc.)
function safeCachePut(cache, request, response) {
  return cache.put(request, response).catch(() => {});
}

// Install event: pre-cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRE_CACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate event: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event: network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip non-HTTP(S) schemes (chrome-extension://, moz-extension://, etc.)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Skip API calls, WebSocket, and plugin hot-reload paths
  if (url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/plugins') ||
      url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/hooks') ||
      request.headers.get('upgrade') === 'websocket') {
    return;
  }

  // Network-first for HTML (SPA navigation)
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            safeCachePut(cache, request, responseClone);
          });
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            return cached || new Response(OFFLINE_PAGE, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          });
        })
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, fonts, images)
  event.respondWith(
    caches.match(request)
      .then((cached) => {
        if (cached) return cached;

        return fetch(request).then((response) => {
          // Only cache successful same-origin responses
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            safeCachePut(cache, request, responseClone);
          });

          return response;
        }).catch(() => {
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
      })
  );
});

// Listen for messages from the app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});
