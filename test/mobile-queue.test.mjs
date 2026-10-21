import { test } from 'node:test';
import assert from 'node:assert/strict';

// The hold-to-queue gesture is browser code, but every decision it makes is
// plain DOM event handling, so it is pinned down here with a stub instead of on
// a phone. The three rules these tests exist for are the ones a device would
// punish: the press must produce the composer's Cmd/Ctrl+Enter and nothing else
// (a click cannot change the mode), an empty draft must never arm it (that is
// simultaneously the Stop button and the branch that drains the whole queue),
// and the click the same press produces afterwards must be taken exactly once,
// or every hold sends twice.

const CARD_SELECTOR = '[data-composer-card]';
const EDITOR_SELECTOR = '[data-lexical-editor="true"]';

// node:test's MockTimers replaces globalThis.setTimeout for the length of one
// test, so the drain keeps a reference to the real one.
const realSetTimeout = globalThis.setTimeout;
const drainRealTimers = () => new Promise((resolve) => realSetTimeout(resolve, 0));

class StubEvent {
  constructor(type, init = {}) {
    Object.assign(
      this,
      {
        type,
        key: '',
        code: '',
        keyCode: 0,
        which: 0,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        composed: false,
        bubbles: false,
        cancelable: false,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 0,
        clientY: 0,
        target: null,
      },
      init,
      { defaultPrevented: false, propagationStopped: false, immediateStopped: false }
    );
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  stopImmediatePropagation() {
    this.propagationStopped = true;
    this.immediateStopped = true;
  }
}

class StubKeyboardEvent extends StubEvent {}

function matches(el, selector) {
  if (selector === CARD_SELECTOR) return el.hasAttribute('data-composer-card');
  if (selector === 'button[type="button"]') {
    return el.tagName === 'BUTTON' && el.getAttribute('type') === 'button';
  }
  return false;
}

/** Enough of a node for the gesture: attributes, a class, a parent, children. */
function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    attributes: Object.create(null),
    children: [],
    parentNode: null,
    textContent: '',
    className: '',
    disabled: false,
    style: {},
    offsetWidth: 0,
    dispatched: [],
    setAttribute: (name, value) => {
      el.attributes[name] = String(value);
    },
    getAttribute: (name) =>
      Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null,
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(el.attributes, name),
    removeAttribute: (name) => {
      delete el.attributes[name];
    },
    appendChild: (child) => {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild: (child) => {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove: () => {
      if (el.parentNode !== null) el.parentNode.removeChild(el);
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent: (event) => {
      el.dispatched.push(event);
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      // The app's Enter command cancels what it handles (client.js:18243), and
      // the gesture reads that cancellation as "the composer took it". A test
      // that needs an editor which never saw the chord sets handlesChord=false.
      if (event.type === 'keydown' && el.handlesChord !== false) event.preventDefault();
      return true;
    },
    closest: (selector) => {
      let node = el;
      while (node !== null && node !== undefined) {
        if (typeof node.hasAttribute === 'function' && matches(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
  };
  return el;
}

function makeDocument({ pillWidth = 0 } = {}) {
  const handlers = new Map();
  return {
    handlers,
    body: makeElement('body'),
    head: makeElement('head'),
    createElement: (tag) => {
      const el = makeElement(tag);
      if (tag === 'div') el.offsetWidth = pillWidth;
      return el;
    },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = handlers.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
      // A type with no listeners left is a type nobody is listening to; the
      // tests read handlers.has(type) as exactly that.
      if (list.length === 0) handlers.delete(type);
    },
    // A real capture-phase dispatch: stopImmediatePropagation silences every
    // later listener on the same node.
    fire(type, event) {
      for (const fn of handlers.get(type) ?? []) {
        if (event.immediateStopped) break;
        fn(event);
      }
      return event;
    },
  };
}

/** The composer card as the app renders it: an editor and one primary button. */
function makeComposer(document, { label = 'Send message', text = 'hello', disabled = false, menu = null, rect = null } = {}) {
  const card = makeElement('div');
  card.setAttribute('data-composer-card', '');
  const editor = makeElement('div');
  editor.setAttribute('data-lexical-editor', 'true');
  editor.textContent = text;
  if (menu !== null) editor.setAttribute('aria-haspopup', menu);
  const button = makeElement('button');
  button.setAttribute('type', 'button');
  button.className = 'uV2eYG_primary';
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.getBoundingClientRect = () => rect ?? { top: 700, left: 300, width: 44, height: 44 };
  card.appendChild(editor);
  card.appendChild(button);
  card.querySelector = (selector) => (selector === EDITOR_SELECTOR ? editor : null);
  document.body.appendChild(card);
  return { card, editor, button };
}

let loadCount = 0;

async function load({
  coarse = true,
  forced = false,
  label = 'Send message',
  text = 'hello',
  disabled = false,
  menu = null,
  rect = null,
  pillWidth = 0,
  vibrate = null,
} = {}) {
  // A timer from the previous module instance fires with the globals of THIS
  // load installed; let it drain while the old ones are still in place.
  await drainRealTimers();
  const document = makeDocument({ pillWidth });
  const { card, editor, button } = makeComposer(document, { label, text, disabled, menu, rect });
  const winHandlers = new Map();
  const window = {
    keepCalls: 0,
    __dshPwaKeepDraftFocus: () => {
      window.keepCalls += 1;
      return true;
    },
    matchMedia: () => ({ matches: coarse }),
    __DSH_FORCE_MOBILE_QUEUE__: forced,
    innerWidth: 390,
    innerHeight: 844,
    addEventListener(type, fn) {
      if (!winHandlers.has(type)) winHandlers.set(type, []);
      winHandlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winHandlers.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    fire(type, event) {
      for (const fn of winHandlers.get(type) ?? []) fn(event);
      return event;
    },
  };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    KeyboardEvent: globalThis.KeyboardEvent,
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.KeyboardEvent = StubKeyboardEvent;
  Object.defineProperty(globalThis, 'navigator', {
    value: vibrate === null ? {} : { vibrate },
    configurable: true,
    writable: true,
  });
  // A unique query string defeats the ESM module cache, so each test gets a
  // freshly executed copy of the gesture.
  await import(`../src/mobile-queue.js?stub=${++loadCount}`);
  return {
    document,
    window,
    card,
    editor,
    button,
    pill: () => document.body.children.find((el) => el.className === 'dsh-pwa-hold-hint') ?? null,
    windowListenerCount: () => [...winHandlers.values()].reduce((total, list) => total + list.length, 0),
    restore: () => Object.assign(globalThis, previous),
  };
}

function pointer(type, overrides = {}) {
  return new StubEvent(type, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 120,
    clientY: 780,
    ...overrides,
  });
}

function press(env, overrides = {}) {
  const event = pointer('pointerdown', { target: env.button, ...overrides });
  env.document.fire('pointerdown', event);
  return event;
}

function move(env, x, y) {
  return env.document.fire('pointermove', pointer('pointermove', { clientX: x, clientY: y, target: env.button }));
}

function release(env, overrides = {}) {
  return env.document.fire('pointerup', pointer('pointerup', { target: env.button, ...overrides }));
}

function click(env, target = env.button) {
  return env.document.fire('click', new StubEvent('click', { target, bubbles: true, cancelable: true }));
}

function chordFields(event) {
  return {
    type: event.type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    which: event.which,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
  };
}

test('a fine pointer installs nothing at all', async () => {
  const env = await load({ coarse: false, forced: false });
  assert.equal(env.document.handlers.size, 0, 'desktop must be byte-for-byte untouched');
  assert.equal(env.windowListenerCount(), 0, 'and no window listener either');
});

test('the force flag arms the gesture on a fine pointer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: false, forced: true });
  assert.ok(env.document.handlers.has('pointerdown'));
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 1);
});

test('a hold sends the composer Cmd/Ctrl+Enter exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  assert.equal(env.editor.dispatched.length, 0, 'nothing may be sent before the hold is complete');
  t.mock.timers.tick(299);
  assert.equal(env.editor.dispatched.length, 0, '299ms is still a tap');
  t.mock.timers.tick(1);
  assert.equal(env.editor.dispatched.length, 1, 'exactly one chord');
  assert.deepEqual(
    chordFields(env.editor.dispatched[0]),
    {
      type: 'keydown',
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      bubbles: true,
      cancelable: true,
      composed: true,
    },
    'the chord has to be the shape the composer keymap reads: ctrlKey makes it the accelerated gesture'
  );
});

test('the chord goes to the editor, not the button', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 1, 'Lexical listens on the editor root');
  assert.equal(env.button.dispatched.length, 0);
});

