import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The service worker is evaluated exactly once, against a fake `self`; every
// test then drives the captured handlers while swapping the `caches`/`fetch`
// globals they close over.
const handlers = {};
let calls = { skipWaiting: 0, claim: 0 };
let m; // per-test mock state

// The worker ships as a TEMPLATE: the host route substitutes the version token
// from package.json on every request (src/host/index.js). Substituting here the
// same way means these tests drive the composed cache names the browser really
// gets, rather than the un-substituted template.
const rawSw = readFileSync(join(root, 'src', 'sw.js'), 'utf-8');
const TEST_VERSION = '9.9.9';
const VERSION = TEST_VERSION;
const PWA_CACHE = `dsh-pwa-${TEST_VERSION}`;
const STATIC_CACHE = `dsh-static-${TEST_VERSION}`;

// The worker is a classic script with no imports, so evaluating the served bytes
// mirrors how the browser loads it.
function loadWorker(version) {
  for (const type of Object.keys(handlers)) delete handlers[type];
  new Function(rawSw.replaceAll('__DSH_PWA_VERSION__', version))();
}

globalThis.self = {
  addEventListener(type, fn) {
    handlers[type] = fn;
  },
  skipWaiting() {
    calls.skipWaiting += 1;
    return Promise.resolve();
  },
  clients: {
    claim() {
      calls.claim += 1;
      return Promise.resolve();
    },
  },
};

globalThis.caches = {
  async open(name) {
    m.opened.push(name);
    return {
      async addAll(urls) {
        m.addAll = { name, urls };
      },
      async add(url) {
        m.adds.push(url);
        if (m.addRejects.includes(url)) throw new Error(`pre-cache failed for ${url}`);
      },
      async put(request, response) {
        m.puts.push({ request, response });
      },
    };
  },
  async keys() {
    return m.cacheKeys;
  },
  async delete(name) {
    m.deleted.push(name);
    return true;
  },
  async match(request) {
    m.matchCalls.push(request);
    return m.matchResult;
  },
};

globalThis.fetch = async (request) => {
  m.fetchCalls.push(request);
  if (m.fetchError) throw m.fetchError;
  return m.fetchResponse;
};

loadWorker(TEST_VERSION);

function reset() {
  calls = { skipWaiting: 0, claim: 0 };
  m = {
    opened: [],
    deleted: [],
    addAll: null,
    adds: [],
    addRejects: [],
    puts: [],
    matchCalls: [],
    matchResult: undefined,
    cacheKeys: [],
    fetchCalls: [],
    fetchResponse: null,
    fetchError: null,
  };
}
beforeEach(reset);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeRequest(url, { method = 'GET', headers = {} } = {}) {
  return { url, method, headers: new Headers(headers) };
}

function runFetch(request) {
  let responded = null;
  handlers.fetch({ request, respondWith(p) { responded = Promise.resolve(p); }, waitUntil() {} });
  return responded; // null => the SW declined to handle it (browser default)
}

test('registers install, activate, fetch and message handlers', () => {
  for (const type of ['install', 'activate', 'fetch', 'message']) {
    assert.equal(typeof handlers[type], 'function', `missing ${type} handler`);
  }
});

test('install pre-caches the static list one URL at a time and calls skipWaiting', async () => {
  let pending;
  handlers.install({ waitUntil(p) { pending = p; } });
  await pending;
  assert.equal(m.opened[0], STATIC_CACHE);
  assert.deepEqual(m.adds, [
    '/',
    '/manifest.webmanifest',
    '/favicon.svg',
    '/icons/icon-192.png',
    '/icons/icon-192-maskable.png',
    '/icons/icon-512.png',
    '/icons/icon-512-maskable.png',
  ]);
  assert.equal(calls.skipWaiting, 1, 'install must activate immediately (skipWaiting)');
});

test('a pre-cache URL that fails does not stop the worker installing', async () => {
  // The fence refuses '/' with a 401 while a client is signed out, and that is
  // exactly when a fixed worker is needed. addAll() would reject as a whole and
  // leave this update permanently redundant.
  m.addRejects = ['/'];
  let pending;
  handlers.install({ waitUntil(p) { pending = p; } });
  await pending;
  assert.equal(m.adds.length, 7, 'every URL is still attempted');
  assert.equal(calls.skipWaiting, 1, 'the worker must still take over');
});

