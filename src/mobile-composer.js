/*
 * Mobile composer fixes, injected inline into index.html by src/host/index.js.
 * Nothing here patches @deepseek-ai/dsh-client-ui-conversation.
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
 *    event carries no payload at all. Confirmed working on the device via the
 *    long-press Paste menu item.
 *
 * 3. Paste that never announces itself as one. The Android
 *    clipboard overlay and the keyboard's quick-paste chip do deliver a payload:
 *    a plain textarea in the probe took the same 1515 characters the composer
 *    refused, so nothing is lost in the OS or the browser. Three shapes are
 *    handled, and the chip uses the quietest one: the whole block arrives as a
 *    single insertText - 131 characters in one event on the device, with no paste
 *    event and no clipboardData at all - so anything longer than a keystroke, an
 *    autocorrect word or a composition commit is replayed as a paste instead of
 *    being left to the per-keystroke command. That commit can also arrive with no
 *    editable under it at all, because the panel holds focus while it is open: the
 *    device shows focusout/focusin around the block and then +505 in DIV ed=505
 *    followed by ed=0, so a block that missed every editable goes to the editor
 *    last typed in. A paste carrying text/html beside
 *    plain text, since markup pastes are the ones reported to vanish; the bundle
 *    shows the copy path installs both types itself (client.js:12113), so what
 *    actually separates the two gestures is still open, and the probe's `types=`
 *    field is what will name it. A paste that lands on no editable at
 *    all, which is what an overlay tap looks like from inside the page because
 *    the editor has lost focus, is put back into the editor last typed in.
 *
 *    This is not special to this composer: the keyboard's clipboard panel
 *    inserting without a paste event is facebook/lexical#7251 (open since
 *    Feb 2025; the text is folded into one paragraph or arrives cut short),
 *    ProseMirror/prosemirror#1524 (only the line break arrives) and
 *    ueberdosis/tiptap#5911 (paste rules skipped), and a 2021 Stack Overflow
 *    report with the workaround we use - read the payload off the input event
 *    instead of waiting for a paste.
 *
 *    Select all is the other report that leaves no fingerprint: it is a native
 *    command, so it dispatches no input event and the selection is the only
 *    witness. While a window is open the panel records `sel <n> chars lex=<0|1>`
 *    once the selection settles, which separates "the browser selected nothing"
 *    from "it selected the text and whatever came next failed". Lexical has a
 *    matching bug of its own - facebook/lexical#9250, fixed upstream in #9251 -
 *    where the next nonempty insertText after a handled select-all is suppressed
 *    on every platform, which is exactly what a clipboard-panel commit looks
 *    like to the editor.
 *
 *    The probe stays for what the trace has not explained yet: tapping `probe`
 *    clears the log, arms a 25s capture window and shows the panel, and for that
 *    window it records EVERY beforeinput, input, key and focus event plus every
 *    DOM mutation on the page, with the closing line stating how many lines were
 *    captured. A paste the page cannot see reports zero, which is itself the
 *    finding. `field` opens a plain textarea and a plain contenteditable, so a
 *    paste can be compared on a non-Lexical editable.
 *
 * The probe UI and the diagnostic panel are temporary: remove them once case 3
 * is closed. Every listener is capture-phase and gated to coarse pointers, so
 * desktop behaviour is unchanged; window.__DSH_FORCE_MOBILE_COMPOSER__ forces
 * them on.
 */
