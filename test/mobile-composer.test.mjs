import { test } from 'node:test';
import assert from 'node:assert/strict';

// The mobile composer fix runs in the browser, but its decision logic is plain
// DOM event handling and can be pinned down with a small stub. These tests exist
// because the two rules they encode are what the Android fixes actually depend
// on: a plain Enter must never reach the app (stopImmediatePropagation, not just
// preventDefault), and an Android paste must be replayed as a real ClipboardEvent
// carrying the text, because the composer reads only event.clipboardData.

const EDITOR_SELECTOR = '[data-lexical-editor="true"]';

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
        isComposing: false,
        inputType: '',
        data: null,
        dataTransfer: null,
        clipboardData: null,
        bubbles: false,
        cancelable: false,
        composed: false,
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
class StubClipboardEvent extends StubEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

class StubDataTransfer {
  constructor() {
    this.data = new Map();
  }
  setData(type, value) {
    this.data.set(type, String(value));
  }
  getData(type) {
    return this.data.get(type) ?? '';
  }
}

function makeDocument() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = handlers.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    // Fire the way a real capture-phase dispatch would: stopImmediatePropagation
    // silences every later listener on the same node.
    fire(type, event) {
      for (const fn of handlers.get(type) ?? []) {
        if (event.immediateStopped) break;
        fn(event);
      }
      return event;
    },
  };
}

function makeRoot({ haspopup = null, visible = true } = {}) {
  const dispatched = [];
  const root = {
    id: '',
    dispatched,
    offsetParent: visible ? {} : null,
    getAttribute: (attr) => (attr === 'aria-haspopup' ? haspopup : null),
    closest: (selector) => (selector === EDITOR_SELECTOR ? root : null),
    dispatchEvent: (event) => {
      dispatched.push(event);
      return true;
    },
  };
  return root;
}

let loadCount = 0;

async function load({ coarse = true, forced = false, clipboard = null } = {}) {
  const document = makeDocument();
  const window = {
    matchMedia: () => ({ matches: coarse }),
    __DSH_FORCE_MOBILE_COMPOSER__: forced,
  };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    KeyboardEvent: globalThis.KeyboardEvent,
    ClipboardEvent: globalThis.ClipboardEvent,
    DataTransfer: globalThis.DataTransfer,
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.KeyboardEvent = StubKeyboardEvent;
  globalThis.ClipboardEvent = StubClipboardEvent;
  globalThis.DataTransfer = StubDataTransfer;
  // Node 21+ defines a read-only `navigator`, so it must be replaced wholesale.
  Object.defineProperty(globalThis, 'navigator', {
    value: clipboard === null ? {} : { clipboard },
    configurable: true,
    writable: true,
  });
  // A unique query string defeats the ESM module cache, so each test gets a
  // freshly executed copy of the fix.
  await import(`../src/mobile-composer.js?stub=${++loadCount}`);
  return { document, window, root: makeRoot(), restore: () => Object.assign(globalThis, previous) };
}

function enter(overrides = {}) {
  return new StubKeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
}

test('a coarse pointer turns a plain Enter into a line break, not a send', async () => {
  const { document, root } = await load({ coarse: true });
  const original = enter();
  original.target = root;
  document.fire('keydown', original);

  assert.equal(original.defaultPrevented, true, 'the send must be prevented');
  assert.equal(
    original.immediateStopped,
    true,
    'preventDefault alone is not enough: the app keymap submit()s anyway, so propagation must stop'
  );
  assert.equal(root.dispatched.length, 1, 'exactly one replacement event');
  const replacement = root.dispatched[0];
  assert.equal(replacement.type, 'keydown');
  assert.equal(replacement.key, 'Enter');
  assert.equal(
    replacement.shiftKey,
    true,
    'Lexical inserts a line break only for Enter with shiftKey (client.js keymap defers on shiftKey)'
  );
});

test('the replacement break cannot recurse through the interceptor', async () => {
  const { document, root } = await load({ coarse: true });
  const original = enter();
  original.target = root;
  document.fire('keydown', original);

  const replacement = root.dispatched[0];
  replacement.target = root;
  document.fire('keydown', replacement);

  assert.equal(replacement.defaultPrevented, false, 'the synthetic break must reach Lexical untouched');
  assert.equal(replacement.immediateStopped, false, 'the synthetic break must not be swallowed');
  assert.equal(root.dispatched.length, 1, 'no second event may be emitted');
});

