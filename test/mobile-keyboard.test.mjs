/**
 * The keyboard inset, exercised against a fake visual viewport.
 *
 * The script is an inline browser patch, so it runs here in node:vm with a
 * sandbox that models the one geometry it reads: a layout viewport as tall as
 * `innerHeight`, and a visual viewport that the keyboard shrinks and pans. The
 * numbers are the shapes a phone actually reports - a full-height window with no
 * keyboard, a keyboard covering the bottom third with the page still at the top,
 * and iOS panning the visible area up instead of resizing the document - because
 * the off-by-one-unit mistake this file exists to catch (subtracting offsetTop
 * and then also subtracting it from the box's top) produces a composer that is
 * correct on Android and wrong by the pan on an iPhone.
 *
 * What is asserted is what the app can be observed by: the variables the rule
 * reads, and the attribute that turns the rule on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src', 'mobile-keyboard.js'), 'utf-8');

const ATTRIBUTE = 'data-dsh-pwa-keyboard';
const HEIGHT_VAR = '--dsh-pwa-viewport-height';
const TOP_VAR = '--dsh-pwa-viewport-top';

function makeStyle() {
  const values = new Map();
  return {
    values,
    setProperty(name, value) {
      values.set(name, String(value));
    },
    removeProperty(name) {
      values.delete(name);
    },
  };
}

function makeEnv({ coarse = true, forced = false, innerHeight = 800, vv = null, noViewport = false } = {}) {
  const htmlAttributes = new Map();
  const attributeWrites = [];
  const html = {
    style: makeStyle(),
    setAttribute(name, value) {
      attributeWrites.push(['set', name, String(value)]);
      htmlAttributes.set(name, String(value));
    },
    getAttribute(name) {
      return htmlAttributes.has(name) ? htmlAttributes.get(name) : null;
    },
    removeAttribute(name) {
      attributeWrites.push(['remove', name]);
      htmlAttributes.delete(name);
    },
  };
  const styles = [];
  const docListeners = { visibilitychange: [] };
  const document = {
    documentElement: html,
    head: {
      appendChild(el) {
        el.parentNode = this;
        styles.push(el);
      },
    },
    createElement() {
      return {
        attributes: new Map(),
        textContent: '',
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
        getAttribute(name) {
          return this.attributes.has(name) ? this.attributes.get(name) : null;
        },
      };
    },
    querySelector(selector) {
      if (selector !== 'style[data-dsh-pwa-keyboard]') return null;
      return styles.length === 0 ? null : styles[0];
    },
    addEventListener(type, fn) {
      (docListeners[type] ??= []).push(fn);
    },
  };
  const listeners = { resize: [], scroll: [] };
  const scheduled = [];
  const scrolls = [];
  const viewport =
    vv === null
      ? {
          height: innerHeight,
          offsetTop: 0,
          scale: 1,
        }
      : vv;
  // One registry, installed exactly once. A supplied `vv` keeps its own geometry
  // but not its own listener table: wrapping an addEventListener that already
  // records listeners would register every handler twice, and the burst test
  // would pass on the rAF guard while the harness lied about the event count.
  if (viewport !== null) {
    viewport.addEventListener = (type, fn) => {
      (listeners[type] ??= []).push(fn);
    };
  }
  const win = {
    document,
    innerHeight,
    matchMedia: (query) => ({ matches: query.includes('coarse') ? coarse : false }),
    __DSH_FORCE_MOBILE_KEYBOARD__: forced,
    requestAnimationFrame(fn) {
      scheduled.push(fn);
      return scheduled.length;
    },
    setTimeout(fn) {
      scheduled.push(fn);
      return 1000 + scheduled.length;
    },
    scrollTo(x, y) {
      scrolls.push([x, y]);
    },
  };
  if (!noViewport) win.visualViewport = viewport;
  const context = createContext({ window: win });
  return {
    context,
    win,
    viewport,
    html,
    styles,
    listeners,
    docListeners,
    scrolls,
    attributeWrites,
    /** The variable a rule would read, as the style attribute would report it. */
    var: (name) => html.style.values.get(name),
    isOpen: () => htmlAttributes.has(ATTRIBUTE),
    /** Fire one engine event the way a browser would, then drain the frame it queued. */
    fire(type, target = 'viewport') {
      const list = target === 'document' ? (docListeners[type] ?? []) : (listeners[type] ?? []);
      for (const fn of list) fn({ type });
    },
    flush(max = 8) {
      let ran = 0;
      while (scheduled.length > 0 && ran < max) {
        const fn = scheduled.shift();
        ran += 1;
        fn();
      }
      return ran;
    },
    /** Move the viewport as a keyboard would and let the script settle. */
    resize(height, offsetTop = 0, scale = 1) {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.scale = scale;
      this.fire('resize');
      this.flush();
    },
    load() {
      runInContext(source, context);
      return this;
    },
  };
}

