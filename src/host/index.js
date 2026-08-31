import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const name = 'dsh-pwa';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.effect(() => {
    const { webServer } = ctx;

    // 1. Serve /sw.js
    const swSource = join(__dirname, '..', 'sw.js');
    const disposeSw = webServer.register({
      kind: 'exact',
      path: '/sw.js',
      handler: async (_req, res) => {
        try {
          const content = readFileSync(swSource, 'utf-8');
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

    // 2. Serve improved manifest
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

    // 3. Serve icons and favicon
    const publicDir = join(__dirname, '..', '..', 'public');
    function serveStatic(routePath, filePath, mime) {
      return webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (_req, res) => {
          if (!existsSync(filePath)) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
          res.end(readFileSync(filePath));
        }
      });
    }
    const disposeIcons = [
      serveStatic('/favicon.svg', join(publicDir, 'favicon.svg'), 'image/svg+xml'),
      serveStatic('/icons/icon-192.svg', join(publicDir, 'icons', 'icon-192.svg'), 'image/svg+xml'),
      serveStatic('/icons/icon-512.svg', join(publicDir, 'icons', 'icon-512.svg'), 'image/svg+xml'),
      serveStatic('/icons/icon-192.png', join(publicDir, 'icons', 'icon-192.png'), 'image/png'),
      serveStatic('/icons/icon-512.png', join(publicDir, 'icons', 'icon-512.png'), 'image/png'),
    ];

    // 3. Inject SW registration script into index.html
    const disposeTap = webServer.tapIndex((html) => {
      const script = `<script>
(function() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function(reg) {
    console.log('[DSH PWA] SW registered, scope:', reg.scope);
    setInterval(function() { reg.update(); }, 3600000);
    reg.addEventListener('updatefound', function() {
      var sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', function() {
        if (sw.state === 'activated' && navigator.serviceWorker.controller) {
          if (confirm('New DSH version available. Reload to update?')) {
            sw.postMessage({ type: 'SKIP_WAITING' });
            window.location.reload();
          }
        }
      });
    });
  }).catch(function(e) { console.log('[DSH PWA] SW failed:', e); });
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    window.location.reload();
  });
})();
</script>`;
      const i = html.lastIndexOf('</body>');
      return i !== -1 ? html.slice(0, i) + script + html.slice(i) : html + script;
    });

    ctx.logger.info('[DSH PWA] loaded — service worker + manifest active');

    return () => { disposeSw(); disposeManifest(); disposeIcons.forEach(d => d()); disposeTap(); };
  });
}
