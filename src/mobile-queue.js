/*
 * Long-press the Send button to use the other busy mode, injected inline into
 * index.html by src/host/index.js next to mobile-composer.js.
 *
 * The gap this closes: while the agent is running, the composer's busy behaviour
 * has two modes, and the phone can only reach one of them. The preference lives
 * in Settings ("Send behavior while busy"), and the desktop composer offers both
 * by keyboard - plain Enter takes the preference, Cmd/Ctrl+Enter takes the other
 * one (submission-policy resolveSubmitMode, client.js:15961-15965: busy with the
 * "enter" gesture returns the preference, any other gesture returns its
 * opposite). A soft keyboard has no Ctrl, so on a phone the complementary mode
 * is unreachable: with the preference on Steer, there is no way to queue a
 * message behind the running turn.
 *
 * Why the chord and not a click. The primary button resolves its mode once, at
 * render - `primarySubmitMode = resolveSubmitMode(busyEnter, running, "enter",
 * steeringAvailable)` (client.js:18951) - and its handler submits that stored
 * value: `keyboard.submit(primarySubmitMode, "click")` (client.js:18961). The
 * click path reads no modifier keys, so a click re-dispatched with ctrlKey set
 * still submits the primary mode. The only lever that changes the mode is the
 * composer's own keymap: Lexical's ENTER command reads `event.ctrlKey` and calls
 * `handlers.submit(event?.ctrlKey === true || event?.metaKey === true)`
 * (client.js:18246), and submit() treats that as the "accelerated" gesture
 * (client.js:18370) which resolveSubmitMode resolves to the opposite mode. So
 * the hold synthesises exactly what Cmd/Ctrl+Enter would send. mobile-composer.js
 * already uses the same technique for the Shift+Enter line break, and its
 * document keydown guard returns early on ctrlKey/metaKey (mobile-composer.js:150),
 * so the synthetic chord passes it untouched.
 *
 * Why the draft has to be non-empty. `submit(true)` has a second branch:
 * `if (accelerated && g.canSteerQueue) { keyboard.steerQueue(); return; }`
 * (client.js:18362), and canSteerQueue requires an EMPTY draft plus queued items
 * (client.js:18828). That branch drains the whole queue into the running turn -
 * the exact opposite of queueing, triggered by a gesture whose pill promised
 * the opposite. An empty draft is also the state where the primary button is
 * not Send at all: `primaryStops = running && subagent === null && (empty || ...)`
 * (client.js:18948) turns it into Stop, and a hold on Stop would stop the run.
 * Both are excluded by requiring text in the editor before the timer starts.
 *
 * Why a long press. It is the one gesture a phone has that a tap does not, so
 * the normal tap - the behaviour the user already relies on - is untouched, and
 * a press that ends before HOLD_MS is just a tap. Nothing fires on pointerup:
 * the action happens at HOLD_MS, which is why a hold can be cancelled by sliding
 * the finger off (SLOP_PX) or by the page being scrolled, backgrounded or
 * blurred before that. A cancel that arrives with the finger still on the button
 * is not one of those: that is the engine claiming the touch for its own
 * long-press gesture (Chrome on Android does this while the keyboard is up, which
 * is exactly when queueing matters), so the timer keeps running.
 *
 * Why the click has to be swallowed. After the hold fires, the browser still
 * delivers the click for that same press, and the button's onClick would submit
 * a second time with the primary mode; by then the draft is empty, which is the
 * state the app reads as "queue or steer the queued items". A one-shot
 * capture-phase listener on the document takes that click before React's root
 * handler sees it (capture on document runs before any descendant), and removes
 * itself. CLICK_SUPPRESS_MS bounds its life for the case where no click arrives
 * at all - a scroll that cancelled the tap, or an engine that never synthesises
 * one after a long press.
 *
 * The hint pill says which mode the release will use, derived from the button's
 * own label: the label describes the tap, and the hold takes the other mode. The
 * labels are localised (client.js:16413-16416 in English), so the English words
 * "queue"/"steer" are the only signal available without reaching into app
 * internals; a localised label that contains neither gets the neutral fallback.
 *
 * Everything is gated on a coarse pointer, so desktop keeps both of its existing
 * gestures and gains nothing; window.__DSH_FORCE_MOBILE_QUEUE__ forces the
 * behaviour on for testing. No app module is patched and no React state is read:
 * the DOM the composer renders is the whole interface, found on demand on every
 * press because a re-render replaces those nodes.
 */