test('activate keeps only the current caches and claims clients', async () => {
  m.cacheKeys = [PWA_CACHE, STATIC_CACHE, 'dsh-pwa-v0', 'dsh-static-v2'];
  let pending;
  handlers.activate({ waitUntil(p) { pending = p; } });
  await pending;
  assert.deepEqual([...m.deleted].sort(), ['dsh-pwa-v0', 'dsh-static-v2']);
  assert.equal(calls.claim, 1);
});

test('the version token is what composes both cache names, and a bump evicts the old ones', async () => {
  try {
    loadWorker('4.2.0');
    let pending;
    handlers.install({ waitUntil(p) { pending = p; } });
    await pending;
    assert.equal(m.opened[0], 'dsh-static-4.2.0', 'a different version must produce a different cache name');

    m.cacheKeys = ['dsh-static-4.2.0', STATIC_CACHE];
    pending = undefined;
    handlers.activate({ waitUntil(p) { pending = p; } });
    await pending;
    assert.deepEqual(m.deleted, [STATIC_CACHE], 'the superseded version must be evicted on activate');
  } finally {
    loadWorker(TEST_VERSION);
  }
});

test('fetch ignores non-GET requests', () => {
  assert.equal(runFetch(makeRequest('https://dsh.local/anything', { method: 'POST' })), null);
});

test('fetch ignores non-HTTP(S) schemes (extensions)', () => {
  assert.equal(runFetch(makeRequest('chrome-extension://abcd/page.html')), null);
  assert.equal(runFetch(makeRequest('moz-extension://abcd/page.html')), null);
});

test('fetch bypasses the API, plugin, websocket and hook paths', () => {
  for (const path of ['/api/session/list', '/plugins/x/client.js', '/ws', '/hooks/build']) {
    assert.equal(runFetch(makeRequest(`https://dsh.local${path}`)), null, `should bypass ${path}`);
  }
  assert.equal(
    runFetch(makeRequest('https://dsh.local/socket', { headers: { upgrade: 'websocket' } })),
    null,
    'websocket upgrades must bypass'
  );
});

test('HTML navigations are network-first and cached on success', async () => {
  const response = { clone: () => ({ cloned: true }) };
  m.fetchResponse = response;
  const done = runFetch(makeRequest('https://dsh.local/app', { headers: { accept: 'text/html' } }));
  assert.strictEqual(await done, response, 'network response wins when online');
  await flush();
  assert.ok(m.opened.includes(PWA_CACHE), 'successful navigation must be cached');
  assert.equal(m.puts.length, 1);
});

test("a locked-out navigation gets the sign-in page, not the fence's plain-text 401", async () => {
  m.fetchResponse = { status: 401 };
  const result = await runFetch(makeRequest('https://dsh.local/', { headers: { accept: 'text/html' } }));
  assert.equal(result.status, 200, 'the replacement is a working page, not an error');
  assert.equal(result.headers.get('x-dsh-pwa-signin'), '1');
  assert.match(result.headers.get('content-type'), /text\/html/);
  const body = await result.text();
  assert.match(body, /Sign in to DSH/);
  assert.match(body, /\/\?token=/, 'the form must perform the same token exchange the printed URL does');
  await flush();
  assert.equal(m.puts.length, 0, 'a sign-in page must never enter the cache');
});

test('a navigation that carried a rejected code says so', async () => {
  m.fetchResponse = { status: 401 };
  const result = await runFetch(makeRequest(
    'https://dsh.local/?token=AAAAAAAAAAAAAAAAAAAAAAAA',
    { headers: { accept: 'text/html' } }
  ));
  const body = await result.text();
  assert.match(body, /not accepted/, 'a rejected code must not look like nothing happened');
});

test('the sign-in page names where the code comes from and accepts a pasted URL', async () => {
  const source = readFileSync(join(root, 'src', 'sw.js'), 'utf-8');
  assert.match(source, /dshw-token\.ps1/, 'the page must name the command that prints the code');
  assert.match(source, /\[\?&\]token=\(\[A-Za-z0-9_-\]\{20,\}\)/, 'a pasted URL must be accepted, not only a bare code');
  assert.match(source, /__NOTE__/, 'the page carries a note slot for the rejected-code message');
});

