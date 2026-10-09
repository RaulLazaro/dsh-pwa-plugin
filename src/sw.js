// Cache names. The raw source carries a placeholder that src/host/index.js
// replaces with the package version when serving /sw.js, so every package
// upgrade produces a byte-new worker whose activate step purges the caches of
// older versions without anyone hand-bumping a version string here.
const CACHE_NAME = 'dsh-pwa-__DSH_PWA_CACHE_VERSION__';
const STATIC_CACHE = 'dsh-static-__DSH_PWA_CACHE_VERSION__';

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

// DSH dynamic routes registered outside /api: identity JSON, the OAuth
// callback, the application catalog and this plugin's own version endpoint.
// They answer with data or redirects, so they must reach the network on every
// request instead of being pinned by the static cache-first branch.
const BYPASS_PREFIXES = [
  '/api',
  '/auth-api',
  '/hooks',
  '/oauth',
  '/open-in-app',
  '/plugins',
  '/dsh-pwa',
  '/ws'
];

function bypasses(url, request) {
  return (
    BYPASS_PREFIXES.some((prefix) =>
      url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
    ) || request.headers.get('upgrade') === 'websocket'
  );
}

// A response may enter the cache only when it is a successful same-origin
// reply the server allows us to store: 5xx navigations must never become the
// offline fallback, and `Cache-Control: no-store` means exactly that.
function isStorable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cacheControl = response.headers?.get?.('cache-control');
  return !(cacheControl && /(?:^|,)\s*no-store\b/i.test(cacheControl));
}

// Install event: pre-cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) =>
        // cache.addAll is atomic: one missing asset (a favicon DSH core does
        // not serve, a transient 503, ...) would reject the whole install and
        // leave the worker redundant forever, because an unchanged script
        // never triggers a new install. Add each URL on its own instead.
        Promise.all(
          PRE_CACHE_URLS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[DSH PWA] pre-cache skipped:', url, err);
            })
          )
        )
      )
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

  // Skip DSH dynamic routes, WebSocket upgrades, and plugin hot-reload paths
  if (bypasses(url, request)) return;

  // Network-first for HTML (SPA navigation)
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isStorable(response)) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              safeCachePut(cache, request, responseClone);
            });
          }
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
          // Only cache successful, storable same-origin responses
          if (!isStorable(response)) {
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
