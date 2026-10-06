/*
 * Mobile composer fixes, injected inline into index.html by src/host/index.js.
 *
 * Android-only defects in the shipped composer, plus a probe for the one that
 * is still open. Nothing here patches @deepseek-ai/dsh-client-ui-conversation.
 *
 * 1. No newline. The composer binds plain Enter to send and leaves only
 *    Shift+Enter to Lexical for a line break (client.js:16706 defers when
 *    event.shiftKey is true). A soft keyboard has no Shift, so a phone can
 *    never type a line break. We translate a plain Enter into the Shift+Enter
 *    keydown Lexical already understands, and the synthetic event cannot
 *    recurse because it carries shiftKey.
 *
 * 2. Paste reaching the page as beforeinput/insertFromPaste. Chrome delivers
 *    that with the payload on the InputEvent's dataTransfer. Lexical's
 *    beforeinput switch preventDefaults every input type before dispatching
 *    (client.js:5501) and hands PASTE_COMMAND that InputEvent (client.js:5521),
 *    but the composer's PASTE handler reads event.clipboardData only
 *    (client.js:16718) and returns false when there is none - so the text is
 *    dropped after the native insertion was already cancelled. We take the
 *    event over and re-dispatch a real paste ClipboardEvent, which that handler
 *    reads, falling back to document.execCommand('insertText') when the
 *    synthetic event is rejected and to navigator.clipboard.readText() when the
 *    event carries no payload at all.
 *
 * 3. OPEN: text committed through the IME (the Android clipboard overlay, the
 *    Gboard quick-paste chip) still does not arrive. Those paths never dispatch
 *    a paste event, so they are not the same mechanism. The watcher below
 *    records what they DO produce - inputType, payload length, composition
 *    flag, whether the payload rode on dataTransfer/clipboardData, and the
 *    editor's text length before, during and after - including whether
 *    Lexical cancelled the event (observed from a bubble-phase listener, which
 *    runs after its root-level handler). It is a probe, not a fix: it exists to
 *    name the branch that drops the text.
 *
 * Every listener is capture-phase and gated to coarse pointers, so desktop
 * behaviour is unchanged. window.__DSH_FORCE_MOBILE_COMPOSER__ forces them on.
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
  // Types the closed IME paths can produce. insertText/insertCompositionText are
  // omitted on purpose: they fire once per keystroke, so they are traced only
  // when they arrive with more than one character, which is what a clipboard
  // commit looks like and a single key press never does.
  var WATCHED_INPUT_TYPES = {
    insertFromComposition: true,
    insertFromDrop: true,
    insertFromYank: true,
    insertReplacementText: true,
    insertTranspose: true,
  };

  var traced = [];
  var panel = null;
  var panelTimer = null;
  var vanishTimer = null;

  function domLen(root) {
    try {
      return (root.textContent || '').length;
    } catch (err) {
      return -1;
    }
  }

  function trace(line) {
    traced.push(line);
    if (traced.length > 6) traced.shift();
    try {
      console.log('[DSH PWA] ' + line);
    } catch (err) {}
  }

  function showPanel() {
    if (typeof document.createElement !== 'function' || document.body === null) return;
    if (panel === null) {
      panel = document.createElement('pre');
      panel.setAttribute('data-dsh-pwa-diagnostic', '');
      panel.style.cssText = [
        'position:fixed',
        'left:0',
        'right:0',
        'top:0',
        'z-index:2147483647',
        'margin:0',
        'padding:6px 8px',
        'max-height:22vh',
        'overflow:hidden',
        'background:rgba(15,23,42,0.96)',
        'color:#e2e8f0',
        'font:10px/1.35 ui-monospace,monospace',
        'white-space:pre-wrap',
        'word-break:break-word',
        'pointer-events:none',
        'border-bottom:1px solid #334155',
      ].join(';');
      document.body.appendChild(panel);
    }
    panel.textContent = traced.join('\n');
    panel.style.display = 'block';
    if (panelTimer !== null) clearTimeout(panelTimer);
    panelTimer = setTimeout(function () {
      if (panel !== null) panel.style.display = 'none';
    }, 12000);
  }

  /** Trace a line and surface the panel: only used for events worth reading. */
  function observe(line) {
    trace(line);
    showPanel();
  }

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
    var before = domLen(root);
    if (replayAsPaste(root, text) === true) {
      trace(origin + ' -> composer consumed ' + text.length + ' chars');
      return;
    }
    var inserted = insertDirectly(root, text);
    var after = domLen(root);
    if (inserted) trace(origin + ' -> insertText fallback ' + text.length + ' chars (dom ' + before + '->' + after + ')');
    else observe(origin + ' -> BOTH PATHS FAILED (' + text.length + ' chars lost, dom ' + before + ')');
  }

  /**
   * The payload did not travel on the event. The paste gesture still counts as
   * user activation, so the async clipboard API is the only remaining source.
   */
  function insertFromClipboard(root, origin) {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      observe(origin + ' -> opaque payload, clipboard API unavailable');
      return;
    }
    var pending;
    try {
      pending = navigator.clipboard.readText();
    } catch (err) {
      observe(origin + ' -> clipboard read threw');
      return;
    }
    Promise.resolve(pending).then(
      function (clip) {
        if (typeof clip === 'string' && clip !== '') insert(root, clip, origin + ' clipboard=' + clip.length);
        else observe(origin + ' -> clipboard empty');
      },
      function (err) {
        observe(origin + ' -> clipboard denied [' + ((err && err.name) || 'error') + ']');
      },
    );
  }

  document.addEventListener(
    'beforeinput',
    function (event) {
      var root = composerRoot(event);
      if (root === null) return;
      var type = event.inputType;

      if (PASTE_INPUT_TYPES[type] === true) {
        // Take the event before Lexical sees it: its branch would cancel the
        // default action and then hand the payload-less InputEvent to a handler
        // that cannot read it.
        event.preventDefault();
        event.stopImmediatePropagation();
        var origin = 'beforeinput/' + type;
        var text = textFrom(event.dataTransfer) || textFrom(event.clipboardData);
        if (text === '' && typeof event.data === 'string') text = event.data;
        if (text === '') insertFromClipboard(root, origin + ' payload=0');
        else insert(root, text, origin + ' payload=' + text.length);
        return;
      }

      var data = typeof event.data === 'string' ? event.data : '';
      var notable = WATCHED_INPUT_TYPES[type] === true || data.length > 1;
      if (!notable) return;
      event.__dshWatched = true;
      trace(
        'bi ' + type + ' len=' + data.length + ' comp=' + (event.isComposing === true ? 1 : 0) +
          ' dt=' + (event.dataTransfer ? 1 : 0) + ' cd=' + (event.clipboardData ? 1 : 0) +
          ' dom0=' + domLen(root),
      );
      showPanel();
    },
    true,
  );

  /*
   * Same event, bubble phase, on document: Lexical listens on the root element,
   * so by the time this runs it has had its say. preventDefault here means
   * Lexical took the text over and will insert it itself; a cancelled event with
   * no change to the editor is exactly the signature of the silent drop.
   */
  document.addEventListener(
    'beforeinput',
    function (event) {
      if (event.__dshWatched !== true) return;
      var root = composerRoot(event);
      if (root === null) return;
      trace('   after: prevented=' + (event.defaultPrevented === true ? 1 : 0) + ' dom=' + domLen(root));
    },
    false,
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

  // Whether the text survived the round trip into the editor's DOM, which is
  // what separates "the event was never delivered" from "it was delivered and
  // then rejected".
  document.addEventListener(
    'input',
    function (event) {
      if (PASTE_INPUT_TYPES[event.inputType] === true) return;
      var root = composerRoot(event);
      if (root === null) return;
      var data = typeof event.data === 'string' ? event.data : '';
      if (event.__dshWatched !== true && data.length < 2) return;
      var after = domLen(root);
      observe('in ' + event.inputType + ' len=' + data.length + ' dom=' + after);
      if (vanishTimer !== null) clearTimeout(vanishTimer);
      vanishTimer = setTimeout(function () {
        var later = domLen(root);
        if (later < after) observe('   dom ' + after + ' -> ' + later + ' EDITOR DROPPED IT');
        else trace('   dom held at ' + later);
      }, 700);
    },
    true,
  );
})();
