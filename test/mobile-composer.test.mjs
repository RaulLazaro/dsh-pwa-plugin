import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The mobile composer fix runs in the browser, but its decision logic is plain
// DOM event handling and can be pinned down with a small stub. These tests exist
// because the two rules they encode are what the Android fixes actually depend
// on: a plain Enter must never reach the app (stopImmediatePropagation, not just
// preventDefault), and an Android paste must be replayed as a real ClipboardEvent
// carrying the text, because the composer reads only event.clipboardData.

const EDITOR_SELECTOR = '[data-lexical-editor="true"]';

// node:test's MockTimers replaces globalThis.setTimeout for the length of a
// test that enables it, and the drain below runs before such a test ever ticks,
// so it has to hold the real timer.
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
    this._files = [];
    // Blob/File transfer, which is the only shape the composer accepts an image
    // in: it walks clipboardData.items looking for item.kind === "file".
    this.items = {
      add: (file) => {
        this._files.push(file);
      },
    };
  }
  get files() {
    return this._files;
  }
  get types() {
    return [...this.data.keys()];
  }
  setData(type, value) {
    this.data.set(type, String(value));
  }
  getData(type) {
    return this.data.get(type) ?? '';
  }
}

class StubFile {
  constructor(parts, name, options = {}) {
    this.parts = parts;
    this.name = name;
    this.type = options.type ?? '';
    this.size = parts.length;
  }
}

/** Enough of an element for the composer: listeners, attributes, children. */
function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    textContent: '',
    value: '',
    rows: 0,
    type: '',
    style: { cssText: '', display: '' },
    attributes: {},
    children: [],
    setAttribute: (name, value) => {
      el.attributes[name] = String(value);
    },
    getAttribute: (name) => el.attributes[name] ?? null,
    appendChild: (child) => {
      el.children.push(child);
      return child;
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch: (type, event) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
      return event;
    },
    closest: () => null,
    focus: () => {},
  };
  return el;
}

