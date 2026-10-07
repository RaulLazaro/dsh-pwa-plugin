import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { name, inject, apply } from '../src/host/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'vastus.tail4417fc.ts.net:3080';

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
      '/apple-touch-icon.png',
      '/dsh-pwa/auth-state',
      '/dsh-pwa/device',
      '/dsh-pwa/device/claim',
      '/dsh-pwa/device/forget',
      '/dsh-pwa/version',
      '/favicon.ico',
      '/icons/icon-192-maskable.png',
      '/icons/icon-192.png',
      '/icons/icon-32.png',
      '/icons/icon-512-maskable.png',
      '/icons/icon-512.png',
      '/icons/icon-monochrome.svg',
      '/icons/icon.svg',
      '/manifest.webmanifest',
      '/sw.js',
    ]
  );
  for (const { kind } of routes.values()) assert.equal(kind, 'exact');
});

test('/sw.js is served with no-cache and the version token substituted', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/sw.js').handler({}, res);
  assert.equal(res.code, 200);
  assert.match(res.headers['Content-Type'], /application\/javascript/);
  assert.match(res.headers['Cache-Control'], /no-store/);

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const raw = readFileSync(join(root, 'src', 'sw.js'), 'utf-8');
  assert.ok(raw.includes('__DSH_PWA_VERSION__'), 'the source must stay a template');

  // The served bytes differ from the source by the substitution and nothing else.
  assert.equal(
    res.body,
    raw.replaceAll('__DSH_PWA_VERSION__', pkg.version),
    'the worker must be served with the package version substituted'
  );
  assert.ok(res.body.includes(`const VERSION = '${pkg.version}'`), 'the worker must pin the package version');
  assert.ok(
    res.body.includes('dsh-pwa-${VERSION}') && res.body.includes('dsh-static-${VERSION}'),
    'both names must stay composed from VERSION'
  );
  assert.ok(!res.body.includes('__DSH_PWA_VERSION__'), 'no token may reach the browser');
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

// Every icon asset the manifest and the head reference, routed with the type its
// extension claims. The old assertion hard-coded four PNGs and would have gone on
// passing while /favicon.ico and the SVG icons were unrouted.
const ICON_ASSETS = {
  '/icons/icon.svg': 'image/svg+xml',
  '/icons/icon-monochrome.svg': 'image/svg+xml',
  '/icons/icon-32.png': 'image/png',
  '/icons/icon-192.png': 'image/png',
  '/icons/icon-512.png': 'image/png',
  '/icons/icon-192-maskable.png': 'image/png',
  '/icons/icon-512-maskable.png': 'image/png',
  '/apple-touch-icon.png': 'image/png',
  '/favicon.ico': 'image/x-icon',
};

test('every icon asset is routed and serves its declared content type', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const [path, type] of Object.entries(ICON_ASSETS)) {
    const res = makeRes();
    await routes.get(path).handler({}, res);
    assert.equal(res.code, 200, `${path} should serve`);
    assert.equal(res.headers['Content-Type'], type, `${path} content type`);
    assert.ok(res.body.length > 0, `${path} is empty`);
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

test('index tap inlines the mobile composer fix verbatim, before </body>', () => {
  const { ctx, taps } = makeCtx();
  apply(ctx);
  const out = taps[0]('<html><body><div id="root"></div></body></html>');
  const source = readFileSync(join(root, 'src', 'mobile-composer.js'), 'utf-8');
  assert.ok(out.includes(source), 'the mobile composer source must be inlined verbatim');
  assert.ok(
    out.indexOf(source) < out.lastIndexOf('</body>'),
    'the fix must land before </body> so it is installed with the app shell'
  );
  assert.ok(out.includes('__DSH_FORCE_MOBILE_COMPOSER__'), 'the test seam must survive injection');
});

test('the mobile composer fix ships inline, never as a cacheable <script src>', () => {
  const { ctx, taps } = makeCtx();
  apply(ctx);
  const out = taps[0]('<body></body>');
  // The plugin's own service worker answers non-HTML GETs cache-first, so an
  // external script would pin its first version and never receive a fix.
  assert.ok(
    !/<script[^>]+src=[^>]*mobile-composer/.test(out),
    'the fix must be inlined; a <script src> would be served cache-first forever'
  );
});

test('the effect cleanup disposes every route and the tap (HMR unmount)', () => {
  const { ctx, routes, taps, cleanups } = makeCtx();
  apply(ctx);
  assert.equal(cleanups.length, 1, 'apply must register exactly one effect');
  assert.equal(typeof cleanups[0], 'function', 'cordis expects the effect to return its disposer');
  assert.equal(routes.size, 16);
  cleanups[0]();
  assert.equal(routes.size, 0, 'all routes must be unregistered');
  assert.equal(taps.length, 0, 'the index tap must be removed');
});

test('the registration script asks a WAITING worker to skip, never an activated one', () => {
  const { ctx, taps } = makeCtx();
  apply(ctx);
  const out = taps[0]('<body></body>');
  // A worker that has reached "activated" is already running, so SKIP_WAITING
  // would be a no-op and the update would wait for every tab to close.
  assert.ok(out.includes("sw.state === 'installed'"), 'must post SKIP_WAITING while the worker is waiting');
  assert.ok(!out.includes("sw.state === 'activated'"), 'testing for "activated" is too late to skip');
  assert.ok(
    out.includes('navigator.serviceWorker.controller'),
    'only replace a worker when one actually controls the page'
  );
});

test('a version bump renames both worker caches', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/sw.js').handler({}, res);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  // The names are composed from VERSION at runtime, so the version assignment is
  // what has to change; sw.test.mjs proves the composition and the eviction.
  assert.ok(
    res.body.includes(`const VERSION = '${pkg.version}'`),
    'the served worker must carry the current package version'
  );
  assert.match(res.body, /const CACHE_NAME = `dsh-pwa-\$\{VERSION\}`/);
  assert.match(res.body, /const STATIC_CACHE = `dsh-static-\$\{VERSION\}`/);
});

test('index tap injects the icon identity into <head>, not just the body', () => {
  const { ctx, taps } = makeCtx();
  apply(ctx);
  const out = taps[0]('<html><head><title>t</title></head><body></body></html>');
  const headAt = out.indexOf('</head>');
  const iconAt = out.indexOf('/icons/icon-32.png');
  assert.ok(iconAt !== -1, 'the PNG favicon link must be injected');
  assert.ok(iconAt < headAt, 'the icon link belongs in the head: Chrome resolves it before the body parses');
  assert.ok(out.includes('rel="apple-touch-icon"'), 'iOS ignores manifest icons when adding to the home screen');
  assert.ok(out.includes('name="theme-color"'), 'dsh ships no theme-color meta, so the status bar colour comes from here');

  // A fragment with no </head> must keep its own prefix rather than being preempted.
  const orphan = '<html><body>partial';
  const appended = taps[0](orphan);
  assert.ok(appended.startsWith(orphan), 'a headless fragment keeps its prefix');
  assert.ok(appended.includes('/icons/icon-32.png'), 'and still receives the icon links');
});

test('the back-gesture guard ships inline with the same constraints', () => {
  const { ctx, taps } = makeCtx();
  apply(ctx);
  const out = taps[0]('<html><head></head><body></body></html>');
  const guard = readFileSync(join(root, 'src', 'pwa-client.js'), 'utf-8');
  assert.ok(out.includes(guard), 'the guard must be inlined verbatim');
  assert.ok(out.indexOf(guard) < out.lastIndexOf('</body>'), 'it must land before </body>');
  assert.ok(
    !/<script[^>]+src=[^>]*pwa-client/.test(out),
    'the guard must be inlined; a <script src> would be served cache-first forever'
  );
});

test('the client fix enrolls a device key once the app is signed in', () => {
  const client = readFileSync(join(root, 'src', 'pwa-client.js'), 'utf-8');
  assert.match(client, /'\/dsh-pwa\/device'/, 'the app must enroll a device key while it holds a session');
  assert.match(client, /indexedDB\.open/, 'the key lives in the app own storage');
  assert.match(client, /put\(granted\.key, 'key'\)/, 'the key must be stored under the name the sign-in page reads');
  assert.match(client, /if \(typeof read\.result === 'string'/, 'an enrolled device must not enroll again on every load');
});

test('auth-state answers 204 to a caller that does not ask for the probe', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  await routes.get('/dsh-pwa/auth-state').handler({ headers: { host: 'vastus.tail4417fc.ts.net:3080' } }, res);
  assert.equal(res.code, 204, 'a plain navigation or <img> probe must learn nothing');
  assert.equal(res.body, undefined);
});

test('auth-state names the cookie of the request authority and never its value', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const host = 'vastus.tail4417fc.ts.net:3080';
  // The name comes from dsh itself (dsh-client-connection lib/index.js:284-286),
  // not from this plugin: 'dsh-auth-' + base64url(sha256(authority)). A probe
  // that computed it differently would report a false absence.
  const expected = 'dsh-auth-' + createHash('sha256').update(host).digest('base64url');

  const absent = makeRes();
  await routes.get('/dsh-pwa/auth-state').handler({ headers: { host, 'x-dsh-pwa-probe': '1' } }, absent);
  assert.equal(absent.code, 200);
  const probe = JSON.parse(absent.body);
  // The stable half of the reply is exact; canMint, cookieValid and deviceCount
  // depend on the real harness home and on the request, so only their types are
  // pinned here.
  assert.deepEqual(
    { ...probe, canMint: undefined, cookieValid: undefined, deviceCount: undefined },
    {
      authority: host,
      cookieName: expected,
      cookiePresent: false,
      cookieLength: 0,
      canMint: undefined,
      cookieValid: undefined,
      deviceCount: undefined,
    }
  );
  assert.equal(typeof probe.canMint, 'boolean', 'the probe must say whether this host can mint a session');
  assert.equal(typeof probe.cookieValid, 'boolean', 'the probe must report the fence own verdict on the cookie');
  assert.equal(typeof probe.deviceCount, 'number', 'the probe must count the enrolled devices');

  const present = makeRes();
  await routes.get('/dsh-pwa/auth-state').handler(
    { headers: { host, 'x-dsh-pwa-probe': '1', cookie: `theme=dark; ${expected}=v1.abc.def; other=1` } },
    present
  );
  const body = JSON.parse(present.body);
  assert.equal(body.cookiePresent, true);
  assert.equal(body.cookieLength, 'v1.abc.def'.length);
  assert.equal(body.cookieValid, false, 'a cookie the fence would reject must not be reported valid');
  assert.ok(!present.body.includes('abc.def'), 'the cookie value must never be echoed back');
});

