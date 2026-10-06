import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const name = 'dsh-pwa';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.effect(() => {
    const { webServer } = ctx;

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

    // 3. Serve PWA icons (maskable + regular)
    //    NOTE: /favicon.svg is NOT served here — DSH's built-in handles it.
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
      serveStatic('/icons/icon-192.png',        join(publicDir, 'icons', 'icon-192.png'),        'image/png'),
      serveStatic('/icons/icon-192-maskable.png', join(publicDir, 'icons', 'icon-192-maskable.png'), 'image/png'),
      serveStatic('/icons/icon-512.png',        join(publicDir, 'icons', 'icon-512.png'),        'image/png'),
      serveStatic('/icons/icon-512-maskable.png', join(publicDir, 'icons', 'icon-512-maskable.png'), 'image/png'),
    ];

    // 4. Inject SW registration + the mobile composer fixes into index.html.
    //    The composer fix is inlined rather than served as a <script src>: the
    //    service worker answers non-HTML GETs cache-first, so an external file
    //    would pin its first version forever.
    const mobileComposerPath = join(__dirname, '..', 'mobile-composer.js');
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
      let mobileComposer = '';
      try {
        mobileComposer = readFileSync(mobileComposerPath, 'utf-8');
      } catch (err) {
        ctx.logger.warn(`[DSH PWA] mobile-composer.js: ${err.message}`);
      }
      const block = mobileComposer === '' ? script : `${script}
<script>
${mobileComposer}
</script>`;
      const i = html.lastIndexOf('</body>');
      return i !== -1 ? html.slice(0, i) + block + html.slice(i) : html + block;
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

    ctx.logger.info('[DSH PWA] loaded — service worker + manifest + icons active');

    return () => { disposeSw(); disposeManifest(); disposeIcons.forEach(d => d()); disposeTap(); disposeVersion(); };
  });
}