function makeDocument() {
  const handlers = new Map();
  return {
    handlers,
    activeElement: null,
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    querySelectorAll: () => [],
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

function makeRoot({ Element = null, haspopup = null, visible = true, consume = false, pasteLands = true, pasteDropAfter = 0 } = {}) {
  const dispatched = [];
  const root = Object.assign(Element === null ? {} : new Element(), {
    id: '',
    dispatched,
    textContent: '',
    offsetParent: visible ? {} : null,
    closest: (selector) => (selector === EDITOR_SELECTOR ? root : null),
    dispatchEvent: (event) => {
      dispatched.push(event);
      // The composer's PASTE handler calls preventDefault on the branch that
      // inserts the text, and inserting it is what puts the text in the editor.
      // The two are separable on the device - preventDefault with nothing
      // inserted - which is why the fix measures the editor instead of trusting
      // the verdict. pasteDropAfter reproduces the other half seen on the device:
      // the text renders and the editor then reconciles it away (ed=505 -> ed=0).
      if (consume && event.type === 'paste') {
        event.preventDefault();
        if (pasteLands) {
          root.textContent += event.clipboardData ? event.clipboardData.getData('text/plain') : '';
          if (pasteDropAfter > 0) {
            setTimeout(() => {
              root.textContent = '';
            }, pasteDropAfter);
          }
        }
      }
      return true;
    },
  });
  if (haspopup !== null) root.attributes['aria-haspopup'] = haspopup;
  return root;
}

let loadCount = 0;

async function load({
  coarse = true,
  forced = false,
  clipboard = null,
  virtualKeyboard = null,
  consume = false,
  pasteLands = true,
  pasteDropAfter = 0,
  execCommand = null,
} = {}) {
  // Let any timer the previous test's module instance left behind fire while
  // the globals it was loaded with are still installed. Its deferred hide()
  // reads the ambient navigator when it fires, so without this it would land on
  // THIS test's spy and be read as this test's keyboard.
  await drainRealTimers();
  await drainRealTimers();
  const document = makeDocument();
  if (execCommand !== null) document.execCommand = execCommand;
  const window = {
    matchMedia: () => ({ matches: coarse }),
    __DSH_FORCE_MOBILE_COMPOSER__: forced,
  };
  // A fresh HTMLElement per load: the fix patches the prototype, so a shared
  // class would stack one wrapper per test and each test would measure the
  // previous one's patches too.
  const focusLog = [];
  const blurLog = [];
  class Element {
    constructor() {
      this.attributes = {};
    }
    focus(options) {
      focusLog.push({ element: this, options: options ?? null });
      document.activeElement = this;
    }
    blur() {
      blurLog.push(this);
      if (document.activeElement === this) document.activeElement = null;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
  }
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    ClipboardEvent: globalThis.ClipboardEvent,
    DataTransfer: globalThis.DataTransfer,
    File: globalThis.File,
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = Element;
  globalThis.KeyboardEvent = StubKeyboardEvent;
  globalThis.ClipboardEvent = StubClipboardEvent;
  globalThis.DataTransfer = StubDataTransfer;
  globalThis.File = StubFile;
  const api = {};
  if (clipboard !== null) api.clipboard = clipboard;
  if (virtualKeyboard !== null) api.virtualKeyboard = virtualKeyboard;
  // Node 21+ defines a read-only `navigator`, so it must be replaced wholesale.
  Object.defineProperty(globalThis, 'navigator', {
    value: api,
    configurable: true,
    writable: true,
  });
  // A unique query string defeats the ESM module cache, so each test gets a
  // freshly executed copy of the fix.
  await import(`../src/mobile-composer.js?stub=${++loadCount}`);
  return {
    document,
    window,
    Element,
    focusLog,
    blurLog,
    body: document.body,
    root: makeRoot({ Element, consume, pasteLands, pasteDropAfter }),
    restore: () => Object.assign(globalThis, previous),
  };
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

/** Let the async clipboard chain (readText -> read -> getType) finish. */
async function settle(ticks = 6) {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

test('a consumed paste is never inserted twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const { document, root } = await load({
    coarse: true,
    consume: true,
    execCommand: (name, ui, value) => {
      commands.push([name, value]);
      root.textContent += value;
      return true;
    },
  });
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', 'ONCE');
  const androidPaste = new StubEvent('beforeinput', {
    inputType: 'insertFromPaste',
    dataTransfer: transfer,
    bubbles: true,
    cancelable: true,
  });
  androidPaste.target = root;
  document.fire('beforeinput', androidPaste);

  assert.equal(root.dispatched.length, 1, 'exactly one synthetic paste');
  // The verification window has to close before the text can have been measured.
  t.mock.timers.tick(500);
  assert.equal(root.textContent, 'ONCE');
  assert.equal(
    commands.length,
    0,
    'preventDefault on the synthetic paste, with the text in the editor, is a landed paste and no fallback may run'
  );
});

test('a rejected paste falls back to insertText', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const { document, root } = await load({
    coarse: true,
    execCommand: (name, ui, value) => {
      commands.push([name, value]);
      root.textContent += value;
      return true;
    },
  });
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', 'FALLBACK');
  const androidPaste = new StubEvent('beforeinput', {
    inputType: 'insertFromPasteAsQuotation',
    dataTransfer: transfer,
    bubbles: true,
    cancelable: true,
  });
  androidPaste.target = root;
  document.fire('beforeinput', androidPaste);

  assert.equal(root.dispatched.length, 1);
  assert.deepEqual(commands, [], 'the fallback is held until the editor has been measured');
  t.mock.timers.tick(500);
  assert.deepEqual(
    commands,
    [['insertText', 'FALLBACK']],
    'execCommand generates the real beforeinput/input pair Lexical handles, one macrotask after the window a handled selection command opens'
  );
  assert.equal(root.textContent, 'FALLBACK');
});

test('a paste event the composer cannot read is taken over', async () => {
  const { document, root } = await load({
    coarse: true,
    clipboard: { readText: async () => 'FROM_CLIPBOARD' },
  });
  const empty = new StubClipboardEvent('paste', {
    clipboardData: null,
    bubbles: true,
    cancelable: true,
  });
  empty.target = root;
  document.fire('paste', empty);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(empty.defaultPrevented, true, 'the composer would return false on this event');
  assert.equal(root.dispatched.length, 1);
  assert.equal(root.dispatched[0].clipboardData.getData('text/plain'), 'FROM_CLIPBOARD');
});

test('a well-formed paste event is left to the composer', async () => {
  const { document, root } = await load({ coarse: true });
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', 'NATIVE');
  const native = new StubClipboardEvent('paste', {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  });
  native.target = root;
  document.fire('paste', native);

  assert.equal(native.defaultPrevented, false, 'the composer reads clipboardData itself');
  assert.equal(root.dispatched.length, 0, 'nothing may be re-dispatched');
});

test('an image on the clipboard is replayed as a file paste', async () => {
  const blob = { size: 3, type: 'image/png' };
  const item = { types: ['image/png'], getType: async () => blob };
  const { document, root } = await load({
    coarse: true,
    clipboard: { readText: async () => '', read: async () => [item] },
  });
  const empty = new StubClipboardEvent('paste', {
    clipboardData: null,
    bubbles: true,
    cancelable: true,
  });
  empty.target = root;
  document.fire('paste', empty);
  await settle();

  assert.equal(root.dispatched.length, 1, 'the image must reach the composer as one paste');
  const replayed = root.dispatched[0];
  assert.equal(replayed.type, 'paste');
  assert.equal(
    replayed.clipboardData.files.length,
    1,
    'Android puts no image on clipboardData, so it has to be rebuilt as a file item'
  );
  assert.equal(replayed.clipboardData.files[0].type, 'image/png');
  assert.equal(replayed.clipboardData.files[0].name, 'pasted.png');
});

test('a clipboard holding no image is reported, never guessed at', async () => {
  const { document, root } = await load({
    coarse: true,
    clipboard: { readText: async () => '', read: async () => [] },
  });
  const empty = new StubClipboardEvent('paste', {
    clipboardData: null,
    bubbles: true,
    cancelable: true,
  });
  empty.target = root;
  document.fire('paste', empty);
  await settle();

  assert.equal(root.dispatched.length, 0, 'nothing may be dispatched when the clipboard holds no image');
});

test('a paste carrying markup is normalised to its plain text', async () => {
  const { document, root } = await load({ coarse: true });
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', 'RICH');
  transfer.setData('text/html', '<p>RICH</p>');
  const rich = new StubClipboardEvent('paste', {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  });
  rich.target = root;
  document.fire('paste', rich);

  assert.equal(rich.defaultPrevented, true, 'a paste that carries markup is taken over');
  assert.equal(root.dispatched.length, 1);
  const replayed = root.dispatched[0];
  assert.equal(replayed.clipboardData.getData('text/plain'), 'RICH');
  assert.deepEqual(
    replayed.clipboardData.types,
    ['text/plain'],
    'only the text travels, so the paste cannot reach the editor as markup'
  );
});

test('a paste that missed every editable is put back into the composer', async () => {
  const { document, root } = await load({ coarse: true });
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', 'LOST');
  const ok = new StubClipboardEvent('paste', {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  });
  ok.target = root;
  document.fire('paste', ok);
  assert.equal(ok.defaultPrevented, false, 'the composer owns a paste aimed at it');
  assert.equal(root.dispatched.length, 0);

  // The clipboard overlay way: the editor is not under the event at all, so the
  // composer never runs and the user sees nothing happen.
  const stray = new StubClipboardEvent('paste', {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  });
  stray.target = { tagName: 'BODY' };
  document.fire('paste', stray);

  assert.equal(stray.defaultPrevented, true, 'a stray paste is claimed');
  assert.equal(root.dispatched.length, 1);
  assert.equal(root.dispatched[0].clipboardData.getData('text/plain'), 'LOST');
});

test('a block committed where no editable sits is put back into the composer', async () => {
  const { document, root } = await load({ coarse: true });
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', 'SEED');
  const seed = new StubClipboardEvent('paste', {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  });
  seed.target = root;
  document.fire('paste', seed);
  assert.equal(root.dispatched.length, 0, 'a paste aimed at the composer is left to the composer');

  // The clipboard panel takes focus: the block arrives as one insertText with no
  // editable under the event at all, which is the gesture the device reports as
  // doing nothing.
  const block = 'x'.repeat(131);
  const bulk = new StubEvent('beforeinput', {
    inputType: 'insertText',
    data: block,
    bubbles: true,
    cancelable: true,
  });
  bulk.target = { tagName: 'BODY' };
  document.fire('beforeinput', bulk);

  assert.equal(bulk.defaultPrevented, true, 'a block with no editable under it is claimed');
  assert.equal(bulk.immediateStopped, true);
  assert.equal(root.dispatched.length, 1);
  assert.equal(root.dispatched[0].clipboardData.getData('text/plain'), block);
});

test('a block committed into a real field is left to that field', async () => {
  const { document, root } = await load({ coarse: true });
  const block = 'x'.repeat(131);
  const field = new StubEvent('beforeinput', {
    inputType: 'insertText',
    data: block,
    bubbles: true,
    cancelable: true,
  });
  // The device proves a plain textarea takes this commit natively: the field
  // must keep receiving it, or the fix breaks the one path that works.
  field.target = { tagName: 'TEXTAREA' };
  document.fire('beforeinput', field);

  assert.equal(field.defaultPrevented, false, 'a textarea owns its own commit');
  assert.equal(root.dispatched.length, 0);
});

test('a clipboard block arriving as one insertText is replayed as a paste', async () => {
  const { document, root } = await load({ coarse: true });
  const block = 'x'.repeat(131);
  const bulk = new StubEvent('beforeinput', {
    inputType: 'insertText',
    data: block,
    bubbles: true,
    cancelable: true,
  });
  bulk.target = root;
  document.fire('beforeinput', bulk);

  assert.equal(bulk.defaultPrevented, true, 'a block too long to be a keystroke is claimed');
  assert.equal(bulk.immediateStopped, true);
  assert.equal(root.dispatched.length, 1);
  assert.equal(root.dispatched[0].clipboardData.getData('text/plain'), block);
});

test('an ordinary keystroke is left to the editor', async () => {
  const { document, root } = await load({ coarse: true });
  const typed = new StubEvent('beforeinput', {
    inputType: 'insertText',
    data: 'a',
    bubbles: true,
    cancelable: true,
  });
  typed.target = root;
  document.fire('beforeinput', typed);

  assert.equal(typed.defaultPrevented, false, 'typing must not be rerouted');
  assert.equal(typed.immediateStopped, false);
  assert.equal(root.dispatched.length, 0);

  // Exactly the threshold: a suggested word still types normally.
  const word = new StubEvent('beforeinput', {
    inputType: 'insertText',
    data: 'x'.repeat(16),
    bubbles: true,
    cancelable: true,
  });
  word.target = root;
  document.fire('beforeinput', word);

  assert.equal(word.defaultPrevented, false, 'a word is still typing');
  assert.equal(root.dispatched.length, 0);
});

/** The one insertText channel the composer cannot refuse, with the editor watching. */
function androidPasteInto(document, root, text, inputType = 'insertFromPaste') {
  const transfer = new StubDataTransfer();
  transfer.setData('text/plain', text);
  const event = new StubEvent('beforeinput', {
    inputType,
    dataTransfer: transfer,
    bubbles: true,
    cancelable: true,
  });
  event.target = root;
  document.fire('beforeinput', event);
  return event;
}

test('a paste the composer claims to have taken but that never landed is re-sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const { document, root } = await load({
    coarse: true,
    consume: true,
    pasteLands: false,
    execCommand: (name, ui, value) => {
      commands.push([name, value]);
      root.textContent += value;
      return true;
    },
  });
  const block = 'GHOSTED ' + 'y'.repeat(120);
  androidPasteInto(document, root, block);

  assert.equal(root.dispatched.length, 1, 'the paste is still tried first');
  assert.deepEqual(commands, [], 'nothing is retried before the window closes');
  assert.equal(root.textContent, '', 'preventDefault with nothing inserted is the shape that used to read as success');
  t.mock.timers.tick(500);
  assert.deepEqual(commands, [['insertText', block]], 'the text is re-sent as the real insertText the editor handles');
  assert.equal(root.textContent, block, 'and it is the measurement, not the verdict, that ends this');
});