test('auth-state reports the fence own verdict on the cookie, not just its presence', async () => {
  // The sign-in page decides whether to redirect on this field, and it cannot test
  // the cookie by fetching '/': the app shell is cached, so that answers 200 even
  // for a cookie the fence rejects. A presence check would be just as useless - a
  // cookie the fence refuses is present too - so this pins the verdict itself.
  const home = withTempHome();
  try {
    const secretText = randomBytes(32).toString('base64url');
    writeFileSync(home.credentialsPath, credentialsFile(secretText));
    const { ctx, routes } = makeCtx();
    apply(ctx);
    const now = Date.now();

    const good = makeRes();
    const session = dshCookie(HOST, secretText, now);
    await routes.get('/dsh-pwa/auth-state').handler(
      { headers: { host: HOST, 'x-dsh-pwa-probe': '1', cookie: `${session.name}=${session.value}` } },
      good
    );
    const valid = JSON.parse(good.body);
    assert.equal(valid.cookiePresent, true, 'control: the cookie must be seen at all');
    assert.equal(valid.cookieValid, true, 'a cookie signed by the durable secret is valid');
    assert.equal(valid.canMint, true, 'the same file supplies the minting secret');

    // Same authority, same shape, a secret the fence never signed with.
    const bad = makeRes();
    const forged = dshCookie(HOST, randomBytes(32).toString('base64url'), now);
    await routes.get('/dsh-pwa/auth-state').handler(
      { headers: { host: HOST, 'x-dsh-pwa-probe': '1', cookie: `${forged.name}=${forged.value}` } },
      bad
    );
    const refused = JSON.parse(bad.body);
    assert.equal(refused.cookiePresent, true, 'control: the forged cookie is present too');
    assert.equal(refused.cookieValid, false, 'a cookie signed by another secret must not be valid');
  } finally {
    home.restore();
  }
});

