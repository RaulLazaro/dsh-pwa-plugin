// Both cache names are derived from the plugin version, which the host route
// substitutes into this file on every request. A fixed name would leave an
// installed client pinned to a previous pre-cache set until it cleared storage
// by hand, so a version bump is the whole invalidation procedure.
const VERSION = '__DSH_PWA_VERSION__';
const CACHE_NAME = `dsh-pwa-${VERSION}`;
const STATIC_CACHE = `dsh-static-${VERSION}`;

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

// The dsh web token fence answers a locked-out navigation with a plain-text 401
// ("reopen the URL printed by dsh web"). In a browser that is fine - the address
// bar is right there - but an installed app has no address bar, so that body is
// a dead end. This page is the replacement: it takes the code (or the whole URL
// printed by dshw-token.ps1) and performs the same token exchange the address
// bar would, which is what mints the browser-session cookie.
const SIGN_IN_PAGE = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH - sign in</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { padding: 1.5rem; width: 100%; max-width: 26rem; }
    h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
    p { color: #94a3b8; line-height: 1.5; margin: 0.6rem 0; }
    code { background: #1e293b; padding: 0.1rem 0.35rem; border-radius: 0.25rem; color: #e2e8f0; }
    input { width: 100%; box-sizing: border-box; padding: 0.7rem; border-radius: 0.4rem; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; font-size: 1rem; }
    button { margin-top: 0.75rem; width: 100%; padding: 0.7rem; border: 0; border-radius: 0.4rem; background: #2563eb; color: #fff; font-size: 1rem; }
    .note { color: #f87171; min-height: 1.25rem; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to DSH</h1>
    <p id="note" class="note">__NOTE__</p>
    <p>On the machine running dsh, run <code>dshw-token.ps1</code> and paste the code below - the whole URL works too.</p>
    <form id="f">
      <input id="t" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="code or URL with token=">
      <button type="submit">Sign in</button>
    </form>
  </div>
  <script>
  (function () {
    var form = document.getElementById('f');
    var input = document.getElementById('t');
    var note = document.getElementById('note');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var raw = input.value.trim();
      var match = /[?&]token=([A-Za-z0-9_-]{20,})/.exec(raw);
      var code = match ? match[1] : raw;
      if (!/^[A-Za-z0-9_-]{20,}$/.test(code)) {
        if (note) note.textContent = 'That does not look like a code. It is the long random string after "token=".';
        return;
      }
      window.location.href = '/?token=' + encodeURIComponent(code);
    });
  })();
  </script>
</body>
</html>`;

const CODE_REJECTED = 'That code was not accepted. Codes are minted per dsh web run, so get a fresh one and try again.';

// A 200 rather than a 401: the response IS a working page, not an error, and the
// marker header keeps it distinguishable from the app shell it stands in for.
function signInResponse(note) {
  return new Response(SIGN_IN_PAGE.replace('__NOTE__', note), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-DSH-PWA-Signin': '1'
    }
  });
}

// Safe cache put — swallows errors for unsupported schemes (chrome-extension://, etc.)
function safeCachePut(cache, request, response) {
  return cache.put(request, response).catch(() => {});
}

// Install event: pre-cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // One URL at a time, not addAll: a locked-out client gets a 401 for '/'
      // (the dsh token fence), and addAll rejects as a whole, which would leave
      // the update permanently uninstalled - exactly when a client most needs
      // the newer worker. A missing pre-cache entry is recoverable offline; a
      // failed install is not.
      .then((cache) => Promise.all(PRE_CACHE_URLS.map((url) => cache.add(url).catch(() => {}))))
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
          // The fence's own 401 is plain text, so it is never cached and never
          // passed through: hand the user a page that can mint the cookie.
          // A 401 that still carries ?token= means that code was rejected.
          if (response.status === 401) {
            return signInResponse(url.searchParams.has('token') ? CODE_REJECTED : '');
          }
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
    event.ports[0].postMessage({ version: VERSION });
  }
});
