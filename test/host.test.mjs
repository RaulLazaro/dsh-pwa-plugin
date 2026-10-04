import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { name, inject, apply } from '../src/host/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeCtx() {
  const routes = new Map();
  const taps = [];
  const logs = { info: [], warn: [] };
  const cleanups = [];
  const ctx = {
    webServer: {
      register({ kind, path, handler }) {
        routes.set(path, { kind, handler });
        return () => routes.delete(path);
      },
      tapIndex(fn) {
        taps.push(fn);
        return () => { const i = taps.indexOf(fn); if (i !== -1) taps.splice(i, 1); };
      },
    },
    logger: {
      info: (msg) => logs.info.push(msg),
      warn: (msg) => logs.warn.push(msg),
    },
    effect(fn) {
      const cleanup = fn();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  return { ctx, routes, taps, logs, cleanups };
}

function makeRes() {
  return {
    code: null,
    headers: null,
    body: undefined,
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    end(body) { this.body = body; this.ended = true; },
  };
}

test('exports the expected bundle identity (name + webServer inject)', () => {
  assert.equal(name, 'dsh-pwa');
  assert.ok(inject.includes('webServer'), 'webServer must be injected: every route handler uses ctx.webServer');
});

test('apply registers the full route set as exact matches', () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      '/dsh-pwa/version',
      '/icons/icon-192-maskable.png',
      '/icons/icon-192.png',
      '/icons/icon-512-maskable.png',
      '/icons/icon-512.png',
      '/manifest.webmanifest',
      '/sw.js',
    ]
  );
  for (const { kind } of routes.values()) assert.equal(kind, 'exact');
});

test('/sw.js is served with no-cache and the real source', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/sw.js').handler({}, res);
  assert.equal(res.code, 200);
  assert.match(res.headers['Content-Type'], /application\/javascript/);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(res.body, readFileSync(join(root, 'src', 'sw.js'), 'utf-8'));
});

test('/manifest.webmanifest is served as manifest JSON overriding the built-in', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/manifest.webmanifest').handler({}, res);
  assert.equal(res.code, 200);
  assert.match(res.headers['Content-Type'], /application\/manifest\+json/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.name, 'DeepSeek Harness');
  assert.equal(parsed.display, 'standalone');
});

test('all four icons serve real PNG bytes', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const path of routes.keys()) {
    if (!path.startsWith('/icons/')) continue;
    const res = makeRes();
    await routes.get(path).handler({}, res);
    assert.equal(res.code, 200, `${path} should serve`);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.ok(res.body.length > 0, `${path} empty`);
    assert.equal(res.headers['Content-Length'], res.body.length);
  }
});

test('/dsh-pwa/version reports the package identity', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/dsh-pwa/version').handler({}, res);
  assert.equal(res.code, 200);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  assert.deepEqual(JSON.parse(res.body), { version: pkg.version, name: pkg.name });
});

test('index tap injects the registration script before </body>', () => {
  const { ctx, taps } = makeCtx();
  apply(ctx);
  assert.equal(taps.length, 1, 'exactly one index tap');
  const tap = taps[0];
  const html = '<html><body><div id="root"></div></body></html>';
  const out = tap(html);
  const scriptAt = out.indexOf('serviceWorker.register');
  const bodyAt = out.lastIndexOf('</body>');
  assert.ok(scriptAt !== -1, 'registration script missing');
  assert.ok(scriptAt < bodyAt, 'script must be injected before </body>');
  assert.match(out, /sw\.js.*scope:\s*'\/'/s);

  // no </body> at all -> appended rather than dropped
  const orphan = '<html><body>partial';
  const appended = tap(orphan);
  assert.ok(appended.startsWith(orphan));
  assert.ok(appended.includes('serviceWorker.register'));
});

test('the effect cleanup disposes every route and the tap (HMR unmount)', () => {
  const { ctx, routes, taps, cleanups } = makeCtx();
  apply(ctx);
  assert.equal(cleanups.length, 1, 'apply must register exactly one effect');
  assert.equal(typeof cleanups[0], 'function', 'cordis expects the effect to return its disposer');
  assert.equal(routes.size, 7);
  cleanups[0]();
  assert.equal(routes.size, 0, 'all routes must be unregistered');
  assert.equal(taps.length, 0, 'the index tap must be removed');
});
