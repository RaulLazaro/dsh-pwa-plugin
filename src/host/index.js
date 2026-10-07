import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_COOKIE_MAX_AGE_DAYS,
  addDevice,
  cookieAuthenticated,
  cookieName,
  describeDevices,
  findDevice,
  hashKey,
  loadDevices,
  loadSecret,
  mintCookie,
  newDeviceKey,
  removeDevice,
  requestAuthority,
  saveDevices,
  touchDevice
} from '../device.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The cookie identity and the session minting live in ../device.js, together
// with the test that pins them against literals derived from the dsh source.
//
// The credentials file and the device record live in the harness home.
// DSH_PWA_HOME is a test seam: it lets a test drive the routes against a
// temporary directory instead of the real home, which matters because the
// enrollment route writes.
function dshHome() {
  for (const candidate of [process.env.DSH_PWA_HOME, process.env.DSH_HOME]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return join(homedir(), '.dsh');
}

export const name = 'dsh-pwa';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.effect(() => {
    const { webServer } = ctx;

    const credentialsPath = join(dshHome(), '.credentials.yaml');
    const devicesPath = join(dshHome(), 'dsh-pwa-devices.json');

    // 1. Serve /sw.js — service worker with no-cache headers.
    //    NOTE: /sw.js is claimed as an exact route, so this plugin is the single
    //    owner of the root scope. DSH ships no worker at that path (verified
    //    2026-10-07: this route answers, with this plugin's own headers). A second
    //    plugin claiming /sw.js would race this one; the Web Push fork uses the
    //    disjoint /__dsh/web-push/ scope for exactly that reason.
    const swSource = join(__dirname, '..', 'sw.js');
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    // The worker derives its cache names from the package version, so the version
    // token is substituted on every request (the file is read per request anyway).
    // A failed read leaves the token in place, which is still a valid cache name.
    const packageVersion = () => {
      try {
        return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0';
      } catch {
        return '0';
      }
    };
    const disposeSw = webServer.register({
      kind: 'exact',
      path: '/sw.js',
      handler: async (_req, res) => {
        try {
          const content = readFileSync(swSource, 'utf-8').replaceAll('__DSH_PWA_VERSION__', packageVersion());
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Service-Worker-Allowed': '/'
          });
          res.end(content);
        } catch (err) {
          ctx.logger.warn(`[DSH PWA] sw.js: ${err.message}`);
          res.writeHead(500);
          res.end();
        }
      }
    });

    // 2. Serve enhanced manifest (overrides DSH's minimal built-in one)
    const manifestPath = join(__dirname, '..', '..', 'public', 'manifest.webmanifest');
    const disposeManifest = webServer.register({
      kind: 'exact',
      path: '/manifest.webmanifest',
      handler: async (_req, res) => {
        try {
          const content = readFileSync(manifestPath, 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'application/manifest+json; charset=utf-8',
            'Cache-Control': 'no-cache'
          });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end();
        }
      }
    });

    // 3. Serve the PWA icons.
    //    NOTE: /favicon.svg is NOT served here — DSH's built-in handles it, and
    //    shadowing it would fight the light/dark scheme link dsh already ships
    //    (index.html links favicon.svg for light and favicon-dark.svg for dark).
    //    Those are dsh's own marks in its own colours, so the origin gets its
    //    own raster favicon instead: /favicon.ico plus a PNG <link> injected in
    //    the head below, which is what Chrome uses for the site identity in the
    //    Android notification shade. Without it Chrome synthesises a monogram
    //    from the host name (the grey "V" seen on the phone) because dsh ships
    //    SVG favicons only.
    const publicDir = join(__dirname, '..', '..', 'public');
    function serveStatic(routePath, filePath, mime) {
      return webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (_req, res) => {
          try {
            if (!existsSync(filePath)) { res.writeHead(404); res.end(); return; }
            const content = readFileSync(filePath);
            res.writeHead(200, {
              'Content-Type': mime,
              'Cache-Control': 'public, max-age=86400',
              'Content-Length': content.length
            });
            res.end(content);
          } catch (err) {
            ctx.logger.warn(`[DSH PWA] static serve error for ${routePath}: ${err.message}`);
            res.writeHead(500);
            res.end();
          }
        }
      });
    }
    const disposeIcons = [
      serveStatic('/icons/icon.svg',              join(publicDir, 'icons', 'icon.svg'),              'image/svg+xml'),
      serveStatic('/icons/icon-monochrome.svg',   join(publicDir, 'icons', 'icon-monochrome.svg'),   'image/svg+xml'),
      serveStatic('/icons/icon-32.png',           join(publicDir, 'icons', 'icon-32.png'),           'image/png'),
      serveStatic('/icons/icon-192.png',          join(publicDir, 'icons', 'icon-192.png'),          'image/png'),
      serveStatic('/icons/icon-512.png',          join(publicDir, 'icons', 'icon-512.png'),          'image/png'),
      serveStatic('/icons/icon-192-maskable.png', join(publicDir, 'icons', 'icon-192-maskable.png'), 'image/png'),
      serveStatic('/icons/icon-512-maskable.png', join(publicDir, 'icons', 'icon-512-maskable.png'), 'image/png'),
      serveStatic('/apple-touch-icon.png',        join(publicDir, 'apple-touch-icon.png'),           'image/png'),
      serveStatic('/favicon.ico',                 join(publicDir, 'favicon.ico'),                    'image/x-icon'),
    ];

    // 3b. Serve the install-card screenshots.
    //     Chrome fetches these itself while it renders the richer install dialog,
    //     before any page of the app is on screen, so they come from the same
    //     per-request directory read as the rest of the static files here. One
    //     prefix route covers the directory, and the requested name is matched
    //     against a fresh listing of it, which is what makes path traversal
    //     impossible: there is no path arithmetic left to get wrong.
    const screenshotsDir = join(publicDir, 'screenshots');
    const SCREENSHOT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
    const SCREENSHOT_PREFIX = '/screenshots/';
    const disposeScreenshots = webServer.register({
      kind: 'prefix',
      path: '/screenshots',
      handler: async (req, res) => {
        try {
          // The route table matches on the pathname but hands the handler the
          // original request, query string and all.
          const rawPath = String(req.url ?? '').split('?')[0];
          const rel = rawPath.startsWith(SCREENSHOT_PREFIX) ? rawPath.slice(SCREENSHOT_PREFIX.length) : '';
          let name = '';
          try {
            name = rel.length > 0 ? decodeURIComponent(rel) : '';
          } catch {
            name = '';
          }
          // Two gates, and the second is the real one: the name must be a bare
          // file name (basename also rejects a backslash, which join treats as a
          // separator on Windows) and it must appear in the directory listing, so
          // nothing outside public/screenshots can be opened.
          const type = SCREENSHOT_TYPES[extname(name).toLowerCase()];
          if (name.length === 0 || basename(name) !== name || type === undefined || !readdirSync(screenshotsDir).includes(name)) {
            res.writeHead(404);
            res.end();
            return;
          }
          const content = readFileSync(join(screenshotsDir, name));
          res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'public, max-age=86400',
            'Content-Length': content.length
          });
          res.end(content);
        } catch (err) {
          ctx.logger.warn(`[DSH PWA] screenshots serve error: ${err.message}`);
          res.writeHead(404);
          res.end();
        }
      }
    });

    // 4. Inject SW registration + the client-side fixes into index.html.
    //    Both fixes are inlined rather than served as a <script src>: the service
    //    worker answers non-HTML GETs cache-first, so an external file would pin
    //    its first version forever.
    const clientFixPaths = [
      join(__dirname, '..', 'mobile-composer.js'),
      join(__dirname, '..', 'pwa-client.js')
    ];
    const disposeTap = webServer.tapIndex((html) => {
      const script = `<script>
(function() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function(reg) {
    console.log('[DSH PWA] SW registered, scope:', reg.scope);
    // One timer per document; it dies with the document on the controllerchange
    // reload below, so there is nothing to clear.
    setInterval(function() { reg.update(); }, 3600000);
    reg.addEventListener('updatefound', function() {
      var sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', function() {
        // "installed" is the moment a worker is waiting behind the active one.
        // Testing for "activated" is too late: it is already running, so the
        // message is a no-op and the update waits for every tab to close.
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          sw.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
  }).catch(function(e) { console.log('[DSH PWA] SW failed:', e); });
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    window.location.reload();
  });
})();
</script>`;
      const inlined = [];
      for (const file of clientFixPaths) {
        try {
          inlined.push(readFileSync(file, 'utf-8'));
        } catch (err) {
          ctx.logger.warn(`[DSH PWA] ${basename(file)}: ${err.message}`);
        }
      }
      const block = [script, ...inlined.map((source) => `<script>
${source}
</script>`)].join('\n');
      // The origin's own icon identity. dsh links SVG favicons only, so Chrome
      // has nothing raster to use for the site identity in the Android
      // notification shade and synthesises a monogram from the host name
      // instead (the grey "V" on the phone is the first letter of the tailnet
      // host, not one of our icons). A PNG <link> plus a real /favicon.ico is
      // what that fallback needs; the apple-* metas are for iOS, which ignores
      // the manifest's icons when adding to the home screen.
      //
      // No <meta name="theme-color"> here on purpose: a meta tag overrides the
      // manifest's theme_color, so a second copy of the colour drifts from the
      // manifest the moment either one changes, and it is host code that only a
      // restart republishes. The manifest is the single source for it.
      const headTags = `<link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="DSH">`;
      let out = html;
      const headEnd = out.indexOf('</head>');
      // Without a </head> the tags ride along with the scripts rather than
      // preempting the document, so a partial fragment keeps its own prefix.
      const bodyBlock = headEnd !== -1 ? block : headTags + block;
      out = headEnd !== -1 ? out.slice(0, headEnd) + headTags + out.slice(headEnd) : out;
      const i = out.lastIndexOf('</body>');
      return i !== -1 ? out.slice(0, i) + bodyBlock + out.slice(i) : out + bodyBlock;
    });

    // 5. Version check endpoint
    const disposeVersion = webServer.register({
      kind: 'exact',
      path: '/dsh-pwa/version',
      handler: async (_req, res) => {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: pkg.version, name: pkg.name }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: 'unknown', name: 'dsh-pwa-plugin' }));
        }
      }
    });

    // 6. Authentication probe.
    //    WHY: the token fence mints a signed cookie with a 30 day Max-Age, so an
    //    installed app should not ask for a code again on the same device. When
    //    it does, the cause is one of exactly three: the phone never got the
    //    cookie (the code was entered in another browser jar), the phone got it
    //    and dropped it (a SameSite=Strict cookie in an installed app), or it is
    //    holding it and the fence still refuses. This endpoint separates those
    //    three without exposing a secret: the cookie NAME is a SHA-256 of the
    //    authority, so it is derivable by anyone, and the reply carries only
    //    presence and length - never the value, never the signature.
    //    It answers 204 unless the caller sends x-dsh-pwa-probe: 1, so a plain
    //    navigation or an <img> probe learns nothing (a cross-origin caller
    //    cannot set that header without a preflight, and no CORS headers are
    //    returned).
    const disposeAuthState = webServer.register({
      kind: 'exact',
      path: '/dsh-pwa/auth-state',
      handler: async (req, res) => {
        try {
          const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
          if (req.headers?.['x-dsh-pwa-probe'] !== '1') {
            res.writeHead(204, headers);
            res.end();
            return;
          }
          const authority = requestAuthority(req.headers?.host);
          const name = authority === undefined ? undefined : cookieName(authority);
          let length = 0;
          for (const segment of String(req.headers?.cookie ?? '').split(';')) {
            const at = segment.indexOf('=');
            if (at === -1 || segment.slice(0, at).trim() !== name) continue;
            length = segment.slice(at + 1).trim().length;
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify({
            authority: authority ?? null,
            cookieName: name ?? null,
            cookiePresent: length > 0,
            cookieLength: length,
            // The sign-in page needs the fence's own verdict, not a guess: the app
            // shell is cached, so fetching '/' to test a cookie can be answered
            // from the cache and report success for a cookie the fence rejects.
            cookieValid: authenticated(req),
            canMint: loadSecret(credentialsPath) !== undefined,
            deviceCount: loadDevices(devicesPath).devices.length
          }));
        } catch (err) {
          ctx.logger.warn(`[DSH PWA] auth-state: ${err.message}`);
          res.writeHead(500);
          res.end();
        }
      }
    });

    // 7. Trusted devices.
    //    WHY: the fence gates the index and nothing else, so these routes still
    //    answer a phone that is locked out - which is the point, and also why
    //    enrollment has to check the cookie itself. A device key buys a freshly
    //    minted session cookie, so the phone signs in once and stays signed in.
    const sendJson = (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    const readJsonBody = async (req, limit = 4096) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return undefined;
        chunks.push(chunk);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return undefined;
      }
    };

    // A device key is a durable credential, so enrollment must not be open to
    // anyone who can reach the host: the caller has to already hold a session.
    const authenticated = (req) => {
      const secret = loadSecret(credentialsPath);
      if (secret === undefined) return false;
      return cookieAuthenticated(
        { hostHeader: req.headers?.host, cookieHeader: req.headers?.cookie },
        secret,
        DEVICE_COOKIE_MAX_AGE_DAYS
      );
    };

    const disposeDevice = webServer.register({
      kind: 'exact',
      path: '/dsh-pwa/device',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            if (!authenticated(req)) { sendJson(res, 401, { error: 'authentication required' }); return; }
            sendJson(res, 200, {
              devices: describeDevices(loadDevices(devicesPath)),
              canMint: loadSecret(credentialsPath) !== undefined
            });
            return;
          }
          if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return; }
          if (!authenticated(req)) { sendJson(res, 401, { error: 'authentication required' }); return; }
          const body = await readJsonBody(req);
          const label = typeof body?.label === 'string' && body.label.trim() !== ''
            ? body.label.trim().slice(0, 40)
            : 'Device';
          const key = newDeviceKey();
          const id = randomBytes(8).toString('hex');
          saveDevices(devicesPath, addDevice(loadDevices(devicesPath), {
            id,
            label,
            keyHash: hashKey(key),
            now: Date.now()
          }));
          sendJson(res, 200, { id, key, label });
        } catch (err) {
          ctx.logger.warn(`[DSH PWA] device enroll: ${err.message}`);
          sendJson(res, 500, { error: 'enrollment failed' });
        }
      }
    });

    // The one route that must answer without a session, because a session is
    // what the caller is trying to obtain.
    const disposeClaim = webServer.register({
      kind: 'exact',
      path: '/dsh-pwa/device/claim',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
          const body = await readJsonBody(req);
          const key = typeof body?.key === 'string' ? body.key : '';
          const state = loadDevices(devicesPath);
          const device = findDevice(state, key);
          if (device === undefined) { sendJson(res, 401, { error: 'unknown device' }); return; }
          const authority = requestAuthority(req.headers?.host);
          const secret = loadSecret(credentialsPath);
          if (authority === undefined || secret === undefined) {
            sendJson(res, 503, { error: 'this host cannot mint a session cookie' });
            return;
          }
          const cookie = mintCookie({ authority, secret, maxAgeDays: DEVICE_COOKIE_MAX_AGE_DAYS });
          saveDevices(devicesPath, touchDevice(state, device.id, Date.now()));
          res.writeHead(204, { 'Set-Cookie': cookie.header, 'Cache-Control': 'no-store' });
          res.end();
        } catch (err) {
          ctx.logger.warn(`[DSH PWA] device claim: ${err.message}`);
          sendJson(res, 500, { error: 'claim failed' });
        }
      }
    });

    const disposeForget = webServer.register({
      kind: 'exact',
      path: '/dsh-pwa/device/forget',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
          if (!authenticated(req)) { sendJson(res, 401, { error: 'authentication required' }); return; }
          const body = await readJsonBody(req);
          const id = typeof body?.id === 'string' ? body.id : '';
          const state = loadDevices(devicesPath);
          const next = removeDevice(state, id);
          if (next.devices.length === state.devices.length) {
            sendJson(res, 404, { error: 'unknown device' });
            return;
          }
          saveDevices(devicesPath, next);
          sendJson(res, 200, { removed: state.devices.length - next.devices.length });
        } catch (err) {
          ctx.logger.warn(`[DSH PWA] device forget: ${err.message}`);
          sendJson(res, 500, { error: 'forget failed' });
        }
      }
    });

    ctx.logger.info('[DSH PWA] loaded — service worker + manifest + icons + screenshots + auth probe + device trust active');

    return () => { disposeSw(); disposeManifest(); disposeIcons.forEach(d => d()); disposeScreenshots(); disposeTap(); disposeVersion(); disposeAuthState(); disposeDevice(); disposeClaim(); disposeForget(); };
  });
}