(function () {
  'use strict';

  var win = typeof window === 'undefined' ? null : window;
  if (win === null || win === undefined) return;
  if (typeof document === 'undefined' || document === null) return;

  var FORCED = win.__DSH_FORCE_MOBILE_QUEUE__ === true;
  var COARSE =
    typeof win.matchMedia === 'function' &&
    win.matchMedia('(pointer: coarse)').matches === true;

  if (!COARSE && !FORCED) return;

  // How long the finger has to stay down before the release becomes a send in
  // the other mode. Below this a press is a tap, which the button already owns.
  // It has to finish before the engine's own long press: Android opens its
  // selection and context menu about 400 ms into a press on a button, takes the
  // focus with it and drops the touch. A trace from a real phone showed a 400 ms
  // hold losing that race by a few milliseconds on every attempt, so the window
  // now closes at 300, inside the tap and ahead of the menu.
  var HOLD_MS = 300;
  // A press this old that loses the page - the engine's menu taking focus, or
  // the phone itself - is still a hold: the finger has been down long enough to
  // mean it, so the chord is sent rather than dropped.
  var HOLD_MIN_FIRE_MS = 150;
  // How long the engine's long press is kept from opening its menu after a hold
  // has fired, so a finger still resting on the button does not summon it.
  var MENU_GUARD_MS = 1500;
  // How long the confirmation stays on screen after the finger lifts.
  var PILL_HIDE_MS = 1400;
  // How far the finger may travel and still count as a hold. Past this it is a
  // scroll or a drag, which must never queue a message.
  var SLOP_PX = 10;
  // Upper bound on the click suppressor's life, for a press that ends without a
  // click (its gesture was cancelled) or a release the engine does not follow
  // with one.
  var CLICK_SUPPRESS_MS = 700;
  // How long after an ignored chord the next attempt waits. A chord is ignored
  // while the app believes the keyboard is still composing: Android fires IME
  // keydowns right up to the moment the finger lands, and the composer swallows
  // Enter during that window without cancelling it (client.js:18241
  // `isComposingEvent` returns early). That is the normal flow - type, then
  // immediately hold - so the chord is tried again along a ladder that outlives
  // the composition, and stops at the first one the composer takes.
  var RETRY_STEPS_MS = [30, 150, 400];
  // Gap between the pill's bottom edge and the Send button's top edge, so the
  // pill can never sit on the button the finger is holding.
  var PILL_GAP_PX = 8;

  var CARD_SELECTOR = '[data-composer-card]';
  var EDITOR_SELECTOR = '[data-lexical-editor="true"]';
  var PRIMARY_SELECTOR = 'button[type="button"]';
  // The primary button is the only one in the card carrying the CSS module's
  // `primary` class (client.js:19126); every other button in there is a toolbar
  // control with its own class.
  var PRIMARY_CLASS_MARK = '_primary';
  var PILL_CLASS = 'dsh-pwa-hold-hint';

  // The pill's copy. The button's label names the mode a TAP takes, so a label
  // that says "Queue message" means the hold steers, and the reverse. These are
  // the English strings from client.js:16414-16416; every other language falls
  // back to the third line, which is still true whichever mode the preference
  // is on.
  // The pill's copy, reported once the chord has gone out. The button's label
  // names the mode a TAP takes, so a label that says "Queue message" means the
  // hold steers. These are the English strings from client.js:16414-16416; every
  // other language falls back to the third line, which holds in either mode.
  var PILL_TEXT = {
    queue: 'Steering',
    steer: 'Queued',
    send: 'Sent',
  };
  // The chord can go unanswered - the composer still reads the keyboard as
  // composing, an editor replaced by a re-render, a draft it read as empty - and a
  // pill that stayed silent would leave the user pressing a button that does
  // nothing. A first attempt that was ignored is tried again, so the pill says it
  // is working on it before it gives up.
  var PILL_RETRYING = 'Sending…';
  var PILL_FAILED = 'Not sent — hold again';

  // One style element for the pill, injected the first time a hold fires.
  var PILL_CSS =
    '.' + PILL_CLASS + '{' +
    'position:fixed;z-index:2147483647;transform:translate(-50%,-100%);' +
    'padding:6px 10px;border-radius:10px;background:rgba(32,32,34,.96);color:#fafafa;' +
    'font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    'white-space:nowrap;pointer-events:none;user-select:none;-webkit-user-select:none;' +
    '-webkit-touch-callout:none;box-shadow:0 6px 18px rgba(0,0,0,.28);' +
    '}';

  // The press being tracked, or null. One at a time: a second finger landing on
  // the button while the first is held must not start a second timer.
  var hold = null;
  // The live click suppressor, the timer that expires it, and the pill element.
  var clickHandler = null;
  var clickTimer = null;
  var pill = null;
  // The timer that takes the confirmation away, and the moment the engine's own
  // long press stops being kept from opening its menu.
  var hideTimer = null;
  var menuGuardUntil = 0;
  // Listeners installed for the duration of one press, so a press that never
  // became a hold leaves nothing behind.
  var bound = [];
  var styleAdded = false;

  function isDisabled(button) {
    try {
      if (button.disabled === true) return true;
      return typeof button.hasAttribute === 'function' && button.hasAttribute('disabled') === true;
    } catch (err) {
      return false;
    }
  }

  /**
   * The primary Send button for a press, or null. A press anywhere else in the
   * card - the + menu, a model chip, Stop - is not this gesture.
   */
  function primaryButton(target) {
    if (target === null || target === undefined || typeof target.closest !== 'function') return null;
    var card = target.closest(CARD_SELECTOR);
    if (card === null || card === undefined) return null;
    var button = target.closest(PRIMARY_SELECTOR);
    if (button === null || button === undefined) return null;
    try {
      if (button.closest(CARD_SELECTOR) !== card) return null;
      if (String(button.className || '').indexOf(PRIMARY_CLASS_MARK) === -1) return null;
    } catch (err) {
      return null;
    }
    return button;
  }

  /** The draft editor inside the card, found fresh: a re-render replaces it. */
  function editorIn(card) {
    if (card === null || card === undefined || typeof card.querySelector !== 'function') return null;
    try {
      return card.querySelector(EDITOR_SELECTOR);
    } catch (err) {
      return null;
    }
  }

  /**
   * Whether the composer's trigger menu (slash, reference) is open. The app
   * marks that on the editor itself with aria-haspopup="menu" (client.js:18157),
   * which is the same signal mobile-composer.js uses to keep Enter for the menu.
   */
  function menuOpen(editor) {
    try {
      return editor.getAttribute('aria-haspopup') === 'menu';
    } catch (err) {
      return false;
    }
  }

  function draftText(editor) {
    try {
      return String(editor.textContent === null || editor.textContent === undefined ? '' : editor.textContent);
    } catch (err) {
      return '';
    }
  }

  function addBound(target, type, fn) {
    if (target === null || target === undefined || typeof target.addEventListener !== 'function') return;
    try {
      target.addEventListener(type, fn, true);
      bound.push([target, type, fn]);
    } catch (err) {
      // A target that will not take a listener is simply not watched; the
      // pointerup on the document is the one that matters and is always there.
    }
  }

  function removeBound() {
    var list = bound;
    bound = [];
    for (var i = 0; i < list.length; i++) {
      try {
        list[i][0].removeEventListener(list[i][1], list[i][2], true);
      } catch (err) {
        // Nothing to do: the node is gone with the render that owned it.
      }
    }
  }

  function samePointer(event) {
    if (hold === null) return false;
    if (event === null || event === undefined) return false;
    if (event.pointerId === undefined || hold.pointerId === undefined) return true;
    return event.pointerId === hold.pointerId;
  }

  function clearHoldTimer() {
    if (hold === null || hold.timer === null) return;
    var timer = hold.timer;
    hold.timer = null;
    try {
      clearTimeout(timer);
    } catch (err) {
      // A timer that cannot be cleared is already gone.
    }
  }

  function ensurePillStyle() {
    if (styleAdded) return;
    if (typeof document.createElement !== 'function' || document.head === null || document.head === undefined) return;
    styleAdded = true;
    try {
      var el = document.createElement('style');
      el.setAttribute('data-dsh-pwa-hold', '');
      el.textContent = PILL_CSS;
      document.head.appendChild(el);
    } catch (err) {
      styleAdded = false;
    }
  }

  /** Take the confirmation's own timer down, so a removal is not followed by one. */
  function clearHideTimer() {
    if (hideTimer === null) return;
    var timer = hideTimer;
    hideTimer = null;
    try {
      clearTimeout(timer);
    } catch (err) {
      // A timer that cannot be cleared runs into a node that is already gone.
    }
  }

  function removePill() {
    clearHideTimer();
    if (pill === null) return;
    var node = pill;
    pill = null;
    try {
      if (typeof node.remove === 'function') {
        node.remove();
        return;
      }
      if (node.parentNode !== null && node.parentNode !== undefined && typeof node.parentNode.removeChild === 'function') {
        node.parentNode.removeChild(node);
      }
    } catch (err) {
      // Already detached with the render that replaced the composer.
    }
  }

  /** Which mode a hold on this button takes: the one the label does not name. */
  function modeFor(button) {
    var label = '';
    try {
      label = String(button.getAttribute('aria-label') || '');
    } catch (err) {
      label = '';
    }
    var lower = label.toLowerCase();
    if (lower.indexOf('queue') !== -1) return 'queue';
    if (lower.indexOf('steer') !== -1) return 'steer';
    return 'send';
  }

  /** What the pill says for that mode, or why it said nothing. */
  function textFor(button, acknowledged) {
    return acknowledged ? PILL_TEXT[modeFor(button)] : PILL_FAILED;
  }

  function rectOf(button) {
    var rect = null;
    try {
      if (typeof button.getBoundingClientRect === 'function') rect = button.getBoundingClientRect();
    } catch (err) {
      rect = null;
    }
    if (rect === null || rect === undefined) {
      // No layout to read: put it above the bottom edge, centred. Still the
      // right corner of the screen and still off the button.
      return {
        top: typeof win.innerHeight === 'number' ? win.innerHeight : 0,
        left: typeof win.innerWidth === 'number' ? win.innerWidth / 2 : 0,
        width: 0,
      };
    }
    return rect;
  }

  /**
   * Show which mode the release will use, just above the button. The element is
   * created per hold and removed when the press ends, so the document holds no
   * idle leftover between gestures.
   */
  function showPill(button, text) {
    removePill();
    if (typeof document.createElement !== 'function' || document.body === null || document.body === undefined) return;
    ensurePillStyle();
    var node;
    try {
      node = document.createElement('div');
    } catch (err) {
      return;
    }
    node.className = PILL_CLASS;
    node.setAttribute('data-dsh-pwa-hold-hint', '');
    node.textContent = text;
    var rect = rectOf(button);
    var left = (typeof rect.left === 'number' ? rect.left : 0) + (typeof rect.width === 'number' ? rect.width / 2 : 0);
    var top = (typeof rect.top === 'number' ? rect.top : 0) - PILL_GAP_PX;
    try {
      node.style.left = Math.round(left) + 'px';
      node.style.top = Math.round(top) + 'px';
      document.body.appendChild(node);
    } catch (err) {
      return;
    }
    pill = node;
    // The confirmation outlives the finger: a press that fires while the user is
    // still reading it would otherwise take its own answer off the screen.
    clearHideTimer();
    hideTimer = setTimeout(removePill, PILL_HIDE_MS);
    // The pill is centred on the button, which sits at the card's right edge, so
    // on a narrow phone half of it could hang off the screen. The width is only
    // known after insertion; one read, then clamp inside the window if it does.
    var width = typeof node.offsetWidth === 'number' ? node.offsetWidth : 0;
    if (width > 0 && typeof win.innerWidth === 'number' && win.innerWidth > 0) {
      var half = width / 2 + PILL_GAP_PX;
      var clamped = Math.min(Math.max(left, half), win.innerWidth - half);
      if (isFinite(clamped) && clamped !== left) {
        try {
          node.style.left = Math.round(clamped) + 'px';
        } catch (err) {
          // The first placement stands; this only tightens it.
        }
      }
    }
  }

  /** A short tap of feedback that the press became something else. */
  function buzz() {
    var api = typeof navigator === 'undefined' ? null : navigator;
    if (api === null || api === undefined || typeof api.vibrate !== 'function') return;
    try {
      api.vibrate(10);
    } catch (err) {
      // Vibration is a courtesy; a refusal is not an error.
    }
  }

  /**
   * The composer's own Cmd/Ctrl+Enter, dispatched at the editor root. Same shape
   * as the line break mobile-composer.js sends, with the modifier that makes
   * Lexical's ENTER command submit the accelerated gesture.
   *
   * Returns the event, so the caller can read whether the composer cancelled it
   * (Lexical does that for every Enter it handles, client.js:18243), or null
   * when no event could be built or dispatched at all.
   */
  function dispatchChord(editor) {
    if (typeof KeyboardEvent !== 'function') return null;
    var event;
    try {
      event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
    } catch (err) {
      return null;
    }
    try {
      editor.dispatchEvent(event);
    } catch (err) {
      return null;
    }
    return event;
  }

  function removeClickSuppressor() {
    if (clickTimer !== null) {
      var timer = clickTimer;
      clickTimer = null;
      try {
        clearTimeout(timer);
      } catch (err) {
        // Expiry of a timer that cannot be cleared is harmless.
      }
    }
    if (clickHandler === null) return;
    var handler = clickHandler;
    clickHandler = null;
    try {
      document.removeEventListener('click', handler, true);
    } catch (err) {
      // The document outlives every listener on it.
    }
  }

  /**
   * Take the click that this same press is about to produce, once. The press
   * became a chord at HOLD_MS, and the release still lands as a click whose
   * onClick would submit the primary mode a second time.
   */
  function suppressClick() {
    removeClickSuppressor();
    var handler = function (click) {
      var target = click === null || click === undefined ? null : click.target;
      // A click somewhere else in the meantime is not this press; leave it be.
      if (target !== null && typeof target.closest === 'function' && target.closest(CARD_SELECTOR) === null) return;
      try {
        click.preventDefault();
        click.stopImmediatePropagation();
      } catch (err) {
        // Either way the suppressor is spent below.
      }
      removeClickSuppressor();
    };
    clickHandler = handler;
    try {
      document.addEventListener('click', handler, true);
    } catch (err) {
      clickHandler = null;
      return;
    }
    clickTimer = setTimeout(removeClickSuppressor, CLICK_SUPPRESS_MS);
  }

  /**
   * End the press. keepSuppressor is true only for the release of a press that
   * already fired: its click is still coming and has to be swallowed. Every
   * other way out - a slide-off, a cancel with the finger off the button, the app
   * going away - drops it.
   */
  function stop(keepSuppressor) {
    if (hold === null) return;
    clearHoldTimer();
    // A press that fired keeps its confirmation on screen for a moment, so the
    // outcome is still readable once the finger lifts.
    if (hold.fired !== true) removePill();
    hold = null;
    removeBound();
    if (!keepSuppressor) removeClickSuppressor();
  }

  /** Ask the composer fix for the caret back, when its keep hook is there. */
  function retainCaret() {
    var hook = typeof window === 'undefined' ? null : window.__dshPwaKeepDraftFocus;
    if (typeof hook !== 'function') return;
    try {
      hook();
    } catch (err) {
      // A missing caret is recoverable; the chord below still runs.
    }
  }

  /** Whether the composer took the chord it was given. */
  function chord(editor) {
    var event = dispatchChord(editor);
    return event !== null && event.defaultPrevented === true;
  }

  /**
   * The ladder of attempts after a chord the composer ignored, each on the editor
   * as it is now and only while the draft still holds the same text.
   *
   * The first attempt goes out 300 ms after the finger lands, which on a phone
   * that was just typed into is inside the composer's composing window: it
   * swallows Enter there without cancelling it (client.js:18241), so the chord
   * looks delivered but nothing was sent. The steps grow past that window; a
   * chord the composer does take clears the draft, which is what stops the rest.
   */
  function retryChord(card, before, button, step) {
    setTimeout(function () {
      var editor = editorIn(card);
      if (editor === null || menuOpen(editor)) {
      } else if (draftText(editor) !== before) {
        // The user has moved on: the draft was submitted after all, or retyped.
        return;
      } else {
        retainCaret();
        var acknowledged = chord(editor);
        if (acknowledged) {
          if (button) showPill(button, textFor(button, true));
          return;
        }
      }
      if (step + 1 < RETRY_STEPS_MS.length) {
        retryChord(card, before, button, step + 1);
        return;
      }
      if (button) showPill(button, PILL_FAILED);
    }, RETRY_STEPS_MS[step]);
  }

  /** The hold became a send in the complementary mode. */
  function fire() {
    if (hold === null || hold.fired) return;
    hold.timer = null;
    hold.fired = true;
    var card = hold.card;
    var before = draftText(hold.editor);
    // The submit reads the draft's selection, and a press that moved focus
    // leaves none behind.
    retainCaret();
    // A re-render replaces the editor node, so the one captured at pointerdown
    // may already be detached and would swallow the chord.
    var editor = editorIn(card) || hold.editor;
    var button = hold.button;
    var acknowledged = chord(editor);
    // The engine opens its own menu about 400 ms into a press on a button, which
    // is now behind a gesture that has already sent: it would land on top of the
    // confirmation with the finger still down.
    menuGuardUntil = Date.now() + MENU_GUARD_MS;
    suppressClick();
    buzz();
    if (acknowledged) {
      showPill(button, textFor(button, true));
      return;
    }
    showPill(button, PILL_RETRYING);
    retryChord(card, before, button, 0);
  }

  function onMove(event) {
    if (!samePointer(event)) return;
    if (hold.fired) {
      // The mode is already sent, so there is nothing left to cancel - and the
      // confirmation stays. A finger resting on a button emits pointermove from
      // its own tremor, and clearing the pill on the first of those took the
      // answer off the screen a frame after it was written.
      return;
    }
    var x = event.clientX;
    var y = event.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    var dx = x - hold.x;
    var dy = y - hold.y;
    if (Math.sqrt(dx * dx + dy * dy) > SLOP_PX) {
      stop(false);
    }
  }

  function onRelease(event) {
    if (!samePointer(event)) return;
    // Whether it fired or not, the press is over. A fired press keeps the
    // suppressor for the click its release is about to produce.
    var fired = hold.fired;
    stop(fired);
  }

  /** Whether an event reports a finger that has left the press origin. */
  function movedAway(event) {
    if (hold === null) return true;
    var x = event.clientX;
    var y = event.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') return true;
    var dx = x - hold.x;
    var dy = y - hold.y;
    return Math.sqrt(dx * dx + dy * dy) > SLOP_PX;
  }

  function onCancelPress(event) {
    if (hold === null) return;
    if (!samePointer(event)) return;
    // A cancel can arrive after the chord already fired - the browser's own
    // long-press gesture cancels the pointer under a finger that is still down.
    // The commit stands, so its click stays suppressed, exactly as on release.
    if (hold.fired === true) {
      stop(true);
      return;
    }
    // Before the chord, a cancel is either a pan that took the touch (by then the
    // finger is somewhere else) or the engine's long press claiming it while the
    // finger has not moved. Only the first ends the press.
    if (movedAway(event)) {
      stop(false);
      return;
    }
  }

  /** The finger left the button: the press is over, wherever it went. */
  function onLeave(event) {
    if (hold === null) return;
    if (!samePointer(event)) return;
    stop(hold.fired === true);
  }

  function onVisibility() {
    if (hold === null) return;
    if (hold.fired === true) return;
    // The page losing focus is what the engine's long press does about 400 ms in,
    // and what the phone does when it takes the screen away. A press that has
    // been down long enough is a hold in either case, and the chord is the only
    // way the user's intent survives: cancelling here is what made the gesture
    // silently do nothing on a real phone.
    var held = Date.now() - hold.startedAt;
    if (held >= HOLD_MIN_FIRE_MS) {
      fire();
      return;
    }
    stop(false);
  }

  function onContextMenu(event) {
    // A long press on a button is the browser's text-selection menu; while this
    // gesture is running, and for a moment after it fires, it belongs to us.
    if (hold === null && Date.now() >= menuGuardUntil) return;
    try {
      event.preventDefault();
      event.stopImmediatePropagation();
    } catch (err) {
      // The menu may appear anyway on an engine that ignores this; the press
      // still settles on pointerup.
    }
  }

  function onPointerDown(event) {
    if (hold !== null) return;
    if (event === null || event === undefined) return;
    // A second finger is not primary; a mouse or the first touch is. Older
    // synthetic events omit the flag, so only an explicit false is refused.
    if (event.isPrimary === false) return;
    if (event.button !== 0) return;
    var button = primaryButton(event.target);
    if (button === null || isDisabled(button)) {
      return;
    }
    var card;
    try {
      card = button.closest(CARD_SELECTOR);
    } catch (err) {
      return;
    }
    var editor = editorIn(card);
    if (editor === null) {
      return;
    }
    if (menuOpen(editor)) {
      return;
    }
    // Empty means Stop (client.js:18948) and the queue-draining branch
    // (client.js:18362 with 18828), both of which must stay unreachable here.
    if (draftText(editor).trim() === '') {
      return;
    }

    hold = {
      pointerId: event.pointerId,
      x: typeof event.clientX === 'number' ? event.clientX : 0,
      y: typeof event.clientY === 'number' ? event.clientY : 0,
      button: button,
      card: card,
      editor: editor,
      fired: false,
      startedAt: Date.now(),
      timer: null,
    };
    var armed = hold;
    armed.timer = setTimeout(function () {
      // The press this timer belonged to may have ended already; fire() checks
      // the current hold, so a stale timer cannot run a later gesture.
      if (hold !== armed) return;
      fire();
    }, HOLD_MS);

    addBound(document, 'pointermove', onMove);
    addBound(document, 'pointerup', onRelease);
    addBound(document, 'pointercancel', onCancelPress);
    addBound(document, 'pointerleave', onLeave);
    addBound(win, 'blur', onVisibility);
    addBound(document, 'visibilitychange', onVisibility);
  }

  /**
   * The caret back, after the engine's own long press takes it.
   *
   * Chrome focuses the control under the finger about 395 ms into a press - seen
   * on a phone, 40 to 90 ms after a hold had already sent - and on Android a
   * focused button closes the keyboard the draft was holding. The press is the
   * user's, and they pressed to stay in the composer, so the caret goes back.
   * Bounded by the same window that keeps the engine's menu away: a press well
   * after the gesture keeps whatever focus the app gives it.
   */
  function onFocusIn() {
    if (Date.now() >= menuGuardUntil) return;
    var focus = document.activeElement;
    if (focus === null || focus === undefined) return;
    if (typeof focus.closest !== 'function') return;
    if (focus.closest(EDITOR_SELECTOR) !== null) return;
    if (focus.closest(CARD_SELECTOR) === null) return;
    retainCaret();
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  // Arms only while a press is being tracked, so a long press anywhere else in
  // the composer - the paste menu on the draft, most importantly - is untouched.
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('focusin', onFocusIn, true);
})();