test('the trigger menu keeps Enter while it is open', async () => {
  const { document, root } = await load({ coarse: true });
  root.getAttribute = (attr) => (attr === 'aria-haspopup' ? 'menu' : null);
  const event = enter();
  event.target = root;
  document.fire('keydown', event);

  assert.equal(event.defaultPrevented, false, 'Enter settles the slash menu, so it must pass through');
  assert.equal(root.dispatched.length, 0, 'no line break may be emitted while the menu is open');
});

test('modifier Enters are left alone', async () => {
  const { document, root } = await load({ coarse: true });
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) {
    const event = enter({ [modifier]: true });
    event.target = root;
    document.fire('keydown', event);
    assert.equal(event.defaultPrevented, false, `${modifier} Enter must be untouched`);
  }
  assert.equal(root.dispatched.length, 0);
});

test('an in-flight composition is never interrupted', async () => {
  const { document, root } = await load({ coarse: true });
  const composing = enter({ isComposing: true });
  composing.target = root;
  document.fire('keydown', composing);
  const imeKeycode = enter({ keyCode: 229 });
  imeKeycode.target = root;
  document.fire('keydown', imeKeycode);

  assert.equal(composing.defaultPrevented, false);
  assert.equal(imeKeycode.defaultPrevented, false);
  assert.equal(root.dispatched.length, 0);
});

test('a fine pointer installs nothing at all', async () => {
  const { document } = await load({ coarse: false, forced: false });
  assert.equal(document.handlers.size, 0, 'desktop must be byte-for-byte untouched');
});

test('the force flag overrides pointer detection for testing', async () => {
  const { document } = await load({ coarse: false, forced: true });
  assert.ok(document.handlers.has('keydown'));
  assert.ok(document.handlers.has('beforeinput'));
});

test('an Android paste on beforeinput is replayed as a real paste event', async () => {
  const { document, root } = await load({ coarse: true });
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', 'PROBE_TEXT');
  // This is the Android shape: beforeinput with the payload on dataTransfer and
  // NO clipboardData, which is why the composer's own handler drops it.
  const androidPaste = new StubEvent('beforeinput', {
    inputType: 'insertFromPaste',
    dataTransfer: transfer,
    clipboardData: null,
    bubbles: true,
    cancelable: true,
  });
  androidPaste.target = root;
  document.fire('beforeinput', androidPaste);

  assert.equal(androidPaste.defaultPrevented, true, 'the text-losing default must be cancelled');
  assert.equal(androidPaste.immediateStopped, true);
  assert.equal(root.dispatched.length, 1);
  const replayed = root.dispatched[0];
  assert.equal(replayed.type, 'paste');
  assert.equal(
    replayed.clipboardData.getData('text/plain'),
    'PROBE_TEXT',
    'the composer reads event.clipboardData, so the text must travel there'
  );
});

test('a paste with no readable payload falls back to the clipboard API', async () => {
  const readText = async () => 'FROM_CLIPBOARD';
  const { document, root } = await load({ coarse: true, clipboard: { readText } });
  const opaque = new StubEvent('beforeinput', {
    inputType: 'insertFromPaste',
    dataTransfer: null,
    clipboardData: null,
    data: null,
    bubbles: true,
    cancelable: true,
  });
  opaque.target = root;
  document.fire('beforeinput', opaque);
  assert.equal(opaque.defaultPrevented, true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(root.dispatched.length, 1, 'the async clipboard read must still replay a paste');
  assert.equal(root.dispatched[0].clipboardData.getData('text/plain'), 'FROM_CLIPBOARD');
});

test('non-paste beforeinput types are ignored', async () => {
  const { document, root } = await load({ coarse: true });
  for (const inputType of ['insertText', 'insertParagraph', 'deleteContentBackward']) {
    const event = new StubEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    event.target = root;
    document.fire('beforeinput', event);
    assert.equal(event.defaultPrevented, false, `${inputType} must be untouched`);
  }
  assert.equal(root.dispatched.length, 0);
});