test('text that lands and is then dropped by the editor is put back once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const { document, root } = await load({
    coarse: true,
    consume: true,
    pasteDropAfter: 60,
    execCommand: (name, ui, value) => {
      commands.push([name, value]);
      root.textContent += value;
      return true;
    },
  });
  const block = 'VANISHES ' + 'z'.repeat(120);
  androidPasteInto(document, root, block);

  // The device's shape: the text renders (the composer reported ed=505) and the
  // editor then empties it (ed=0), which 1.1.3 read as "composer consumed".
  assert.equal(root.textContent, block);
  t.mock.timers.tick(100);
  assert.equal(root.textContent, '', 'the editor dropped text it never had in its model');
  t.mock.timers.tick(400);
  assert.deepEqual(commands, [['insertText', block]], 'a dropped paste is re-sent exactly once');
  assert.equal(root.textContent, block);

  t.mock.timers.tick(2000);
  assert.equal(commands.length, 1, 'and a settled retry starts no further attempts');
});

test('the retry is not claimed a second time by the bulk-paste rule', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  let nested = null;
  const { document, root } = await load({
    coarse: true,
    consume: true,
    pasteLands: false,
    execCommand: (name, ui, value) => {
      commands.push([name, value]);
      // execCommand in a browser generates the editor's own beforeinput, which
      // carries exactly the block this code claims off the clipboard path.
      nested = new StubEvent('beforeinput', {
        inputType: 'insertText',
        data: value,
        bubbles: true,
        cancelable: true,
      });
      nested.target = root;
      document.fire('beforeinput', nested);
      root.textContent += value;
      return true;
    },
  });
  const block = 'NESTED ' + 'q'.repeat(120);
  androidPasteInto(document, root, block);
  t.mock.timers.tick(500);

  assert.deepEqual(commands, [['insertText', block]]);
  assert.notEqual(nested, null, 'the retry has to have generated a beforeinput for this test to mean anything');
  assert.equal(nested.defaultPrevented, false, 'our own insertText must be left for the editor to handle');
  assert.equal(nested.immediateStopped, false, 'and must not be taken over again');
  assert.equal(root.dispatched.length, 1, 'a re-claimed block would have dispatched a second synthetic paste');
});