test('the chord goes to the editor the card holds when the hold completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  // A re-render replaces the editor node while the finger is still down.
  const replacement = makeElement('div');
  replacement.setAttribute('data-lexical-editor', 'true');
  replacement.textContent = 'hello';
  env.card.removeChild(env.editor);
  env.card.appendChild(replacement);
  env.card.querySelector = (selector) => (selector === EDITOR_SELECTOR ? replacement : null);
  t.mock.timers.tick(400);
  assert.equal(replacement.dispatched.length, 1, 'the live editor is the one that hears the chord');
  assert.equal(env.editor.dispatched.length, 0, 'the detached one would swallow it');
});

test('a chord the composer never saw is tried again until it lands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  // An uncancelled chord is what the gesture reads as "the composer never ran
  // its Enter command": a draft it still reads as composing does exactly this
  // (client.js:18241), and just-typed text is the normal way to reach a hold.
  env.editor.handlesChord = false;
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 1);
  assert.equal(env.editor.dispatched[0].defaultPrevented, false);
  t.mock.timers.tick(30);
  assert.equal(env.editor.dispatched.length, 2, 'the first step, on the same draft');
  t.mock.timers.tick(150);
  assert.equal(env.editor.dispatched.length, 3, 'the second step outlives the composing window');
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 4, 'the last step');
  t.mock.timers.tick(5000);
  assert.equal(env.editor.dispatched.length, 4, 'and the ladder ends there');
});