test('auth-state normalises the authority exactly the way dsh does', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = makeRes();
  // dsh builds it with new URL('http://' + host).host, so the host lowercases and
  // a default port disappears. Using the raw Host header here would produce a
  // different cookie name and a false "no cookie" on the phone.
  await routes.get('/dsh-pwa/auth-state').handler(
    { headers: { host: 'VASTUS.Tail4417fc.ts.net:80', 'x-dsh-pwa-probe': '1' } },
    res
  );
  const body = JSON.parse(res.body);
  const authority = 'vastus.tail4417fc.ts.net';
  assert.equal(body.authority, authority);
  assert.equal(body.cookieName, 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url'));
});

// A request shaped the way the route handlers read one: method, headers and an
// async-iterable body.
function makeRequest({ method = 'GET', host = HOST, cookie, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    headers: { host, ...(cookie === undefined ? {} : { cookie }) },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

// The device routes write, so they are driven against a temporary home. The env
// var is read when apply() runs, which is why it is set before apply.
function withTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-home-'));
  const previous = process.env.DSH_PWA_HOME;
  process.env.DSH_PWA_HOME = dir;
  return {
    dir,
    credentialsPath: join(dir, '.credentials.yaml'),
    devicesPath: join(dir, 'dsh-pwa-devices.json'),
    restore() {
      if (previous === undefined) delete process.env.DSH_PWA_HOME;
      else process.env.DSH_PWA_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Built with node:crypto directly rather than through src/device.js, so the
// route tests do not validate the module with itself.
function dshCookie(authority, secretText, now) {
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 86_400_000 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', Buffer.from(secretText, 'base64url')).update(body).digest('base64url');
  return { name: 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url'), value: `v1.${body}.${mac}` };
}

function credentialsFile(secretText) {
  return [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secretText}`,
    '',
  ].join('\n');
}

test('the device routes refuse a caller with no session', async () => {
  const home = withTempHome();
  try {
    const { ctx, routes } = makeCtx();
    apply(ctx);

    const enroll = makeRes();
    await routes.get('/dsh-pwa/device').handler(makeRequest({ method: 'POST', body: { label: 'x' } }), enroll);
    assert.equal(enroll.code, 401, 'a device key is durable, so enrollment must check the caller itself');
    assert.equal(existsSync(home.devicesPath), false, 'a refused enrollment must not write the record');

    const list = makeRes();
    await routes.get('/dsh-pwa/device').handler(makeRequest(), list);
    assert.equal(list.code, 401);

    const forget = makeRes();
    await routes.get('/dsh-pwa/device/forget').handler(makeRequest({ method: 'POST', body: { id: 'x' } }), forget);
    assert.equal(forget.code, 401);
  } finally {
    home.restore();
  }
});

test('an enrolled device claims a minted cookie and can be forgotten', async () => {
  const home = withTempHome();
  try {
    const secretText = randomBytes(32).toString('base64url');
    writeFileSync(home.credentialsPath, credentialsFile(secretText));
    const { ctx, routes } = makeCtx();
    apply(ctx);
    const session = dshCookie(HOST, secretText, Date.now());
    const cookie = `${session.name}=${session.value}`;

    const enroll = makeRes();
    await routes.get('/dsh-pwa/device').handler(
      makeRequest({ method: 'POST', cookie, body: { label: 'Android Chrome' } }),
      enroll
    );
    assert.equal(enroll.code, 200);
    const granted = JSON.parse(enroll.body);
    assert.equal(granted.label, 'Android Chrome');
    assert.ok(granted.key.length >= 32, 'the device key must be long enough to be unguessable');
    const stored = readFileSync(home.devicesPath, 'utf-8');
    assert.ok(!stored.includes(granted.key), 'the record must never hold the key itself');
    assert.ok(
      stored.includes(createHash('sha256').update(granted.key).digest('base64url')),
      'the record must hold the key hash'
    );

    // The claim route is the one that has to answer a locked-out phone.
    const claim = makeRes();
    await routes.get('/dsh-pwa/device/claim').handler(makeRequest({ method: 'POST', body: { key: granted.key } }), claim);
    assert.equal(claim.code, 204);
    const setCookie = claim.headers['Set-Cookie'];
    assert.ok(setCookie.startsWith(`${session.name}=`), 'the minted cookie is named for the request authority');
    const minted = setCookie.slice(session.name.length + 1).split(';')[0];
    const [version, body, mac] = minted.split('.');
    assert.equal(version, 'v1');
    assert.equal(
      createHmac('sha256', Buffer.from(secretText, 'base64url')).update(body).digest('base64url'),
      mac,
      'the minted cookie must be signed by the durable secret the fence uses'
    );
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    assert.equal(payload.authority, HOST);
    assert.ok(payload.expiresAt > Date.now());
    assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict') && setCookie.includes('Path=/'));

    const stranger = makeRes();
    await routes.get('/dsh-pwa/device/claim').handler(
      makeRequest({ method: 'POST', body: { key: randomBytes(32).toString('base64url') } }),
      stranger
    );
    assert.equal(stranger.code, 401, 'an unknown key must not mint a session');

    const list = makeRes();
    await routes.get('/dsh-pwa/device').handler(makeRequest({ cookie }), list);
    assert.equal(list.code, 200);
    const listed = JSON.parse(list.body);
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.canMint, true);
    assert.equal(listed.devices[0].label, 'Android Chrome');
    assert.ok(!list.body.includes('keyHash'), 'the listing must not leak the hash');

    const forget = makeRes();
    await routes.get('/dsh-pwa/device/forget').handler(
      makeRequest({ method: 'POST', cookie, body: { id: granted.id } }),
      forget
    );
    assert.equal(forget.code, 200);
    assert.equal(JSON.parse(forget.body).removed, 1);

    const after = makeRes();
    await routes.get('/dsh-pwa/device/claim').handler(makeRequest({ method: 'POST', body: { key: granted.key } }), after);
    assert.equal(after.code, 401, 'a forgotten device must not mint a session again');
  } finally {
    home.restore();
  }
});
