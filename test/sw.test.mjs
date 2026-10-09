import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The service worker is evaluated exactly once, against a fake `self`; every
// test then drives the captured handlers while swapping the `caches`/`fetch`
// globals they close over.
const handlers = {};
let calls = { skipWaiting: 0, claim: 0 };
let m; // per-test mock state

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
      async add(url) {
        m.attempted.push(url);
        if (m.addFail === url) throw new Error('404');
        m.adds.push(url);
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

await import('../src/sw.js');

function reset() {
  calls = { skipWaiting: 0, claim: 0 };
  m = {
    opened: [],
    deleted: [],
    adds: [],
    attempted: [],
    addFail: null,
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

function makeResponse({ status = 200, type = 'basic', cacheControl = null } = {}) {
  return {
    status,
    type,
    headers: new Headers(cacheControl ? { 'cache-control': cacheControl } : {}),
    clone: () => ({ cloned: true }),
    text: async () => '',
  };
}

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

test('install pre-caches the static asset list and calls skipWaiting', async () => {
  let pending;
  handlers.install({ waitUntil(p) { pending = p; } });
  await pending;
  assert.equal(m.opened[0], 'dsh-static-__DSH_PWA_CACHE_VERSION__');
  assert.deepEqual(m.attempted, [
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

test('activate keeps only the current caches and claims clients', async () => {
  m.cacheKeys = ['dsh-pwa-__DSH_PWA_CACHE_VERSION__', 'dsh-static-__DSH_PWA_CACHE_VERSION__', 'dsh-pwa-v0', 'dsh-static-v2'];
  let pending;
  handlers.activate({ waitUntil(p) { pending = p; } });
  await pending;
  assert.deepEqual([...m.deleted].sort(), ['dsh-pwa-v0', 'dsh-static-v2']);
  assert.equal(calls.claim, 1);
});

test('one failing pre-cache URL never aborts the install', async () => {
  m.addFail = '/favicon.svg'; // e.g. DSH core does not serve the favicon
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let pending;
  try {
    handlers.install({ waitUntil(p) { pending = p; } });
    await pending;
  } finally {
    console.warn = realWarn;
  }
  assert.equal(calls.skipWaiting, 1, 'install must complete and activate anyway');
  assert.equal(m.attempted.length, 7, 'every URL must still be attempted');
  assert.equal(m.adds.length, 6, 'the six healthy assets must be pre-cached');
  assert.ok(!m.adds.includes('/favicon.svg'), 'the failed URL must not be stored');
  assert.equal(warnings.length, 1, 'the skipped URL must be logged');
  assert.match(warnings[0], /favicon\.svg/);
});

test('fetch ignores non-GET requests', () => {
  assert.equal(runFetch(makeRequest('https://dsh.local/anything', { method: 'POST' })), null);
});

test('fetch ignores non-HTTP(S) schemes (extensions)', () => {
  assert.equal(runFetch(makeRequest('chrome-extension://abcd/page.html')), null);
  assert.equal(runFetch(makeRequest('moz-extension://abcd/page.html')), null);
});

test('fetch bypasses the API, plugin, websocket and hook paths', () => {
  const dynamic = [
    '/api/session/list',
    '/plugins/x/client.js',
    '/ws',
    '/hooks/build',
    '/auth-api/v0/users/current', // identity JSON (dsh-deepseek-account-platform)
    '/oauth/callback',            // one-time OAuth redirect
    '/open-in-app/apps',          // dynamic application catalog
    '/dsh-pwa/version',           // this plugin's dynamic version JSON
  ];
  for (const path of dynamic) {
    assert.equal(runFetch(makeRequest(`https://dsh.local${path}`)), null, `should bypass ${path}`);
  }
  assert.equal(
    runFetch(makeRequest('https://dsh.local/socket', { headers: { upgrade: 'websocket' } })),
    null,
    'websocket upgrades must bypass'
  );
});

test('HTML navigations are network-first and cached on success', async () => {
  const response = makeResponse();
  m.fetchResponse = response;
  const done = runFetch(makeRequest('https://dsh.local/app', { headers: { accept: 'text/html' } }));
  assert.strictEqual(await done, response, 'network response wins when online');
  await flush();
  assert.ok(m.opened.includes('dsh-pwa-__DSH_PWA_CACHE_VERSION__'), 'successful navigation must be cached');
  assert.equal(m.puts.length, 1);
});

test('a failing cache put never breaks the HTML response', async () => {
  const response = makeResponse();
  m.fetchResponse = response;
  const realCaches = globalThis.caches;
  globalThis.caches = {
    ...realCaches,
    async open() {
      return {
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
  assert.equal(m.opened.at(-1), 'dsh-pwa-__DSH_PWA_CACHE_VERSION__');

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

test('error navigations are not cached for offline use', async () => {
  m.fetchResponse = makeResponse({ status: 500 });
  const result = await runFetch(makeRequest('https://dsh.local/app', { headers: { accept: 'text/html' } }));
  assert.equal(result.status, 500, 'the network response must still be served');
  await flush();
  assert.equal(m.puts.length, 0, 'a 5xx page must never become the offline fallback');
});

test('responses marked Cache-Control: no-store are never cached', async () => {
  // static branch
  m.fetchResponse = makeResponse({ cacheControl: 'no-store' });
  let result = await runFetch(makeRequest('https://dsh.local/assets/app.js'));
  assert.strictEqual(result, m.fetchResponse);
  await flush();
  assert.equal(m.puts.length, 0, 'static: no-store must not be stored');

  // HTML branch
  reset();
  m.fetchResponse = makeResponse({ cacheControl: 'no-store, must-revalidate' });
  result = await runFetch(makeRequest('https://dsh.local/app', { headers: { accept: 'text/html' } }));
  assert.strictEqual(result, m.fetchResponse);
  await flush();
  assert.equal(m.puts.length, 0, 'HTML: no-store must not be stored');
});

test('cross-origin responses are never cached', async () => {
  m.fetchResponse = makeResponse({ type: 'cors' });
  await runFetch(makeRequest('https://api.example.com/models'));
  await flush();
  assert.equal(m.puts.length, 0);
});

test('message: GET_VERSION reports the current cache version', () => {
  let sent;
  handlers.message({ data: { type: 'GET_VERSION' }, ports: [{ postMessage: (m2) => { sent = m2; } }] });
  assert.deepEqual(sent, { version: 'dsh-pwa-__DSH_PWA_CACHE_VERSION__' });
});

test('message: SKIP_WAITING activates a waiting worker', () => {
  handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(calls.skipWaiting, 1);
});