test('the ladder stops at the step the composer takes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  env.editor.handlesChord = false;
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.pill().textContent, 'Sending…', 'the pill says it is still working on it');

  env.editor.handlesChord = true;
  t.mock.timers.tick(30);
  assert.equal(env.editor.dispatched.length, 2);
  const settled = env.pill().textContent;
  assert.notEqual(settled, 'Sending…', 'the pill moves on from the pending text');
  assert.notEqual(settled, 'Not sent — hold again', 'and does not report a failure');

  t.mock.timers.tick(5000);
  assert.equal(env.editor.dispatched.length, 2, 'an acknowledged chord ends the ladder');
  assert.equal(env.pill(), null, 'and the confirmation expires on its own');
});

test('the ladder stops when the draft changed under it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  env.editor.handlesChord = false;
  press(env);
  // Just past the fire: one chord is out and unanswered, and the user now retypes
  // the draft. Every remaining step must see the changed text and stand down,
  // rather than resend over what the user means now.
  t.mock.timers.tick(301);
  assert.equal(env.editor.dispatched.length, 1);
  env.editor.textContent = 'something else';
  t.mock.timers.tick(1000);
  assert.equal(env.editor.dispatched.length, 1, 'the user has moved on, so nothing more is sent');
});

test('a cancelled pointer after the chord still swallows the release click', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  // The browser's own long-press gesture cancels the pointer under a finger
  // that is still down; the commit stands and its click must not double it.
  env.document.fire('pointercancel', pointer('pointercancel', { target: env.button }));
  assert.equal(env.document.handlers.has('click'), true, 'the suppressor outlives the cancel');
  const clickEvent = click(env);
  assert.equal(clickEvent.defaultPrevented, true, 'the release click must not submit again');
});