/**
 * The probe buttons, the `field` comparison editables and the trace panel were
 * the instrumentation for the paste investigation (closed in 1.1.4). Shipping
 * them would put an overlay on every phone, so the module is asserted not to
 * carry them any more.
 */
test('the composer ships no diagnostic probe or trace panel', async () => {
  const source = await readFile(new URL('../src/mobile-composer.js', import.meta.url), 'utf-8');
  assert.doesNotMatch(
    source,
    /data-dsh-pwa-probe|data-dsh-pwa-diagnostic/,
    'the probe controls and the trace panel must not come back',
  );

  const { body } = await load({ coarse: true });
  const overlaid = body.children.filter((child) => {
    const attrs = child.attributes ?? {};
    return attrs['data-dsh-pwa-probe'] !== undefined || attrs['data-dsh-pwa-diagnostic'] !== undefined;
  });
  assert.deepEqual(overlaid, [], 'a coarse pointer must get no diagnostics overlay');
});

// ---- 4. the keyboard comes up for a tap on the text area, nothing else -----
//
// What these pin down: dsh re-focuses the composer when the session changes
// (tapping New session) and from every composer button's own mousedown, and on
// Android each of those raises the soft keyboard over half the screen. A focus
// call cannot be read on its own, so the rule is the composer's own focus
// state: a call on an editor the user is not in is not theirs, a call on the
// one they are typing in is.

