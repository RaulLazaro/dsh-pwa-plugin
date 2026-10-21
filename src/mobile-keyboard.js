/*
 * The composer rises above the keyboard, injected inline into index.html by
 * src/host/index.js. Nothing here patches @deepseek-ai/dsh-client-ui-conversation.
 *
 * The app is a fixed-height column: `html,body,#root{height:100%}` in the shell
 * stylesheet (index-BxpfOGf3.css), and the conversation's composer seat is the
 * last item of that column (ConversationRoot.module.css: composerSeat is
 * flex:none, and in the active phase it is sticky at bottom:0 of the
 * scrollBody). With 100% meaning "the whole window", the composer is therefore
 * laid out exactly where the soft keyboard opens, and the end of the transcript
 * is covered with it.
 *
 * That is not a bug the framework can fix with CSS units. A phone keyboard does
 * not resize the layout viewport any more: Chromium has resized only the visual
 * viewport since Chrome 108 (the old resize is now the opt-in
 * `interactive-widget=resizes-content`), and Safari has never resized the
 * layout viewport - it shrinks the visual one and pans it. dvh/svh/lvh do not
 * help: they follow the browser's own chrome (the URL bar), not the keyboard,
 * so a `100dvh` column is still full height with the keyboard open.
 *
 * So there has to be one geometry source of truth, and it is the visual
 * viewport. While the keyboard is up the app is boxed to
 * `visualViewport.height` at `visualViewport.offsetTop` - the part of the
 * window the user can actually see - and the composer, being the bottom of that
 * box, sits directly above the keyboard while the transcript loses the covered
 * strip instead of hiding it. That is the shape of the fix in the chat apps
 * this is modelled on.
 *
 * The keyboard's own height is `innerHeight - visualViewport.height -
 * visualViewport.offsetTop`: the layout viewport is `innerHeight` tall and the
 * visible area is the visual viewport, so the difference is covered. offsetTop
 * has to come off as well because both engines move the visible area when a
 * field near the bottom is focused - iOS scrolls the document, Chromium pans
 * the visual viewport - which raises the visible area without making it taller.
 * Without that term the box would be placed where the visible area used to be
 * and its bottom would land under the keyboard again.
 *
 * `resize` alone is not enough: an arriving keyboard always resizes the visual
 * viewport, but the pan described above can arrive as `scroll` alone
 * (offsetTop changes, height does not). Both are listened to, and the write is
 * folded into one animation frame because a keyboard animates in over dozens of
 * events. Pinch zoom also shrinks the visual viewport and is not a keyboard, so
 * a scale other than 1 is left untouched.
 *
 * The host additionally asks for `interactive-widget=resizes-content` in the
 * viewport meta (src/host/index.js). Where that is honoured - Chromium only;
 * WebKit has it implemented but unshipped - the layout viewport shrinks by
 * itself, the gap measured here is 0, and this script stays out of the way. The
 * two therefore never double up, and Safari plus older Chromium get the same
 * behaviour from the script.
 *
 * One rule, gated on an attribute this script sets only while the keyboard is
 * up, so a desktop window and a phone with the keyboard closed keep
 * height:100% and never enter the resize path at all. `env(safe-area-inset-*)`
 * is deliberately not in the rule: the app does not declare viewport-fit=cover
 * (src/pwa-client.js explains why), so the inset is 0 today and the keyboard
 * owns that strip anyway once it is open.
 */