test('a page that goes away once the press is old fires instead of dropping it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(200);
  // The engine's long press hands the page's focus to its own menu about 400 ms
  // into a press on a button. The finger is still down and has been long enough
  // to mean it, so the chord goes out rather than the gesture dying silently.
  env.window.fire('blur', new StubEvent('blur'));
  assert.equal(env.editor.dispatched.length, 1, 'the hold the user meant still sends');
  assert.ok(env.pill() !== null, 'and the confirmation is on screen');
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 1, 'the expired timer must not send it again');
});

test('the engine long press menu is kept off a hold that has fired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  release(env);

  const menu = new StubEvent('contextmenu', { target: env.button, cancelable: true });
  env.document.fire('contextmenu', menu);
  assert.equal(menu.defaultPrevented, true, 'the menu would land on the confirmation');

  t.mock.timers.tick(1500);
  const later = new StubEvent('contextmenu', { target: env.button, cancelable: true });
  env.document.fire('contextmenu', later);
  assert.equal(later.defaultPrevented, false, 'a press well after the gesture keeps its own menu');
});

test('an unanswered chord says so instead of naming a mode it did not use', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  env.editor.handlesChord = false;
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.pill().textContent, 'Sending…', 'the first attempt went unanswered');
  t.mock.timers.tick(30);
  assert.equal(env.pill().textContent, 'Sending…', 'and so did the retry');
  t.mock.timers.tick(150);
  assert.equal(env.pill().textContent, 'Sending…', 'the ladder is still going');
  t.mock.timers.tick(400);
  assert.equal(env.pill().textContent, 'Not sent — hold again', 'not until the last step fails');
});

test('a control that takes the focus after a hold gives the caret back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  const before = env.window.keepCalls;

  // Chrome's long press focuses the control under the finger a few tens of
  // milliseconds after the chord has gone out, and on Android a focused button
  // closes the keyboard the draft was holding open.
  env.document.activeElement = env.button;
  env.document.fire('focusin', new StubEvent('focusin', { target: env.button, bubbles: true }));
  assert.ok(env.window.keepCalls > before, 'the caret must go back to the draft');

  // Once the gesture's window has passed, focus is the app's business again.
  t.mock.timers.tick(2000);
  const settled = env.window.keepCalls;
  env.document.fire('focusin', new StubEvent('focusin', { target: env.button, bubbles: true }));
  assert.equal(env.window.keepCalls, settled, 'a press long after the hold keeps its own focus');
});

test('a short tap sends nothing and leaves the click alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(250);
  release(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0, 'a tap must keep doing exactly what it did before');
  assert.equal(env.pill(), null, 'no hint may appear for a tap');
  const tap = click(env);
  assert.equal(tap.defaultPrevented, false, 'the tap click belongs to the app');
  assert.equal(tap.immediateStopped, false);
});

test('a hold takes the click its release produces, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  release(env);

  const first = click(env);
  assert.equal(first.defaultPrevented, true, 'the double submit must be prevented');
  assert.equal(first.immediateStopped, true, 'React listens on the root, so it must not receive the click');
  assert.equal(env.document.handlers.has('click'), false, 'the suppressor is one-shot');

  const second = click(env);
  assert.equal(second.defaultPrevented, false, 'the next click must pass through');
});

test('the click suppressor expires when no click arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  release(env);
  assert.equal(env.document.handlers.has('click'), true, 'armed for the release click');
  t.mock.timers.tick(700);
  assert.equal(env.document.handlers.has('click'), false, 'and gone after its bounded life');
  const late = click(env);
  assert.equal(late.defaultPrevented, false);
});

test('a click outside the composer card is not swallowed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  const elsewhere = click(env, makeElement('button'));
  assert.equal(elsewhere.defaultPrevented, false, 'another control pressed in the same moment keeps its click');
  assert.equal(env.document.handlers.has('click'), true, 'and the suppressor is still waiting for ours');
});