test('a desktop pointer never installs the patch', () => {
  const env = makeEnv({ coarse: false }).load();
  assert.equal(env.listeners.resize.length, 0, 'no resize listener may be added');
  assert.equal(env.listeners.scroll.length, 0, 'no scroll listener may be added');
  assert.equal(env.styles.length, 0, 'no stylesheet may be added');
  assert.equal(env.isOpen(), false);
});

test('a coarse pointer installs the rule and leaves a closed keyboard alone', () => {
  const env = makeEnv({ coarse: true }).load();
  assert.equal(env.styles.length, 1, 'exactly one stylesheet');
  const css = env.styles[0].textContent;
  assert.match(css, new RegExp(`html\\[${ATTRIBUTE}\\] #root\\{`), 'the rule must be gated on the attribute');
  assert.match(css, /height:var\(--dsh-pwa-viewport-height,100%\)/, 'the box height must be a variable with a 100% fallback');
  assert.match(css, /top:var\(--dsh-pwa-viewport-top,0px\)/, 'the box top must be a variable with a 0 fallback');
  assert.match(css, /overflow:hidden/, 'the document must not scroll while the box is in place');
  assert.equal(env.listeners.resize.length, 1, 'exactly one resize listener');
  assert.equal(env.listeners.scroll.length, 1, 'exactly one scroll listener');
  assert.equal(env.isOpen(), false, 'a full-height viewport is not a keyboard');
  assert.equal(env.var(HEIGHT_VAR), undefined);
});

test('an open keyboard boxes the app to the visible area', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(500);
  assert.equal(env.isOpen(), true, 'the attribute turns the rule on');
  assert.equal(env.var(HEIGHT_VAR), '500px', 'the box is exactly the visible height');
  assert.equal(env.var(TOP_VAR), '0px');
  // 800 - 500 - 0 = 300 covered, which is the gap that used to hide the composer.
  assert.equal(env.scrolls.length, 0, 'opening the keyboard must not move the document');
});

test('a panned visual viewport moves the box instead of stretching it', () => {
  const env = makeEnv({ coarse: true }).load();
  // iOS reveals a focused field by panning: the visible area is 380 tall and
  // starts 120 below the layout viewport's top, so the keyboard still covers 300.
  env.resize(380, 120);
  assert.equal(env.isOpen(), true);
  assert.equal(env.var(HEIGHT_VAR), '380px');
  assert.equal(env.var(TOP_VAR), '120px', 'the box must sit where the visible area starts');
});

test('a scroll event alone is enough to follow the pan', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(500);
  // Height unchanged, position moved: the one case resize never reports.
  env.viewport.offsetTop = 60;
  env.fire('scroll');
  env.flush();
  assert.equal(env.var(TOP_VAR), '60px');
});

test('a pinch zoom is not a keyboard', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(400, 0, 2.4);
  assert.equal(env.isOpen(), false, 'a zoomed page must keep the framework layout');
  assert.equal(env.var(HEIGHT_VAR), undefined);
});

