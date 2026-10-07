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
 *    long-press Paste menu item, and again from an Android keyboard's
 *    clipboard panel (1.1.4).
 *
 * 3. Paste that never announces itself as one. The Android clipboard overlay
 *    and the keyboard's quick-paste chip do deliver a payload: a plain textarea
 *    on the same page took the same 1515 characters the composer refused, so
 *    nothing is lost in the OS or the browser. The chip uses the quietest
 *    shape - the whole block arrives as a single insertText, 131 characters in
 *    one event on the device, with no paste event and no clipboardData at all -
 *    so anything longer than a keystroke, an autocorrect word or a composition
 *    commit is replayed as a paste instead of being left to the per-keystroke
 *    command. That commit can also arrive with no editable under it at all,
 *    because the keyboard's clipboard panel holds focus while it is open: a
 *    block that missed every editable goes to the editor last typed in, and a
 *    paste that lands on no editable at all - which is what an overlay tap
 *    looks like from inside the page - is put back into that editor too.
 *
 *    A paste carrying text/html beside plain text is normalised to its plain
 *    text, on the report that markup pastes are the ones that vanish.
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
 *    command, so it dispatches no input event. Lexical has a matching bug of
 *    its own - facebook/lexical#9250, fixed upstream in #9251 - where the next
 *    nonempty insertText after a handled select-all is suppressed on every
 *    platform, which is exactly what a clipboard-panel commit looks like to
 *    the editor.
 *
 *    Neither gesture can be trusted to have landed. The composer answering
 *    preventDefault is its verdict, not proof: an editor that is mid-
 *    reconciliation drops the text anyway, and so does an insertText that
 *    follows a handled selection command. So every insertion is measured
 *    against the editor's own text VERIFY_MS later and re-sent as a real
 *    insertText when it did not stick - see settleInsert.
 *
 * 1.1.5 removed the diagnostic probe buttons, the plain `field` comparison
 * editables and the trace panel the paste investigation used; they are in git
 * history if a paste regression ever needs them again. Every listener is
 * capture-phase and gated to coarse pointers, so desktop behaviour is
 * unchanged; window.__DSH_FORCE_MOBILE_COMPOSER__ forces them on.
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
  // How long an insertion is given before it is measured. Long enough for a paste
  // to be handled and rendered, short enough that a retry stays invisible.
  var VERIFY_MS = 250;
  // The chip commits a pasted block as one insertText. A keystroke, an
  // autocorrect word and a predictive-text sentence all arrive the same way, so
  // the threshold sits above anything a keyboard sends in one event and far
  // below the smallest block seen on the device (131 characters).
  var TYPED_CHUNK_MAX = 16;

  // Depth of our own replayed insertions. The beforeinput execCommand generates is
  // the same shape as the block this code claims, so without this the retry would
  // be claimed again and replayed again.
  var replaying = 0;
  // The editor a paste last landed in, so a paste that arrives with no editable
  // under the event at all can still be put where the user was typing.
  var lastEditor = null;


  function domLen(root) {
    try {
      return (root.textContent || '').length;
    } catch (err) {
      return -1;
    }
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
  function repairStrayPaste(event) {
    if (isEditableTarget(event.target)) return;
    var text = textFrom(event.clipboardData);
    if (text === '') return;
    var root = liveEditor();
    if (root === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    insert(root, text);
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
  function sampleSlice(text) {
    var words = String(text).split(/\s+/);
    var i;
    for (i = 0; i < words.length; i++) {
      if (words[i].length >= 4) return words[i].slice(0, 24);
    }
    return String(text).trim().slice(0, 24);
  }

  function landed(root, text) {
    var slice = sampleSlice(text);
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
  function settleInsert(root, text, retried) {
    setTimeout(function () {
      if (landed(root, text)) return;
      if (retried) return;
      if (!insertDirectly(root, text)) return;
      settleInsert(root, text, true);
    }, VERIFY_MS);
  }

  function insert(root, text) {
    replayAsPaste(root, text);
    settleInsert(root, text, false);
  }

  /**
   * The payload did not travel on the event. The paste gesture still counts as
   * user activation, so the async clipboard API is the only remaining source:
   * text first, then an image, which the composer does accept when it is handed
   * one as a file (client.js:16720-16729 collects clipboardData.items of kind
   * file and calls intakeFiles).
   */
  function insertFromClipboard(root) {
    var api = navigator.clipboard;
    if (api === undefined || api === null) return;
    if (typeof api.readText !== 'function') {
      readImageFromClipboard(root);
      return;
    }
    var pending;
    try {
      pending = api.readText();
    } catch (err) {
      return;
    }
    Promise.resolve(pending).then(
      function (clip) {
        if (typeof clip === 'string' && clip !== '') insert(root, clip);
        else readImageFromClipboard(root);
      },
      function () {},
    );
  }

  /** Hand the composer one image the only way it accepts one: as a paste file. */
  function replayFileAsPaste(root, file) {
    var transfer;
    try {
      transfer = new DataTransfer();
      transfer.items.add(file);
      if (transfer.files.length !== 1) {
        return;
      }
    } catch (err) {
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
      return;
    }
    try {
      root.dispatchEvent(event);
    } catch (err) {
      return;
    }
  }

  /**
   * Android never puts an image on clipboardData, so an image pasted by
   * long-press arrives as an empty text payload. clipboard.read() is the one
   * route that can still see it.
   */
  function readImageFromClipboard(root) {
    var api = navigator.clipboard;
    if (api === undefined || api === null || typeof api.read !== 'function') {
      return;
    }
    var pending;
    try {
      pending = api.read();
    } catch (err) {
      return;
    }
    Promise.resolve(pending).then(
      function (items) {
        var list = items || [];
        for (var i = 0; i < list.length; i++) {
          var types = (list[i] && list[i].types) || [];
          for (var j = 0; j < types.length; j++) {
            if (String(types[j]).indexOf('image/') === 0) {
              takeImageItem(root, list[i], String(types[j]));
              return;
            }
          }
        }
      },
      function () {},
    );
  }

  function takeImageItem(root, item, type) {
    var pending;
    try {
      pending = item.getType(type);
    } catch (err) {
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
          return;
        }
        replayFileAsPaste(root, file);
      },
      function () {},
    );
  }

  document.addEventListener(
    'beforeinput',
    function (event) {
      var root = composerRoot(event);
      var type = event.inputType;

      if (PASTE_INPUT_TYPES[type] === true) {
        if (root === null) return;
        // Take the event before Lexical sees it: its branch would cancel the
        // default action and then hand the payload-less InputEvent to a handler
        // that cannot read it.
        event.preventDefault();
        event.stopImmediatePropagation();
        lastEditor = root;
        var text = textFrom(event.dataTransfer) || textFrom(event.clipboardData);
        if (text === '' && typeof event.data === 'string') text = event.data;
        if (text === '') insertFromClipboard(root);
        else insert(root, text);
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
          insert(root, data);
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
            insert(stray, data);
            return;
          }
        }
      }
    },
    true,
  );

  document.addEventListener(
    'paste',
    function (event) {
      var text = textFrom(event.clipboardData);
      var files = fileCount(event.clipboardData);
      var root = composerRoot(event);

      if (root === null) {
        // The path that used to be invisible here: the editor is not under the
        // event at all, so the composer never runs and nothing happens.
        repairStrayPaste(event);
        return;
      }

      lastEditor = root;
      if (files > 0) {
        return;
      }
      if (text !== '') {
        // A dragged selection carries text/html beside text/plain, and only that
        // differs between the paste that lands and the paste that vanishes. Send
        // the text alone down the path already proven on the device.
        if (hasHtml(event.clipboardData)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          insert(root, text);
          return;
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      insertFromClipboard(root);
    },
    true,
  );

})();