test('sliding past the slop cancels the hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env, { clientX: 120, clientY: 780 });
  move(env, 131, 780);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0, 'a scroll that started on the button must never queue');
  assert.equal(env.pill(), null);
});

test('movement inside the slop keeps the hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env, { clientX: 120, clientY: 780 });
  move(env, 126, 785);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 1, 'a finger that stays on the button is still a hold');
});

test('every way a press can end early cancels it', async (t) => {
  const endings = ['pointerup', 'pointerleave', 'window-blur', 'visibilitychange'];
  for (const ending of endings) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const env = await load({ coarse: true });
    press(env);
    t.mock.timers.tick(100);
    if (ending === 'window-blur') env.window.fire('blur', new StubEvent('blur'));
    else if (ending === 'visibilitychange') env.document.fire('visibilitychange', new StubEvent('visibilitychange'));
    else env.document.fire(ending, pointer(ending, { target: env.button }));
    t.mock.timers.tick(400);
    assert.equal(env.editor.dispatched.length, 0, `${ending} must cancel the timer`);
    assert.equal(env.document.handlers.has('click'), false, `${ending} must not leave a suppressor`);
    t.mock.timers.reset();
  }
});

test('a cancel with the finger still on the button keeps the hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env, { clientX: 120, clientY: 780 });
  t.mock.timers.tick(200);
  // Chrome on Android cancels the pointer when its own long-press gesture claims
  // the touch - which is exactly the situation this gesture lives in.
  env.document.fire(
    'pointercancel',
    pointer('pointercancel', { target: env.button, clientX: 120, clientY: 780 }),
  );
  t.mock.timers.tick(200);
  assert.equal(env.editor.dispatched.length, 1, 'the hold the user is part-way through still completes');
});

test('a cancel that reports the finger off the button ends the hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env, { clientX: 120, clientY: 780 });
  t.mock.timers.tick(200);
  // A pan that starts on the button moves the touch before the engine cancels it.
  env.document.fire(
    'pointercancel',
    pointer('pointercancel', { target: env.button, clientX: 160, clientY: 700 }),
  );
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0, 'a scroll that started on the button must never queue');
  assert.equal(env.document.handlers.has('click'), false, 'and it leaves no suppressor behind');
});

test('a second finger cannot start a second gesture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(100);
  press(env, { pointerId: 2, isPrimary: false });
  t.mock.timers.tick(300);
  assert.equal(env.editor.dispatched.length, 1, 'the first press owns the gesture');
  // ...and its own release ends it, second finger or not.
  release(env, { pointerId: 2 });
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 1, 'a foreign pointerup must not extend or repeat it');
});

test('a non-primary pointer is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env, { isPrimary: false });
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0);
});

test('a non-left button is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env, { button: 2 });
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0);
});

test('a disabled button does nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true, disabled: true });
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0);
});

test('an empty draft never arms the gesture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The state the button is Stop in, and the state where the same chord drains
  // the queue instead of using the other mode.
  const env = await load({ coarse: true, text: '' });
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0, 'the queue must never be drained by this gesture');
  assert.equal(env.pill(), null);
});

test('a draft of whitespace only is still empty', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true, text: '   \n ' });
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0);
});

test('the open trigger menu keeps its own Enter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true, menu: 'menu' });
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 0);
});

test('a press that is not on the primary button does nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  // The editor itself, a toolbar button without the primary class, and a node
  // outside the card at all.
  const toolbar = makeElement('button');
  toolbar.setAttribute('type', 'button');
  toolbar.className = 'uV2eYG_tool';
  env.card.appendChild(toolbar);
  for (const target of [env.editor, toolbar, env.document.body]) {
    press(env, { target });
    t.mock.timers.tick(400);
  }
  assert.equal(env.editor.dispatched.length, 0);
});

