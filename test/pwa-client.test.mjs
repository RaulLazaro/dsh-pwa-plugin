/**
 * The back-gesture guard, exercised against a fake history stack.
 *
 * The guard is an inline browser script, so it is loaded here through node:vm
 * with a sandbox that models history the way the guard depends on it: a stack of
 * entries, an index, and a back() that fires popstate. The clock is faked too,
 * because the whole behaviour is timing based - a real double swipe is hundreds
 * of milliseconds apart, and a test that ran in microseconds could not tell one
 * gesture from two.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src', 'pwa-client.js'), 'utf-8');

function makeEnv({ standalone = true, navigation = false } = {}) {
  const entries = [{ state: null, url: '/' }];
  const pushed = [];
  const listeners = { popstate: [], navigate: [] };
  const toasts = [];
  let index = 0;
  let intercepts = 0;
  let now = 1_000_000;

  const fire = (type, event) => {
    for (const fn of listeners[type] ?? []) fn(event);
  };

  const history = {
    get state() {
      return entries[index].state;
    },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ state, url });
      index = entries.length - 1;
      pushed.push(url);
    },
    back() {
      if (index === 0) return;
      index -= 1;
      fire('popstate', { state: entries[index].state });
    },
  };

  const document = {
    body: {
      appendChild(el) {
        el.parentNode = this;
        toasts.push(el.textContent);
      },
      removeChild(el) {
        el.parentNode = null;
      },
    },
    createElement() {
      return { style: {}, textContent: '', parentNode: null, setAttribute() {} };
    },
  };

  const win = {
    history,
    document,
    location: { href: 'https://vastus.tail4417fc.ts.net:3080/?dshSession=abc' },
    navigator: { standalone: false },
    matchMedia: (query) => ({ matches: standalone && query.includes('standalone') }),
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    requestAnimationFrame(fn) {
      fn();
    },
    setTimeout() {
      return 0;
    },
  };

  if (navigation) {
    win.navigation = {
      get currentEntry() {
        return { index };
      },
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
    };
  }

  class ClockDate extends Date {
    static now() {
      return now;
    }
  }

  const sandbox = {
    window: win,
    history,
    document,
    navigator: win.navigator,
    location: win.location,
    Date: ClockDate,
    console: { log() {}, warn() {}, error() {} },
  };
  createContext(sandbox);
  runInContext(source, sandbox);

  return {
    win,
    sandbox,
    history,
    toasts,
    pushed,
    fire,
    get depth() {
      return entries.length;
    },
    get index() {
      return index;
    },
    get intercepts() {
      return intercepts;
    },
    advance(ms) {
      now += ms;
    },
    traverseBack({ canIntercept = true } = {}) {
      fire('navigate', {
        navigationType: 'traverse',
        destination: { index: index - 1 },
        canIntercept,
        intercept({ handler }) {
          intercepts += 1;
          handler();
        },
      });
    },
  };
}

test('the installed app is shielded and the URL is left alone', () => {
  const env = makeEnv();
  assert.equal(env.depth, 2, 'install arms one sentinel entry');
  assert.equal(env.history.state.dshBackGuard, true, 'the sentinel is identifiable');
  assert.equal(env.pushed[0], env.win.location.href, 'the sentinel must not change the URL');
});

test('one swipe is absorbed and explained, not obeyed', () => {
  const env = makeEnv();
  env.history.back();
  assert.equal(env.index, 1, 'the user stays in the app');
  assert.equal(env.depth, 2, 'the sentinel is restored rather than consumed');
  assert.deepEqual(env.toasts, ['Swipe back again to leave DSH']);
});

test('a deliberate second swipe inside the window leaves the app', () => {
  const env = makeEnv();
  env.history.back();
  env.advance(600);
  const pushesBefore = env.pushed.length;
  env.history.back();
  assert.equal(env.index, 0, 'the second swipe is allowed through');
  assert.equal(env.history.state, null, 'the exit lands on the app entry, not on a fresh shield');
  assert.equal(env.pushed.length, pushesBefore, 'nothing is armed on the way out');
});

test('a swipe after the window is treated as a fresh gesture', () => {
  const env = makeEnv();
  env.history.back();
  env.advance(2500);
  env.history.back();
  assert.equal(env.index, 1, '2.5s later the guard shields again');
  assert.equal(env.depth, 2);
});

test('a browser tab keeps normal history', () => {
  const env = makeEnv({ standalone: false });
  assert.equal(env.depth, 1, 'no sentinel outside the installed app');
  env.history.back();
  assert.equal(env.index, 0, 'back leaves the page as it always did');
  assert.deepEqual(env.toasts, []);
});

test('one gesture reported by both paths must not count as a double swipe', () => {
  const env = makeEnv({ navigation: true });
  env.history.back(); // the traversal happened, then popstate reported it
  const pushesBefore = env.pushed.length;
  env.traverseBack(); // the same gesture, reported again by the Navigation API
  assert.equal(env.index, 1, 'a single swipe must never be read as the deliberate exit pair');
  assert.equal(env.depth, 2);
  assert.equal(env.pushed.length, pushesBefore, 'the duplicate report arms nothing');
});

test('the Navigation API intercepts the swipe before the browser traverses', () => {
  const env = makeEnv({ navigation: true });
  env.traverseBack();
  assert.equal(env.intercepts, 1, 'the traversal is intercepted, not performed');
  assert.equal(env.index, 1, 'the app stays put');
  assert.equal(env.depth, 2, 'and the shield is restored');
});

test('only backwards traversals are treated as the exit gesture', () => {
  const env = makeEnv({ navigation: true });
  let intercepted = 0;
  const intercept = () => {
    intercepted += 1;
  };
  env.fire('navigate', {
    navigationType: 'traverse',
    destination: { index: env.index + 1 },
    canIntercept: true,
    intercept,
  });
  env.fire('navigate', { navigationType: 'push', destination: { index: env.index + 1 }, canIntercept: true, intercept });
  assert.equal(intercepted, 0, 'forward and in-app navigations are none of the guard\'s business');
  assert.equal(env.depth, 2, 'and nothing was armed for them');
});

test('installing twice does not stack a second sentinel', () => {
  const env = makeEnv();
  const before = env.pushed.length;
  runInContext(source, env.sandbox);
  assert.equal(env.pushed.length, before, 'a second install must be inert');
});

/**
 * The Android polish section: the root overscroll guard, the safe-area insets on
 * the surfaces this plugin owns, and storage persistence.
 *
 * It gets its own small sandbox because it needs things the guard's harness has
 * no reason to model - a head, a body that keeps its children, document-level
 * listeners - and because keeping them apart means a change here can never
 * quietly rewrite the guard's expectations.
 */