test('a failing cache put never breaks the HTML response', async () => {
  const response = { clone: () => ({ cloned: true }) };
  m.fetchResponse = response;
  const realCaches = globalThis.caches;
  globalThis.caches = {
    ...realCaches,
    async open() {
      return {
        async addAll() {},
        async add() {},
        async put() { throw new Error('unsupported scheme'); },
        async match() { return undefined; },
      };
    },
  };
  try {
    const done = runFetch(makeRequest('https://dsh.local/app', { headers: { accept: 'text/html' } }));
    assert.strictEqual(await done, response);
    await flush();
  } finally {
    globalThis.caches = realCaches;
  }
});

test('offline HTML falls back to cache, then to the offline page', async () => {
  m.fetchError = new Error('network down');

  // 1. no cache -> embedded offline page
  let result = await runFetch(makeRequest('https://dsh.local/app', { headers: { accept: 'text/html' } }));
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type'), /text\/html/);
  assert.match(await result.text(), /You're offline/);

  // 2. cache hit -> cached copy
  const cached = { from: 'cache' };
  m.matchResult = cached;
  result = await runFetch(makeRequest('https://dsh.local/app', { headers: { accept: 'text/html' } }));
  assert.strictEqual(result, cached);
});

test('static assets are served cache-first without hitting the network', async () => {
  const cached = { from: 'static-cache' };
  m.matchResult = cached;
  const result = await runFetch(makeRequest('https://dsh.local/assets/app.js'));
  assert.strictEqual(result, cached);
  assert.equal(m.fetchCalls.length, 0, 'cache hit must not go to the network');
});

test('static misses go to the network and only 200/basic responses get cached', async () => {
  const fresh = { status: 200, type: 'basic', clone: () => ({ cloned: true }) };
  m.fetchResponse = fresh;
  const result = await runFetch(makeRequest('https://dsh.local/assets/app.js'));
  assert.strictEqual(result, fresh);
  await flush();
  assert.equal(m.puts.length, 1, 'same-origin 200 must be cached');
  assert.equal(m.opened.at(-1), PWA_CACHE);

  // cross-origin opaque responses are not cacheable
  reset();
  m.fetchResponse = { status: 200, type: 'opaque', clone: () => ({ cloned: true }) };
  await runFetch(makeRequest('https://dsh.local/assets/cross.js'));
  await flush();
  assert.equal(m.puts.length, 0, 'opaque responses must not be cached');

  // non-200 responses are not cacheable
  reset();
  m.fetchResponse = { status: 500, type: 'basic', clone: () => ({ cloned: true }) };
  await runFetch(makeRequest('https://dsh.local/assets/broken.js'));
  await flush();
  assert.equal(m.puts.length, 0, 'error responses must not be cached');
});

test('offline static assets answer 503', async () => {
  m.fetchError = new Error('network down');
  const result = await runFetch(makeRequest('https://dsh.local/assets/app.js'));
  assert.equal(result.status, 503);
});

test('message: GET_VERSION reports the current cache version', () => {
  let sent;
  handlers.message({ data: { type: 'GET_VERSION' }, ports: [{ postMessage: (m2) => { sent = m2; } }] });
  assert.deepEqual(sent, { version: VERSION });
});

test('neither cache name is a literal in the worker source', () => {
  const raw = readFileSync(join(root, 'src', 'sw.js'), 'utf-8');
  // A frozen name pins every installed client to an old pre-cache set: the
  // version token is what makes a package bump the whole invalidation procedure.
  assert.ok(!/'dsh-pwa-[^']*'/.test(raw), 'the page cache name must not be a literal');
  assert.ok(!/'dsh-static-[^']*'/.test(raw), 'the static cache name must not be a literal');
  assert.match(raw, /const VERSION = '__DSH_PWA_VERSION__'/);
  assert.match(raw, /const CACHE_NAME = `dsh-pwa-\$\{VERSION\}`/);
  assert.match(raw, /const STATIC_CACHE = `dsh-static-\$\{VERSION\}`/);
});

test('message: SKIP_WAITING activates a waiting worker', () => {
  handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(calls.skipWaiting, 1);
});
