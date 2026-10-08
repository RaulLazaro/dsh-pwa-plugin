import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const name = 'dsh-pwa';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.effect(() => {
    const { webServer } = ctx;

    const pkgPath = join(__dirname, '..', '..', 'package.json');
    function readPackage() {
      try {
        return JSON.parse(readFileSync(pkgPath, 'utf-8'));
      } catch {
        return null;
      }
    }

    // 1. Serve /sw.js — service worker with no-cache headers
    const swSource = join(__dirname, '..', 'sw.js');
    const disposeSw = webServer.register({
      kind: 'exact',
      path: '/sw.js',
      handler: async (_req, res) => {
        try {
          // Stamp the cache names with the package version so upgrading the
          // package invalidates (and activate purges) every older cache.
          const version = readPackage()?.version ?? 'unknown';
          const content = readFileSync(swSource, 'utf-8')
            .replaceAll('__DSH_PWA_CACHE_VERSION__', version);
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

    // 4. Inject SW registration script into index.html
    const disposeTap = webServer.tapIndex((html) => {
      const script = `<script>
(function() {
  if (!('serviceWorker' in navigator)) return;
  // Captured before registering: on the very first visit there is no
  // controller yet, and this worker claims existing clients right after
  // install. That claim fires controllerchange too, and reloading there
  // would bounce the user's very first page load.
  var hadController = !!navigator.serviceWorker.controller;
  var refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    if (!hadController) { hadController = true; return; }
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function(reg) {
    console.log('[DSH PWA] SW registered, scope:', reg.scope);
    setInterval(function() { reg.update(); }, 3600000);
    reg.addEventListener('updatefound', function() {
      var sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', function() {
        if (sw.state === 'activated' && navigator.serviceWorker.controller) {
          sw.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
  }).catch(function(e) { console.log('[DSH PWA] SW failed:', e); });
})();
</script>`;
      const i = html.lastIndexOf('</body>');
      return i !== -1 ? html.slice(0, i) + script + html.slice(i) : html + script;
    });

    // 5. Version check endpoint
    const disposeVersion = webServer.register({
      kind: 'exact',
      path: '/dsh-pwa/version',
      handler: async (_req, res) => {
        const pkg = readPackage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          pkg
            ? { version: pkg.version, name: pkg.name }
            : { version: 'unknown', name: 'dsh-pwa-plugin' }
        ));
      }
    });

    ctx.logger.info('[DSH PWA] loaded — service worker + manifest + icons active');

    return () => { disposeSw(); disposeManifest(); disposeIcons.forEach(d => d()); disposeTap(); disposeVersion(); };
  });
}
