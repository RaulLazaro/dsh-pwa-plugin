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
 *    beforeinput/insertFromPaste with the payload on the InputEvent's
 *    dataTransfer. Lexical's own beforeinput branch preventDefaults every
 *    input type (client.js:5501) and then dispatches PASTE_COMMAND with that
 *    InputEvent (client.js:5521-5523), but the composer's PASTE handler reads
 *    event.clipboardData only (client.js:16718) and returns false when there
 *    is none - so the text is dropped after the native insertion has already
 *    been cancelled. We take the event over and re-dispatch a real paste
 *    ClipboardEvent, which the composer's handler reads. When that synthetic
 *    event is rejected, or nothing readable came with the event, we fall back
 *    to document.execCommand('insertText'), which produces the real
 *    beforeinput/input pair Lexical does handle.
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

  var traced = [];
  var panel = null;
  var panelTimer = null;

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

  // Every paste branch records one line. Nothing is shown to the user unless a
  // branch fails, so a working phone never sees a panel and a broken one says
  // exactly which step lost the text.
  function trace(line) {
    traced.push(line);
    if (traced.length > 6) traced.shift();
    try {
      console.log('[DSH PWA] ' + line);
    } catch (err) {}
  }

  function report(line) {
    trace(line);
    if (typeof document.createElement !== 'function' || document.body === null) return;
    if (panel === null) {
      panel = document.createElement('pre');
      panel.setAttribute('data-dsh-pwa-diagnostic', '');
      panel.style.cssText = [
        'position:fixed',
        'left:0',
        'right:0',
        'bottom:0',
        'z-index:2147483647',
        'margin:0',
        'padding:8px 10px',
        'max-height:38vh',
        'overflow:hidden',
        'background:rgba(15,23,42,0.96)',
        'color:#e2e8f0',
        'font:11px/1.5 ui-monospace,monospace',
        'white-space:pre-wrap',
        'word-break:break-word',
        'pointer-events:none',
        'border-top:1px solid #334155',
      ].join(';');
      document.body.appendChild(panel);
    }
    panel.textContent = traced.join('\n');
    panel.style.display = 'block';
    if (panelTimer !== null) clearTimeout(panelTimer);
    panelTimer = setTimeout(function () {
      if (panel !== null) panel.style.display = 'none';
    }, 20000);
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

  function textFrom(source) {
    if (source === null || source === undefined) return '';
    if (typeof source.getData !== 'function') return '';
    try {
      return source.getData('text/plain') || '';
    } catch (err) {
      return '';
    }
  }

  /**
   * Re-dispatch the paste as a real ClipboardEvent so the composer's handler,
   * which reads event.clipboardData, can run unchanged. Returns true when the
   * composer consumed it: that handler calls preventDefault on the branch that
   * inserts the text, so defaultPrevented is the composer's own verdict.
   */
  function replayAsPaste(root, text) {
    var transfer;
    try {
      transfer = new DataTransfer();
      transfer.setData('text/plain', text);
      if (transfer.getData('text/plain') !== text) return false;
    } catch (err) {
      return false;
    }
    var event;
    try {
      event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
    } catch (err) {
      return false;
    }
    try {
      root.dispatchEvent(event);
    } catch (err) {
      return false;
    }
    return event.defaultPrevented === true;
  }

  function insertDirectly(root, text) {
    if (typeof document.execCommand !== 'function') return false;
    try {
      if (typeof root.focus === 'function') root.focus({ preventScroll: true });
      return document.execCommand('insertText', false, text) === true;
    } catch (err) {
      return false;
    }
  }

  function insert(root, text, origin) {
    if (replayAsPaste(root, text) === true) {
      trace(origin + ' -> composer consumed ' + text.length + ' chars');
      return;
    }
    var inserted = insertDirectly(root, text);
    if (inserted) trace(origin + ' -> insertText fallback ' + text.length + ' chars');
    else report(origin + ' -> BOTH PATHS FAILED (' + text.length + ' chars lost)');
  }

  /**
   * The payload did not travel on the event. The paste gesture still counts as
   * user activation, so the async clipboard API is the only remaining source.
   */
  function insertFromClipboard(root, origin) {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      report(origin + ' -> opaque payload, clipboard API unavailable');
      return;
    }
    var pending;
    try {
      pending = navigator.clipboard.readText();
    } catch (err) {
      report(origin + ' -> clipboard read threw');
      return;
    }
    Promise.resolve(pending).then(
      function (clip) {
        if (typeof clip === 'string' && clip !== '') insert(root, clip, origin + ' clipboard=' + clip.length);
        else report(origin + ' -> clipboard empty');
      },
      function (err) {
        report(origin + ' -> clipboard denied [' + ((err && err.name) || 'error') + ']');
      },
    );
  }

  document.addEventListener(
    'beforeinput',
    function (event) {
      if (PASTE_INPUT_TYPES[event.inputType] !== true) return;
      var root = composerRoot(event);
      if (root === null) return;
      // Take the event before Lexical sees it: its branch would cancel the
      // default action and then hand the payload-less InputEvent to a handler
      // that cannot read it.
      event.preventDefault();
      event.stopImmediatePropagation();
      var origin = 'beforeinput/' + event.inputType;
      var text = textFrom(event.dataTransfer) || textFrom(event.clipboardData);
      if (text === '' && typeof event.data === 'string') text = event.data;
      if (text === '') insertFromClipboard(root, origin + ' payload=0');
      else insert(root, text, origin + ' payload=' + text.length);
    },
    true,
  );

  document.addEventListener(
    'paste',
    function (event) {
      var root = composerRoot(event);
      if (root === null) return;
      // The normal event: the composer reads it itself, so only watch it.
      if (textFrom(event.clipboardData) !== '') {
        trace('paste -> left to the composer');
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      insertFromClipboard(root, 'paste payload=0');
    },
    true,
  );
})();