/** A press on a composer button that is not the text area (send, stop, +, model). */
function composerButton() {
  const card = {};
  return { closest: (selector) => (selector === '[data-composer-card]' ? card : null) };
}

/** A press anywhere else in the app. */
function outsideTarget() {
  return { closest: () => null };
}

function press(document, target) {
  const event = new StubEvent('pointerdown', { bubbles: true, cancelable: true });
  event.target = target;
  document.fire('pointerdown', event);
  return event;
}

test('a programmatic focus of a composer the user is not in never raises the keyboard', async () => {
  const { document, root, focusLog } = await load({ coarse: true });

  root.focus();

  assert.equal(root.getAttribute('inputmode'), 'none', 'inputmode=none is the attribute a browser honours');
  assert.equal(
    root.getAttribute('virtualkeyboardpolicy'),
    'manual',
    'and the browser switch goes on beside it, for the engine that reads that one instead',
  );
  assert.equal(focusLog.length, 1, 'the focus itself must still happen');
  assert.equal(document.activeElement, root, 'the caret still lands in the editor');
});

test('a quiet focus asks the keyboard to go away once the focus has landed', async () => {
  const hides = [];
  const { root } = await load({ coarse: true, virtualKeyboard: { hide: () => hides.push('hide') } });

  root.focus();
  await settle(2);

  assert.deepEqual(hides, ['hide'], 'the attributes are a hint; hide() is the guarantee');
});