function makePolishEnv({ standalone = true, share = null, storage = null } = {}) {
  const head = {
    children: [],
    appendChild(el) {
      el.parentNode = this;
      head.children.push(el);
    },
  };
  const body = [];
  const winEvents = {};
  const docEvents = {};

  const element = (tagName) => {
    const handlers = {};
    return {
      tagName,
      style: {},
      textContent: '',
      innerHTML: '',
      title: '',
      type: '',
      parentNode: null,
      attrs: {},
      handlers,
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      getAttribute(name) {
        return this.attrs[name];
      },
      addEventListener(type, fn) {
        (handlers[type] ??= []).push(fn);
      },
      click() {
        for (const fn of handlers.click ?? []) fn({});
      },
    };
  };

  const document = {
    head,
    activeElement: null,
    body: {
      appendChild(el) {
        el.parentNode = this;
        body.push(el);
      },
      removeChild(el) {
        el.parentNode = null;
      },
    },
    createElement: (tag) => element(String(tag).toUpperCase()),
    querySelector: () => null,
    addEventListener(type, fn) {
      (docEvents[type] ??= []).push(fn);
    },
  };

  const win = {
    document,
    location: { href: 'https://vastus.tail4417fc.ts.net:3080/?dshSession=abc' },
    navigator: { standalone: false },
    innerHeight: 915,
    history: { state: null, pushState() {}, back() {} },
    matchMedia: (query) => ({
      matches: standalone === true && (query.includes('standalone') || query.includes('fullscreen')),
    }),
    addEventListener(type, fn) {
      (winEvents[type] ??= []).push(fn);
    },
    setTimeout() {
      return 0;
    },
    requestAnimationFrame(fn) {
      fn();
    },
  };
  if (share !== null) win.navigator.share = share;
  if (storage !== null) win.navigator.storage = storage;

  const sandbox = {
    window: win,
    document,
    navigator: win.navigator,
    location: win.location,
    console: { log() {}, warn() {} },
  };
  createContext(sandbox);
  runInContext(source, sandbox);

  return {
    win,
    document,
    head,
    body,
    winEvents,
    docEvents,
    fire(type, event) {
      for (const fn of winEvents[type] ?? []) fn(event);
    },
    styles() {
      return head.children.filter((el) => el.tagName === 'STYLE');
    },
  };
}

test('the root scroller gets the overscroll guard the shell never set', () => {
  const env = makePolishEnv();
  const styles = env.styles();
  assert.equal(styles.length, 1, 'exactly one style element is injected');
  assert.equal(styles[0].textContent, 'html,body{overscroll-behavior-y:contain}');
  assert.equal(styles[0].attrs['data-dsh-pwa'], '', 'and it is marked as ours');
});

test('the back-guard toast clears the gesture bar, not just the bottom edge', () => {
  const env = makePolishEnv();
  env.win.history.state = null;
  env.fire('popstate', { state: null });
  const toast = env.body.find((el) => el.textContent === 'Swipe back again to leave DSH');
  assert.ok(toast, 'the absorbed swipe is still explained');
  assert.match(toast.style.cssText, /safe-area-inset-bottom/, `${toast.style.cssText} must clear the bar`);
});

test('the polish appends no floating controls of its own', () => {
  // A share control lived here and was removed: dsh keeps no session id in the
  // URL, so the most it could ever hand over was the bare origin. This asserts
  // the page is left clean even when the browser offers navigator.share, so
  // re-introducing one has to be deliberate.
  const env = makePolishEnv({ share: () => Promise.resolve() });
  assert.equal(env.body.length, 0, 'the client must not append controls to the body');
});

test('persistence is asked for on the first gesture, never at load, and only once', async () => {
  const calls = [];
  const env = makePolishEnv({
    storage: {
      persist() {
        calls.push('persist');
        return Promise.resolve(true);
      },
      estimate() {
        return Promise.resolve({ usage: 11, quota: 99 });
      },
    },
  });
  assert.equal(calls.length, 0, 'loading the page must not ask');
  env.fire('pointerdown', {});
  assert.equal(calls.length, 1, 'the first real gesture asks');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.win.__dshPwaStorage.persisted, true);
  assert.equal(env.win.__dshPwaStorage.quota, 99, 'the estimate comes along for diagnosis');
  env.fire('pointerdown', {});
  env.fire('keydown', {});
  assert.equal(calls.length, 1, 'one ask per page, however many gestures');
});

test('a refused grant is recorded rather than retried', async () => {
  const env = makePolishEnv({ storage: { persist: () => Promise.resolve(false) } });
  env.fire('touchstart', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.win.__dshPwaStorage.persisted, false);
});