test('the pill confirms the mode the hold took', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true, label: 'Queue message' });
  press(env);
  t.mock.timers.tick(400);
  const pill = env.pill();
  assert.ok(pill !== null, 'the confirmation must appear while the finger is still down');
  assert.equal(pill.className, 'dsh-pwa-hold-hint');
  assert.equal(pill.textContent, 'Steering', 'the label names the tap, so the hold is the other mode');
  assert.equal(pill.style.top, '692px', 'placed above the button (700 - 8)');
  assert.equal(pill.style.left, '322px', 'centred on the button (300 + 44/2)');
  assert.ok(Number.parseFloat(pill.style.top) < 700, 'the pill must not cover the button itself');

  // A finger resting on a button keeps reporting pointermove from its own tremor.
  // Clearing the pill on the first of those took the answer away a frame after it
  // was written, which is why the phone never showed one.
  move(env, 301, 701);
  assert.ok(env.pill() !== null, 'a tremor under the finger must not clear the confirmation');

  // The send has already happened, so the answer outlives the finger: a press that
  // cleared it on release would flash the outcome past the user in a moment.
  release(env);
  assert.ok(env.pill() !== null, 'the confirmation stays after the release');
  t.mock.timers.tick(1400);
  assert.equal(env.pill(), null, 'and goes on its own a moment later');
});

test('a steer label queues, and an unknown label falls back', async (t) => {
  for (const [label, expected] of [
    ['Steer message', 'Queued'],
    ['Enviar mensaje', 'Sent'],
    ['', 'Sent'],
  ]) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const env = await load({ coarse: true, label });
    press(env);
    t.mock.timers.tick(400);
    assert.equal(env.pill().textContent, expected, `label ${JSON.stringify(label)}`);
    release(env);
    t.mock.timers.reset();
  }
});

test('the pill is clamped inside a narrow window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The button at the right edge of a 390px window, with a 120px pill.
  const env = await load({ coarse: true, pillWidth: 120, rect: { top: 700, left: 370, width: 40 } });
  press(env);
  t.mock.timers.tick(400);
  const pill = env.pill();
  assert.equal(pill.style.left, '322px', 'half the pill plus the gutter stays on screen (390 - 60 - 8)');
});

test('the pill style is injected once across gestures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  for (let i = 0; i < 2; i += 1) {
    press(env);
    t.mock.timers.tick(400);
    release(env);
    click(env);
  }
  const styles = env.document.head.children.filter((el) => el.tagName === 'STYLE');
  assert.equal(styles.length, 1, 'one style element for the life of the page');
  assert.match(styles[0].textContent, /\.dsh-pwa-hold-hint\{/);
  assert.match(styles[0].textContent, /pointer-events:none/, 'the pill must not eat the click it sits above');
});

test('the whole gesture works without the vibration API', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 1, 'vibration is a courtesy, not a dependency');
});

test('a hold gives one short vibration when the API exists', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const env = await load({ coarse: true, vibrate: (ms) => calls.push(ms) });
  press(env);
  t.mock.timers.tick(400);
  assert.deepEqual(calls, [10]);
});

test('a long press while the keyboard is up does not open the browser menu', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  const menu = new StubEvent('contextmenu', { target: env.button, cancelable: true });
  env.document.fire('contextmenu', menu);
  assert.equal(menu.defaultPrevented, true);
  assert.equal(menu.immediateStopped, true);
});

test('a long press elsewhere in the composer keeps its menu', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  const menu = new StubEvent('contextmenu', { target: env.editor, cancelable: true });
  env.document.fire('contextmenu', menu);
  assert.equal(menu.defaultPrevented, false, 'the draft paste menu is the app\'s, not ours');
});

test('the gesture starts fresh after a completed hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await load({ coarse: true });
  press(env);
  t.mock.timers.tick(400);
  release(env);
  click(env);
  press(env);
  t.mock.timers.tick(400);
  assert.equal(env.editor.dispatched.length, 2, 'the next press is a new gesture');
  release(env);
});
