import { test } from 'node:test';
import vm from 'node:vm';
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

test('/sw.js is served with no-cache and the version-stamped source', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/sw.js').handler({}, res);
  assert.equal(res.code, 200);
  assert.match(res.headers['Content-Type'], /application\/javascript/);
  assert.match(res.headers['Cache-Control'], /no-store/);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const expected = readFileSync(join(root, 'src', 'sw.js'), 'utf-8')
    .replaceAll('__DSH_PWA_CACHE_VERSION__', pkg.version);
  assert.equal(res.body, expected);
});

test('/sw.js substitutes the cache-version placeholder with the package version', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/sw.js').handler({}, res);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  assert.equal(res.code, 200);
  assert.ok(
    !res.body.includes('__DSH_PWA_CACHE_VERSION__'),
    'the raw placeholder must never reach the browser'
  );
  assert.ok(res.body.includes(`dsh-static-${pkg.version}`), 'static cache must carry the package version');
  assert.ok(res.body.includes(`dsh-pwa-${pkg.version}`), 'runtime cache must carry the package version');
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


// Boot the exact script the index tap injects inside a sandboxed VM, so the
// registration flow is exercised behaviourally instead of by regex alone.
function bootRegistration({ controller = null, registerError = null } = {}) {
  const events = {};
  const registerCalls = [];
  const reloads = [];
  const logs = [];
  const reg = {
    scope: '/',
    addEventListener() {},
    update() {},
  };
  const sandbox = {
    navigator: {
      serviceWorker: {
        controller,
        addEventListener(type, fn) { events[type] = fn; },
        register(url, opts) {
          registerCalls.push({ url, opts });
          return registerError ? Promise.reject(registerError) : Promise.resolve(reg);
        },
      },
    },
    window: { location: { reload() { reloads.push(1); } } },
    setInterval: () => 0,
    console: { log: (...args) => logs.push(args.join(' ')) },
  };
  const { ctx, taps } = makeCtx();
  apply(ctx);
  const html = taps[0]('<html><body></body></html>');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'injected registration script missing');
  vm.runInNewContext(match[1], sandbox);
  return { events, registerCalls, reloads, logs };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the injected script registers /sw.js at root scope', async () => {
  const { registerCalls, events } = bootRegistration();
  await flush();
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0].url, '/sw.js');
  assert.equal(registerCalls[0].opts.scope, '/', 'registration must keep the root scope');
  assert.equal(typeof events.controllerchange, 'function', 'controllerchange listener required');
});

test('first visit: the install claim does not reload the page', async () => {
  const { events, reloads } = bootRegistration({ controller: null });
  await flush();
  events.controllerchange(); // clients.claim() right after the first install
  assert.equal(reloads.length, 0, 'a first-time clients.claim() must not bounce the page');
  events.controllerchange(); // a real update activating later in the same page lifetime
  assert.equal(reloads.length, 1, 'genuine updates must still reload afterwards');
});

test('an update reloads exactly once even if controllerchange fires twice', async () => {
  const { events, reloads } = bootRegistration({ controller: { scriptURL: 'https://dsh.local/sw.js' } });
  await flush();
  events.controllerchange();
  events.controllerchange();
  assert.equal(reloads.length, 1, 'exactly one reload per activated update');
});

test('a failed registration is contained and logged', async () => {
  const { logs, reloads } = bootRegistration({ registerError: new Error('insecure context') });
  await flush();
  assert.ok(logs.some((line) => line.includes('SW failed')), 'failure must be visible in the console');
  assert.equal(reloads.length, 0, 'a failed registration must not reload anything');
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