test('a pinch zoom with the keyboard open leaves the box in place', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(500);
  assert.equal(env.isOpen(), true);
  env.resize(400, 0, 2.4);
  assert.equal(env.isOpen(), true, 'a zoom must not drop the box the keyboard put there');
  assert.equal(env.var(HEIGHT_VAR), '500px', 'the last keyboard measurement survives the zoom');
});

test('rubber-band growth above the layout viewport is ignored', () => {
  const env = makeEnv({ coarse: true }).load();
  // WebKit reports a visual viewport taller than the window while the page
  // rubber-bands. There is no keyboard, and the box must not stretch the app.
  env.resize(900);
  assert.equal(env.isOpen(), false);
});

test('a gap too small to be a keyboard is ignored', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(600);
  assert.equal(env.isOpen(), true, '600 vs 800 is a keyboard');
  env.resize(760);
  assert.equal(env.isOpen(), false, '40px is browser chrome, not a keyboard');
});

test('closing the keyboard restores the framework layout and the document scroll once', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(500);
  assert.equal(env.isOpen(), true);
  env.resize(800);
  assert.equal(env.isOpen(), false, 'the attribute must come off');
  assert.equal(env.var(HEIGHT_VAR), undefined, 'the height override must be removed, not set to 100%');
  assert.equal(env.var(TOP_VAR), undefined);
  assert.deepEqual(env.scrolls, [[0, 0]], 'iOS leaves the page scrolled; one restore is expected');
  // A second close must not scroll again: nothing was opened since.
  env.resize(800);
  assert.equal(env.scrolls.length, 1);
});

test('a keyboard that never opened never touches the document scroll', () => {
  const env = makeEnv({ coarse: true }).load();
  env.fire('resize');
  env.flush();
  assert.deepEqual(env.scrolls, []);
});

test('a burst of resize events is measured once per frame', () => {
  const env = makeEnv({ coarse: true }).load();
  env.viewport.height = 500;
  env.fire('resize');
  env.fire('resize');
  env.fire('scroll');
  env.fire('resize');
  const ran = env.flush();
  assert.equal(ran, 1, 'one animation frame, not one per event');
  assert.equal(env.var(HEIGHT_VAR), '500px');
});

test('the attribute is written once while the keyboard stays open', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(500);
  env.resize(480);
  env.resize(460);
  const sets = env.attributeWrites.filter((entry) => entry[0] === 'set' && entry[1] === ATTRIBUTE);
  assert.deepEqual(sets, [['set', ATTRIBUTE, '']], 'the attribute is a toggle, not a per-frame write');
  assert.equal(env.var(HEIGHT_VAR), '460px', 'the box still follows every measurement');
});

test('a document that loads with the keyboard already open is measured at load', () => {
  const env = makeEnv({ coarse: true, innerHeight: 800 });
  env.viewport.height = 450;
  env.load();
  assert.equal(env.isOpen(), true, 'the initial measurement must not wait for an event');
  assert.equal(env.var(HEIGHT_VAR), '450px');
});

test('the forcing seam runs the patch on a fine pointer', () => {
  const env = makeEnv({ coarse: false, forced: true }).load();
  env.resize(500);
  assert.equal(env.isOpen(), true);
});

test('a browser without visualViewport is left untouched', () => {
  const env = makeEnv({ coarse: true, noViewport: true }).load();
  assert.equal(env.styles.length, 0);
  assert.equal(env.isOpen(), false);
});

test('returning to the foreground re-measures', () => {
  const env = makeEnv({ coarse: true }).load();
  env.resize(500);
  // The keyboard went away while the page was not running.
  env.viewport.height = 800;
  env.fire('visibilitychange', 'document');
  env.flush();
  assert.equal(env.isOpen(), false);
});

test('the patch is idempotent: a second copy adds no second stylesheet', () => {
  const env = makeEnv({ coarse: true }).load();
  const listeners = env.listeners.resize.length;
  runInContext(source, env.context);
  assert.equal(env.styles.length, 1, 'the existing stylesheet must be reused');
  assert.ok(env.listeners.resize.length >= listeners, 'a second copy may only add its own listeners');
});
