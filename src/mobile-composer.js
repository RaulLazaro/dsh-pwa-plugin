/*
 * Mobile composer fixes, injected inline into index.html by src/host/index.js.
 *
 * Two Android-only defects in the shipped composer, both fixed here without
 * patching @deepseek-ai/dsh-client-ui-conversation:
 *
 * 1. No newline. The composer binds plain Enter to send and leaves only
 *    Shift+Enter to Lexical for a line break (client.js:16706 defers when
 *    event.shiftKey is true). A soft keyboard has no Shift, so a phone can
 *    never type a line break. We translate a plain Enter into the Shift+Enter
 *    keydown Lexical already understands, and the synthetic event cannot
 *    recurse because it carries shiftKey.
 *
 * 2. Paste does nothing. Chrome on Android delivers a long-press paste as
 *    beforeinput/insertFromPaste and puts the payload on the InputEvent's
 *    dataTransfer. The composer's PASTE handler reads event.clipboardData
 *    only (client.js:16718), sees null, and returns false, so the text is
 *    dropped. We re-dispatch a real paste ClipboardEvent carrying the text, so
 *    the composer's own insertion path runs unchanged.
 *
 * Both listeners are capture-phase and gated to coarse pointers, so desktop
 * behaviour is byte-for-byte unchanged. window.__DSH_FORCE_MOBILE_COMPOSER__
 * forces them on for testing.
 */
(function () {
  'use strict';

  var FORCED = window.__DSH_FORCE_MOBILE_COMPOSER__ === true;
  var COARSE =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  if (!COARSE && !FORCED) return;

  var EDITOR_SELECTOR = '[data-lexical-editor="true"]';
  var PASTE_INPUT_TYPES = { insertFromPaste: true, insertFromPasteAsQuotation: true };
  var marked = {};

  /** The composer's Lexical root, or null when the event is not aimed at it. */
  function composerRoot(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    var root = target.closest(EDITOR_SELECTOR);
    if (root === null) return null;
    if (root.closest('[role="dialog"]') !== null) return null;
    if (root.offsetParent === null) return null;
    return root;
  }

  // The trigger menu (slash / reference) owns Enter while it is open; DSH
  // advertises that with aria-haspopup="menu" on the input (InputBar.module.css).
  function menuOpen(root) {
    return root.getAttribute('aria-haspopup') === 'menu';
  }

  function stamp(node) {
    var key = node.id || (node.id = 'dsh-pwa-node-' + Math.random().toString(36).slice(2));
    return key;
  }

  document.addEventListener(
    'keydown',
    function (event) {
      if (event.key !== 'Enter') return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing === true || event.keyCode === 229) return;
      var root = composerRoot(event);
      if (root === null || menuOpen(root)) return;
      // No recursion guard is needed here: the replacement event carries
      // shiftKey, which fails the test above and is left for Lexical.
      event.preventDefault();
      event.stopImmediatePropagation();
      root.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    },
    true,
  );

  function replayPaste(root, text) {
    if (typeof text !== 'string' || text === '') return;
    var transfer;
    try {
      transfer = new DataTransfer();
      transfer.setData('text/plain', text);
    } catch (err) {
      transfer = null;
    }
    if (transfer === null) return;
    var key = stamp(root);
    marked[key] = true;
    try {
      root.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    } finally {
      marked[key] = false;
    }
  }

  document.addEventListener(
    'beforeinput',
    function (event) {
      if (PASTE_INPUT_TYPES[event.inputType] !== true) return;
      var root = composerRoot(event);
      if (root === null) return;
      var source = event.dataTransfer || event.clipboardData || null;
      var text = null;
      if (source !== null && typeof source.getData === 'function') {
        text = source.getData('text/plain');
      }
      if ((text === null || text === '') && typeof event.data === 'string') {
        text = event.data;
      }
      if (typeof text === 'string' && text !== '') {
        event.preventDefault();
        event.stopImmediatePropagation();
        replayPaste(root, text);
        return;
      }
      // Opaque event: read the clipboard ourselves. The paste gesture counts as
      // user activation, so readText is permitted.
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigator.clipboard.readText().then(
        function (clip) {
          replayPaste(root, clip);
        },
        function () {},
      );
    },
    true,
  );
})();