test('focus calls on the composer the user is typing in are left alone', async () => {
  const hides = [];
  const { document, root } = await load({ coarse: true, virtualKeyboard: { hide: () => hides.push('hide') } });

  document.activeElement = root;
  root.focus();
  await settle(2);

  assert.equal(
    root.getAttribute('inputmode'),
    null,
    'Lexical re-focusing its own root mid-sentence must not silence the keyboard',
  );
  assert.deepEqual(hides, [], 'and must not close it either');
});

test('a tap on the text area gives the keyboard back', async () => {
  const { document, root, focusLog, blurLog } = await load({ coarse: true });

  root.focus();
  assert.equal(root.getAttribute('inputmode'), 'none', 'quiet to start with');

  press(document, root);

  assert.equal(root.getAttribute('inputmode'), null, 'the attribute is cleared before the browser taps');
  assert.equal(root.getAttribute('virtualkeyboardpolicy'), null);
  assert.equal(blurLog.length, 1, 'the quiet focus is taken down first');
  assert.equal(focusLog.length, 2, 'and the focus is restarted inside the tap, which is what opens the keyboard');
  assert.deepEqual(focusLog[1].options, { preventScroll: true }, 'without moving the page under the tap');
  assert.equal(document.activeElement, root);
});

test('a press on the send button puts an open keyboard away', async () => {
  const hides = [];
  const { document, root } = await load({ coarse: true, virtualKeyboard: { hide: () => hides.push('hide') } });

  document.activeElement = root; // the user was typing
  press(document, composerButton());
  await settle(2);

  assert.deepEqual(hides, ['hide'], 'a send must close the keyboard, not leave it over the transcript');
  assert.equal(
    root.getAttribute('inputmode'),
    'none',
    'and the composer is left quiet, so the press cannot bring the keyboard back',
  );
});

test('the focus the press itself performs cannot reopen the keyboard', async () => {
  const { document, root } = await load({ coarse: true });

  document.activeElement = root;
  press(document, composerButton());
  root.focus(); // what the button's own keepDraftFocus does on that same press

  assert.equal(root.getAttribute('inputmode'), 'none');
  assert.equal(document.activeElement, root, 'and the caret stays in the editor');
});

test('a press outside the composer leaves the editor alone', async () => {
  const hides = [];
  const { document, root } = await load({ coarse: true, virtualKeyboard: { hide: () => hides.push('hide') } });

  document.activeElement = root;
  press(document, outsideTarget());
  await settle(2);

  assert.deepEqual(hides, [], 'a tap on the transcript or the sidebar is not a tap on the composer');
  assert.equal(root.getAttribute('inputmode'), null);
});

test('a fine pointer gets none of this', async () => {
  const { document, root } = await load({ coarse: false });

  root.focus();

  assert.equal(root.getAttribute('inputmode'), null, 'desktop keeps the browser behaviour it has always had');
  assert.equal(root.getAttribute('virtualkeyboardpolicy'), null);
  assert.equal(document.activeElement, root);
});