(function () {
  'use strict';

  var win = typeof window === 'undefined' ? undefined : window;
  if (!win || !win.document) return;
  var doc = win.document;
  var root = doc.documentElement;
  if (!root || typeof root.setAttribute !== 'function') return;

  // Without visualViewport there is nothing to measure. Every engine that can
  // show a soft keyboard over the composer has it (Chrome 61+, Safari 13+).
  var viewport = win.visualViewport;
  if (!viewport || typeof viewport.addEventListener !== 'function') return;

  var forced = win.__DSH_FORCE_MOBILE_KEYBOARD__ === true;
  var coarse =
    typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches === true;
  if (!coarse && !forced) return;

  var ATTRIBUTE = 'data-dsh-pwa-keyboard';
  var HEIGHT_VAR = '--dsh-pwa-viewport-height';
  var TOP_VAR = '--dsh-pwa-viewport-top';

  // The smallest covered strip that counts as a keyboard. A collapsing URL bar
  // never opens a gap - it changes innerHeight and the visual viewport together
  // - and the shortest soft keyboard seen in phone landscape is well over this.
  var KEYBOARD_MIN_PX = 120;

  // Two rules. The first keeps the document itself from scrolling while the
  // keyboard is open: with the app boxed to the visual viewport there is nothing
  // left below it to scroll to, and on iOS a scrollable document is one the
  // engine will happily scroll out from under the box to reveal a field.
  var STYLE =
    'html[' + ATTRIBUTE + '],html[' + ATTRIBUTE + '] body{overflow:hidden;}' +
    'html[' + ATTRIBUTE + '] #root{' +
    'position:fixed;bottom:auto;left:0;right:0;' +
    'top:var(' + TOP_VAR + ',0px);' +
    'height:var(' + HEIGHT_VAR + ',100%);' +
    '}';

  // Whether the attribute is on. Every clear() after the keyboard has been seen
  // is one the document may have been scrolled by, and only those are restored.
  var open = false;
  // A pending animation frame, used as a "measurement already queued" flag.
  var frame = null;

  function addStyle() {
    if (!doc.head || typeof doc.createElement !== 'function') return;
    try {
      if (typeof doc.querySelector === 'function' && doc.querySelector('style[data-dsh-pwa-keyboard]') !== null) return;
      var el = doc.createElement('style');
      el.setAttribute('data-dsh-pwa-keyboard', '');
      el.textContent = STYLE;
      doc.head.appendChild(el);
    } catch (err) {
      // No usable head: the measurement below still runs, it just has no rule
      // to apply. Nothing else in the app depends on this.
    }
  }

  /**
   * The visible box for the current geometry, null when no keyboard owns the
   * window, or undefined when the frame must be left alone (a pinch zoom).
   * Read-only: nothing is written until a box comes back.
   */
  function measure() {
    try {
      var scale = typeof viewport.scale === 'number' ? viewport.scale : 1;
      // A pinch zoom shrinks the visual viewport without any keyboard. Leaving
      // the current box alone is deliberate: a zoom with the keyboard already
      // open is a no-op on a phone, and dropping the box there would be the
      // worse error. undefined means "no measurement", which is not the same as
      // null, "no keyboard owns the window".
      if (scale !== 1) return undefined;
      var layout = win.innerHeight || 0;
      var visible = viewport.height || 0;
      var top = viewport.offsetTop || 0;
      if (layout <= 0 || visible <= 0) return null;
      if (top < 0) top = 0;
      var inset = layout - visible - top;
      if (inset < KEYBOARD_MIN_PX) return null;
      // iOS reports a visual viewport taller than the layout viewport while the
      // page rubber-bands. It is not a keyboard, and it must not stretch the
      // app past the window.
      if (visible > layout) return null;
      return {
        height: Math.round(visible),
        top: Math.round(top),
      };
    } catch (err) {
      return null;
    }
  }

  /** Put the app back to the framework's own full-height layout. */
  function clear() {
    if (!open) return;
    open = false;
    try {
      root.removeAttribute(ATTRIBUTE);
      root.style.removeProperty(HEIGHT_VAR);
      root.style.removeProperty(TOP_VAR);
    } catch (err) {
      // Nothing to recover: the next keyboard dismissal retries the same write.
    }
    // iOS leaves the document scrolled after the keyboard made it scroll to a
    // field, and with the keyboard gone there is nothing left to reveal, so the
    // app would keep its header cut off until the user scrolled back. Only
    // reachable after the keyboard was seen, so a desktop never gets here.
    if (typeof win.scrollTo === 'function') {
      try {
        win.scrollTo(0, 0);
      } catch (err) {
        // A scroll-restoring engine refuses on a non-scrollable document.
      }
    }
  }

  function apply() {
    frame = null;
    var box = measure();
    // A pinch zoom: not a keyboard and not a close either, so the last box
    // stays until a real measurement replaces it.
    if (box === undefined) return;
    if (box === null) {
      clear();
      return;
    }
    // The vars are written before the attribute: the attribute is what turns the
    // rule on, so the first paint that sees it already has the right box.
    try {
      root.style.setProperty(HEIGHT_VAR, box.height + 'px');
      root.style.setProperty(TOP_VAR, box.top + 'px');
    } catch (err) {
      return;
    }
    if (open) return;
    open = true;
    root.setAttribute(ATTRIBUTE, '');
  }

  function schedule() {
    if (frame !== null) return;
    if (typeof win.requestAnimationFrame === 'function') {
      frame = win.requestAnimationFrame(apply);
      return;
    }
    frame = win.setTimeout(apply, 16);
  }

  addStyle();
  viewport.addEventListener('resize', schedule, { passive: true });
  viewport.addEventListener('scroll', schedule, { passive: true });
  // Coming back from the app switcher is the one case neither event covers: the
  // keyboard can be gone (or back) while the page was not running, and some
  // engines do not re-fire a resize for it.
  doc.addEventListener('visibilitychange', schedule, { passive: true });
  // One measurement at load: a restored session can already have a focused
  // composer, and the engine does not re-fire resize for a keyboard that was
  // open before this script ran.
  apply();
})();