(function () {
  'use strict';

  var FORCED = window.__DSH_FORCE_MOBILE_COMPOSER__ === true;
  var COARSE =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  if (!COARSE && !FORCED) return;

  var EDITOR_SELECTOR = '[data-lexical-editor="true"]';
  var PANEL_ATTR = 'data-dsh-pwa-diagnostic';
  var PROBE_ATTR = 'data-dsh-pwa-probe';
  var IGNORE_SELECTOR = '[' + PANEL_ATTR + '],[' + PROBE_ATTR + ']';
  var PASTE_INPUT_TYPES = { insertFromPaste: true, insertFromPasteAsQuotation: true };
  // Types a closed IME path can produce. insertText/insertCompositionText are
  // omitted on purpose: they fire once per keystroke, so tracing them on the
  // panel made ordinary typing look like the paste being tested. A large
  // insertText is not watched but claimed - see TYPED_CHUNK_MAX.
  var WATCHED_INPUT_TYPES = {
    insertFromComposition: true,
    insertFromDrop: true,
    insertFromYank: true,
    insertReplacementText: true,
    insertTranspose: true,
  };
  var ARMED_MS = 25000;
  var PANEL_LINES = 8;
  // Printed on the ARMED line, so a screenshot of the panel names the build that
  // produced it instead of costing a round trip to find out.
  var BUILD = '1.1.4';
  // How long an insertion is given before it is measured. Long enough for a paste
  // to be handled and rendered, short enough that a retry stays invisible.
  var VERIFY_MS = 250;
  // The chip commits a pasted block as one insertText. A keystroke, an
  // autocorrect word and a predictive-text sentence all arrive the same way, so
  // the threshold sits above anything a keyboard sends in one event and far
  // below the smallest block seen on the device (131 characters).
  var TYPED_CHUNK_MAX = 16;

  var traced = [];
  var panel = null;
  // Depth of our own replayed insertions. The beforeinput execCommand generates is
  // the same shape as the block this code claims, so without this the retry would
  // be claimed again and replayed again.
  var replaying = 0;
  var panelTimer = null;
  var vanishTimer = null;
  var armedUntil = 0;
  var armedLines = 0;
  var probeButton = null;
  var fieldButton = null;
  var fieldBox = null;
  // The editor a paste last landed in, so a paste that arrives with no editable
  // under the event at all can still be put where the user was typing.
  var lastEditor = null;

  function isArmed() {
    return armedUntil !== 0 && Date.now() < armedUntil;
  }

  function domLen(root) {
    try {
      return (root.textContent || '').length;
    } catch (err) {
      return -1;
    }
  }

  function editorCount() {
    if (typeof document.querySelectorAll !== 'function') return -1;
    try {
      return document.querySelectorAll(EDITOR_SELECTOR).length;
    } catch (err) {
      return -1;
    }
  }

  /** Text length across every Lexical editor on the page, not just the focused one. */
  function editorsLen() {
    if (typeof document.querySelectorAll !== 'function') return -1;
    try {
      var list = document.querySelectorAll(EDITOR_SELECTOR);
      var total = 0;
      for (var i = 0; i < list.length; i++) total += (list[i].textContent || '').length;
      return total;
    } catch (err) {
      return -1;
    }
  }

  function trace(line) {
    traced.push(line);
    if (traced.length > PANEL_LINES) traced.shift();
    if (isArmed()) armedLines++;
    try {
      console.log('[DSH PWA] ' + line);
    } catch (err) {}
  }

  function showPanel() {
    if (typeof document.createElement !== 'function' || document.body === null) return;
    if (panel === null) {
      panel = document.createElement('pre');
      panel.setAttribute(PANEL_ATTR, '');
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
    panelTimer = setTimeout(
      function () {
        // Never hide the panel while a capture window is open: the user may
        // still be mid-gesture.
        if (isArmed()) {
          showPanel();
          return;
        }
        if (panel !== null) panel.style.display = 'none';
      },
      isArmed() ? 12000 : 30000,
    );
  }

  /** Trace a line and surface the panel: only used for events worth reading. */
  function observe(line) {
    trace(line);
    showPanel();
  }

  function traceQuietly(line) {
    trace(line);
  }

  function ignoredNode(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || typeof el.closest !== 'function') return false;
    try {
      return el.closest(IGNORE_SELECTOR) !== null;
    } catch (err) {
      return false;
    }
  }

  function arm() {
    traced.length = 0;
    armedLines = 0;
    armedUntil = Date.now() + ARMED_MS;
    trace(
      'ARMED ' + ARMED_MS / 1000 + 's build=' + BUILD + ' - do the paste now (editors=' +
        editorCount() + ' len=' + editorsLen() + ')',
    );
    showPanel();
    setTimeout(function () {
      armedUntil = 0;
      trace('window closed: ' + armedLines + ' line(s) captured');
      showPanel();
    }, ARMED_MS + 200);
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

  function fileCount(source) {
    if (source === null || source === undefined) return 0;
    try {
      return source.files ? source.files.length : 0;
    } catch (err) {
      return 0;
    }
  }

  function tagOf(node) {
    return (node && node.tagName) || '?';
  }

  function focusTag() {
    var active = document.activeElement;
    return tagOf(active === undefined || active === null ? null : active);
  }

  /**
   * What the clipboard is actually carrying. The device reports that text copied
   * with the composer's copy button can be pasted while the same text copied by
   * dragging a selection cannot, so the shape is the thing to record.
   */
  function describe(source) {
    if (source === null || source === undefined) return 'types=none';
    var types = '-';
    try {
      if (source.types) types = Array.prototype.slice.call(source.types).join('+') || '-';
    } catch (err) {
      types = '?';
    }
    var html = 0;
    try {
      html = source.getData ? (source.getData('text/html') || '').length : 0;
    } catch (err) {
      html = -1;
    }
    return 'types=' + types + ' plain=' + textFrom(source).length + ' html=' + html + ' files=' + fileCount(source);
  }

  function hasHtml(source) {
    if (source === null || source === undefined || !source.types) return false;
    try {
      return Array.prototype.indexOf.call(source.types, 'text/html') !== -1;
    } catch (err) {
      return false;
    }
  }

  /** A paste aimed at a real editable is none of our business. */
  function isEditableTarget(target) {
    if (!target || typeof target.tagName !== 'string') return false;
    var tag = target.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
    if (target.isContentEditable === true) return true;
    if (typeof target.closest !== 'function') return false;
    try {
      return target.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]') !== null;
    } catch (err) {
      return false;
    }
  }

  /** The editor a stray paste belongs in. */
  function liveEditor() {
    if (lastEditor !== null && lastEditor.isConnected !== false && lastEditor.offsetParent !== null) return lastEditor;
    if (typeof document.querySelectorAll !== 'function') return null;
    var list;
    try {
      list = document.querySelectorAll(EDITOR_SELECTOR);
    } catch (err) {
      return null;
    }
    for (var i = 0; i < list.length; i++) {
      if (list[i].offsetParent !== null) return list[i];
    }
    return null;
  }

  /**
   * A paste with no editable under the event has no caret to insert into, which
   * is what makes the clipboard overlay look like it does nothing. Put the text
   * into the editor the user was last typing in, but only when the event missed
   * every editable: an input in a dialog owns its own paste.
   */
  function repairStrayPaste(event, shape) {
    if (isEditableTarget(event.target)) return;
    var text = textFrom(event.clipboardData);
    if (text === '') return;
    var root = liveEditor();
    if (root === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    insert(root, text, 'recovered stray paste ' + shape);
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
      replaying++;
      try {
        return document.execCommand('insertText', false, text) === true;
      } finally {
        replaying--;
      }
    } catch (err) {
      return false;
    }
  }

  /**
   * One word of the block that has to be in the editor for the insertion to count
   * as landed. Split on whitespace because Lexical renders a pasted block as
   * several blocks, and long enough that a coincidence cannot pass for a paste.
   */
  function probeSlice(text) {
    var words = String(text).split(/\s+/);
    var i;
    for (i = 0; i < words.length; i++) {
      if (words[i].length >= 4) return words[i].slice(0, 24);
    }
    return String(text).trim().slice(0, 24);
  }

  function landed(root, text) {
    var slice = probeSlice(text);
    try {
      if (slice === '') return domLen(root) > 0;
      return String(root.textContent || '').indexOf(slice) !== -1;
    } catch (err) {
      return false;
    }
  }

  /**
   * The composer answering preventDefault is its verdict, not proof. An editor that
   * is mid-reconciliation drops the text anyway, and so does an insertText that
   * follows a handled selection command: client.js:212554 opens that window (`Vn`,
   * on a selection command such as Select all) and its beforeinput handler prevents
   * the next non-empty insertText and collapses the selection into a caret. Both end
   * at ed=0 after the text was already in the DOM - the shape the device kept
   * reporting (ed=505, then ed=0). So the text is measured, and one that did not
   * stick is re-sent as a real insertText a macrotask later, past that window, where
   * the editor's own beforeinput handler takes it.
   */
  function settleInsert(root, text, origin, before, retried) {
    setTimeout(function () {
      if (landed(root, text)) {
        trace('   held at ' + domLen(root) + ' chars');
        showPanel();
        return;
      }
      if (retried) {
        observe(origin + ' -> BOTH PATHS FAILED (' + text.length + ' chars lost, dom ' + before + ' -> ' + domLen(root) + ')');
        return;
      }
      observe(origin + ' -> ' + text.length + ' chars did not stick, re-sending as insertText');
      if (!insertDirectly(root, text)) {
        observe(origin + ' -> insertText refused (dom ' + domLen(root) + ')');
        return;
      }
      settleInsert(root, text, origin, before, true);
    }, VERIFY_MS);
  }

  function insert(root, text, origin) {
    var before = domLen(root);
    var consumed = replayAsPaste(root, text) === true;
    observe(origin + ' -> ' + (consumed ? 'composer consumed ' : 'replayed, not consumed ') + text.length + ' chars');
    settleInsert(root, text, origin, before, false);
  }

  /**
   * The payload did not travel on the event. The paste gesture still counts as
   * user activation, so the async clipboard API is the only remaining source:
   * text first, then an image, which the composer does accept when it is handed
   * one as a file (client.js:16720-16729 collects clipboardData.items of kind
   * file and calls intakeFiles).
   */
  function insertFromClipboard(root, origin) {
    var api = navigator.clipboard;
    if (api === undefined || api === null) {
      observe(origin + ' -> opaque payload, clipboard API unavailable');
      return;
    }
    if (typeof api.readText !== 'function') {
      readImageFromClipboard(root, origin);
      return;
    }
    var pending;
    try {
      pending = api.readText();
    } catch (err) {
      observe(origin + ' -> clipboard read threw');
      return;
    }
    Promise.resolve(pending).then(
      function (clip) {
        if (typeof clip === 'string' && clip !== '') insert(root, clip, origin + ' clipboard=' + clip.length);
        else readImageFromClipboard(root, origin);
      },
      function (err) {
        observe(origin + ' -> clipboard denied [' + ((err && err.name) || 'error') + ']');
      },
    );
  }

  /** Hand the composer one image the only way it accepts one: as a paste file. */
  function replayFileAsPaste(root, file, origin) {
    var transfer;
    try {
      transfer = new DataTransfer();
      transfer.items.add(file);
      if (transfer.files.length !== 1) {
        observe(origin + ' -> DataTransfer refused the file');
        return;
      }
    } catch (err) {
      observe(origin + ' -> DataTransfer threw');
      return;
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
      observe(origin + ' -> ClipboardEvent threw');
      return;
    }
    try {
      root.dispatchEvent(event);
    } catch (err) {
      observe(origin + ' -> dispatch threw');
      return;
    }
    observe(origin + ' -> image replayed, consumed=' + (event.defaultPrevented === true ? 1 : 0));
  }

  /**
   * Android never puts an image on clipboardData, so an image pasted by
   * long-press arrives as an empty text payload. clipboard.read() is the one
   * route that can still see it.
   */
  function readImageFromClipboard(root, origin) {
    var api = navigator.clipboard;
    if (api === undefined || api === null || typeof api.read !== 'function') {
      observe(origin + ' -> clipboard empty (no image reader)');
      return;
    }
    var pending;
    try {
      pending = api.read();
    } catch (err) {
      observe(origin + ' -> clipboard image read threw');
      return;
    }
    Promise.resolve(pending).then(
      function (items) {
        var list = items || [];
        for (var i = 0; i < list.length; i++) {
          var types = (list[i] && list[i].types) || [];
          for (var j = 0; j < types.length; j++) {
            if (String(types[j]).indexOf('image/') === 0) {
              takeImageItem(root, list[i], String(types[j]), origin);
              return;
            }
          }
        }
        observe(origin + ' -> clipboard empty (no image)');
      },
      function (err) {
        observe(origin + ' -> clipboard image denied [' + ((err && err.name) || 'error') + ']');
      },
    );
  }

  function takeImageItem(root, item, type, origin) {
    var pending;
    try {
      pending = item.getType(type);
    } catch (err) {
      observe(origin + ' -> clipboard image getType threw');
      return;
    }
    Promise.resolve(pending).then(
      function (blob) {
        var subtype = type.indexOf('/') === -1 ? 'png' : type.slice(type.indexOf('/') + 1);
        var ext = subtype.replace(/[^a-z0-9]/gi, '') || 'png';
        var file;
        try {
          file = new File([blob], 'pasted.' + ext, { type: type });
        } catch (err) {
          observe(origin + ' -> cannot build a File');
          return;
        }
        replayFileAsPaste(root, file, origin + ' image/' + ext);
      },
      function (err) {
        observe(origin + ' -> clipboard image blob failed');
      },
    );
  }

  document.addEventListener(
    'beforeinput',
    function (event) {
      var root = composerRoot(event);
      var type = event.inputType;

      if (PASTE_INPUT_TYPES[type] === true) {
        var shape = describe(event.dataTransfer || event.clipboardData);
        if (root === null) {
          if (isArmed()) observe('bi ' + String(type) + ' OUTSIDE the composer @' + tagOf(event.target) + ' ' + shape);
          return;
        }
        // Take the event before Lexical sees it: its branch would cancel the
        // default action and then hand the payload-less InputEvent to a handler
        // that cannot read it.
        event.preventDefault();
        event.stopImmediatePropagation();
        lastEditor = root;
        var origin = 'beforeinput/' + type + ' ' + shape;
        var text = textFrom(event.dataTransfer) || textFrom(event.clipboardData);
        if (text === '' && typeof event.data === 'string') text = event.data;
        if (text === '') insertFromClipboard(root, origin + ' payload=0');
        else insert(root, text, origin + ' payload=' + text.length);
        return;
      }

      var data = typeof event.data === 'string' ? event.data : '';

      // The clipboard overlay and the keyboard's quick-paste chip never produce a
      // paste event: the whole block arrives as ONE insertText, which Lexical
      // reads as a keystroke and hands to its per-keystroke insertion command - a
      // 131 character block is not a keystroke. A real keystroke, an autocorrect
      // word or a composition commit is a handful of characters, so anything
      // longer came off the clipboard and goes down the path the long-press paste
      // already proved on the device.
      // `replaying` excludes our own retry: its beforeinput carries the same block
      // and would otherwise be claimed a second time.
      if (type === 'insertText' && event.isComposing !== true && replaying === 0 && data.length > TYPED_CHUNK_MAX) {
        if (root !== null) {
          event.preventDefault();
          event.stopImmediatePropagation();
          lastEditor = root;
          insert(root, data, 'bulk insertText ' + data.length + ' chars');
          return;
        }
        // The keyboard's clipboard panel holds focus while it is open, so the
        // commit can arrive with no editable under it at all, and then the block
        // goes nowhere. Put it where the user was typing, but only when the event
        // missed every editable: a field in a dialog owns its own commit.
        if (!isEditableTarget(event.target)) {
          var stray = liveEditor();
          if (stray !== null) {
            event.preventDefault();
            event.stopImmediatePropagation();
            insert(stray, data, 'bulk insertText recovered ' + data.length + ' chars');
            return;
          }
        }
      }
      if (!isArmed()) {
        // Outside a capture window only unexpected shapes are worth a console
        // line, and they never raise the panel: that was what made typing look
        // like the failing paste.
        if (root === null) return;
        if (WATCHED_INPUT_TYPES[type] === true || data.length > 1) {
          traceQuietly(
            'bi ' + type + ' len=' + data.length + ' comp=' + (event.isComposing === true ? 1 : 0) +
              ' dt=' + (event.dataTransfer ? 1 : 0) + ' cd=' + (event.clipboardData ? 1 : 0),
          );
        }
        return;
      }
      event.__dshWatched = true;
      observe(
        'bi ' + String(type) + ' ' + (root === null ? 'other' : 'composer') + ' @' + tagOf(event.target) +
          ' len=' + data.length + ' comp=' + (event.isComposing === true ? 1 : 0) +
          ' dt=' + (event.dataTransfer ? 1 : 0) + ' cd=' + (event.clipboardData ? 1 : 0) +
          ' dom=' + (root === null ? -1 : domLen(root)) + ' ed=' + editorsLen(),
      );
    },
    true,
  );

  /*
   * Same event, bubble phase, on document: Lexical listens on the root element,
   * so by the time this runs it has had its say. preventDefault here means
   * Lexical took the text over and will insert it itself; a cancelled event with
   * no change to the editor is the signature of the silent drop.
   */
  document.addEventListener(
    'beforeinput',
    function (event) {
      if (event.__dshWatched !== true || !isArmed()) return;
      trace('   after: prevented=' + (event.defaultPrevented === true ? 1 : 0) + ' ed=' + editorsLen());
      showPanel();
    },
    false,
  );

  document.addEventListener(
    'paste',
    function (event) {
      var shape = describe(event.clipboardData);
      var text = textFrom(event.clipboardData);
      var files = fileCount(event.clipboardData);
      var root = composerRoot(event);

      if (root === null) {
        // The path that used to be invisible here: the editor is not under the
        // event at all, so the composer never runs and nothing happens.
        observe('paste OUTSIDE the composer @' + tagOf(event.target) + ' focus=' + focusTag() + ' ' + shape);
        repairStrayPaste(event, shape);
        return;
      }

      lastEditor = root;
      if (files > 0) {
        observe('paste ok ' + shape);
        return;
      }
      if (text !== '') {
        // A dragged selection carries text/html beside text/plain, and only that
        // differs between the paste that lands and the paste that vanishes. Send
        // the text alone down the path already proven on the device.
        if (hasHtml(event.clipboardData)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          insert(root, text, 'rich paste normalised ' + shape);
          return;
        }
        observe('paste ok ' + shape);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      insertFromClipboard(root, 'paste payload=0');
    },
    true,
  );

  // Whether the text survived into the editor's DOM, which separates "the event
  // was never delivered" from "it was delivered and then rejected".
  document.addEventListener(
    'input',
    function (event) {
      if (PASTE_INPUT_TYPES[event.inputType] === true) return;
      var root = composerRoot(event);
      var data = typeof event.data === 'string' ? event.data : '';
      if (!isArmed()) {
        if (root === null || (event.__dshWatched !== true && data.length < 2)) return;
        traceQuietly('in ' + event.inputType + ' len=' + data.length);
        return;
      }
      var after = root === null ? -1 : domLen(root);
      observe(
        'in ' + String(event.inputType) + ' ' + (root === null ? 'other' : 'composer') + ' @' + tagOf(event.target) +
          ' len=' + data.length + ' dom=' + after + ' ed=' + editorsLen(),
      );
      if (vanishTimer !== null) clearTimeout(vanishTimer);
      vanishTimer = setTimeout(function () {
        var later = editorsLen();
        if (later < after) observe('   ed ' + after + ' -> ' + later + ' EDITOR DROPPED IT');
        else trace('   ed held at ' + later);
      }, 700);
    },
    true,
  );

  function onFocus(event) {
    if (!isArmed()) return;
    var target = event.target;
    var lex =
      target && typeof target.closest === 'function' && target.closest(EDITOR_SELECTOR) !== null ? 1 : 0;
    observe(event.type + ' ' + ((target && target.tagName) || '?') + ' lex=' + lex);
  }

  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onFocus, true);

  var selectionTimer = null;

  function reportSelection() {
    selectionTimer = null;
    if (!isArmed()) return;
    var selection = null;
    try {
      selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
    } catch (err) {
      selection = null;
    }
    if (selection === null || selection === undefined) {
      observe('sel no selection object');
      return;
    }
    var text = '';
    try {
      text = String(selection.toString() || '');
    } catch (err) {
      text = '';
    }
    var anchor = selection.anchorNode;
    var node = anchor && anchor.nodeType === 3 ? anchor.parentElement : anchor;
    var lex = node && typeof node.closest === 'function' && node.closest(EDITOR_SELECTOR) !== null ? 1 : 0;
    observe('sel ' + text.length + ' chars lex=' + lex + ' @' + tagOf(node) + ' ed=' + editorsLen());
  }

  /**
   * Select all is a native command: it dispatches no input event at all, so the
   * only witness is the selection itself. The length Android reports separates
   * "the browser selected nothing" from "it selected the text and whatever the
   * user did next failed". Debounced, so dragging a selection is one line.
   */
  document.addEventListener(
    'selectionchange',
    function () {
      if (!isArmed()) return;
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(reportSelection, 250);
    },
    true,
  );

  document.addEventListener(
    'keydown',
    function (event) {
      if (!isArmed()) return;
      trace('key ' + event.key);
      showPanel();
    },
    true,
  );

  document.addEventListener(
    'compositionstart',
    function () {
      if (isArmed()) observe('compositionstart');
    },
    true,
  );

  document.addEventListener(
    'compositionend',
    function () {
      if (isArmed()) observe('compositionend');
    },
    true,
  );

  var observer = null;

  /**
   * Events can be missed; the effect cannot. While a window is open, record
   * every DOM change on the page so text that arrives without an input event
   * still shows up, wherever it landed.
   */
  function startObserver() {
    if (observer !== null) return;
    if (typeof MutationObserver !== 'function' || document.body === null) return;
    try {
      observer = new MutationObserver(function (records) {
        if (!isArmed()) return;
        var lines = 0;
        for (var i = 0; i < records.length && lines < 3; i++) {
          var record = records[i];
          if (ignoredNode(record.target)) continue;
          var added = 0;
          if (record.type === 'characterData') {
            added = String(record.target.data || '').length;
          } else {
            var nodes = record.addedNodes || [];
            for (var j = 0; j < nodes.length; j++) added += String(nodes[j].textContent || '').length;
          }
          var el = record.target && record.target.nodeType === 3 ? record.target.parentElement : record.target;
          trace('mut ' + record.type + ' +' + added + ' in ' + ((el && el.tagName) || '?') + ' ed=' + editorsLen());
          lines++;
        }
        if (lines > 0) showPanel();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (err) {
      observer = null;
    }
  }

  function probeStyle(extra) {
    return [
      'position:fixed',
      'z-index:2147483647',
      'padding:3px 6px',
      'border:1px solid #475569',
      'border-radius:4px',
      'background:rgba(15,23,42,0.85)',
      'color:#cbd5e1',
      'font:10px/1.2 ui-monospace,monospace',
      'opacity:0.55',
      'pointer-events:auto',
    ]
      .concat(extra || [])
      .join(';');
  }

  /** Tap-to-arm control. Deliberately does not take focus from the composer. */
  function installProbe() {
    if (typeof document.createElement !== 'function' || document.body === null) return false;
    if (probeButton !== null) return true;
    probeButton = document.createElement('button');
    probeButton.setAttribute(PROBE_ATTR, 'arm');
    probeButton.type = 'button';
    probeButton.textContent = 'probe';
    probeButton.style.cssText = probeStyle(['left:6px', 'top:42vh']);
    probeButton.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    probeButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      arm();
    });
    document.body.appendChild(probeButton);

    fieldButton = document.createElement('button');
    fieldButton.setAttribute(PROBE_ATTR, 'field');
    fieldButton.type = 'button';
    fieldButton.textContent = 'field';
    fieldButton.style.cssText = probeStyle(['left:6px', 'top:48vh']);
    fieldButton.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    fieldButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleField();
    });
    document.body.appendChild(fieldButton);
    return true;
  }

  /**
   * A plain, non-Lexical editable sitting over the page. If the same paste
   * arrives here but not in the composer, the browser did deliver it and the
   * loss is in Lexical or the composer; if it arrives nowhere, the gesture never
   * reached the page at all.
   */
  function toggleField() {
    if (fieldBox !== null) {
      fieldBox.style.display = fieldBox.style.display === 'none' ? 'block' : 'none';
      return;
    }
    var box = document.createElement('div');
    box.setAttribute(PROBE_ATTR, 'fieldbox');
    box.style.cssText = [
      'position:fixed',
      'left:8px',
      'right:8px',
      'top:32vh',
      'z-index:2147483647',
      'padding:6px',
      'border:1px solid #475569',
      'border-radius:6px',
      'background:rgba(15,23,42,0.96)',
      'pointer-events:auto',
    ].join(';');
    var hint = document.createElement('div');
    hint.textContent = 'plain field - tap it, then try the same paste';
    hint.style.cssText = 'color:#94a3b8;font:10px/1.3 ui-monospace,monospace;margin-bottom:4px';
    var field = document.createElement('textarea');
    field.setAttribute(PROBE_ATTR, 'text');
    field.rows = 3;
    field.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'background:#020617',
      'color:#e2e8f0',
      'border:1px solid #334155',
      'border-radius:4px',
      'font:12px/1.3 ui-monospace,monospace',
    ].join(';');
    field.addEventListener('input', function () {
      observe('plain field got ' + field.value.length + ' chars');
    });
    var richHint = document.createElement('div');
    richHint.textContent = 'rich field (contenteditable, no Lexical) - tap it, then paste';
    richHint.style.cssText = 'color:#94a3b8;font:10px/1.3 ui-monospace,monospace;margin:6px 0 4px';
    var rich = document.createElement('div');
    rich.setAttribute(PROBE_ATTR, 'rich');
    rich.contentEditable = 'true';
    rich.style.cssText = [
      'box-sizing:border-box',
      'min-height:34px',
      'padding:3px 4px',
      'background:#020617',
      'color:#e2e8f0',
      'border:1px solid #334155',
      'border-radius:4px',
      'font:12px/1.3 ui-monospace,monospace',
    ].join(';');
    rich.addEventListener('input', function () {
      observe('rich field got ' + String(rich.textContent || '').length + ' chars');
    });
    box.appendChild(hint);
    box.appendChild(field);
    box.appendChild(richHint);
    box.appendChild(rich);
    document.body.appendChild(box);
    fieldBox = box;
  }

  startObserver();
  if (!installProbe() && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', function () {
      installProbe();
      startObserver();
    });
  }
})();
