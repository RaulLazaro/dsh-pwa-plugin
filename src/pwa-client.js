/**
 * Client fixes for the installed app.
 *
 * Three IIFEs, in this order: the back-gesture guard, device enrollment - which
 * is what lets a phone that signed in once stay signed in without pasting a
 * fresh code - and the Android polish (no reload on overscroll, safe areas for
 * the surfaces this plugin owns, durable storage). The polish carries its
 * own reasoning where it sits, at the end of the file.
 *
 * Back-gesture guard: an edge swipe is a history traversal, and an installed PWA with
 * nowhere left to go is simply closed: the user is thrown out of the app
 * mid-conversation. The fix is the long-standing one - keep a sentinel history
 * entry on top of the stack so the gesture always has somewhere to land, and put
 * the sentinel back every time it is consumed. A deliberate second swipe inside
 * EXIT_WINDOW_MS is allowed through, so back still exits when it is meant to.
 *
 * Chromium runs the swipe's traversal itself, so popstate is the fallback; where
 * the Navigation API exists the traversal is intercepted before it starts. Both
 * paths funnel through one handler, which is what stops a single gesture from
 * being counted twice - twice would arm two sentinels, and escaping would then
 * take three swipes instead of two.
 *
 * Only the installed app is guarded. A browser tab keeps normal history, so this
 * can never interfere with desktop use of the same UI.
 */

(function () {
  'use strict';

  var SENTINEL = 'dshBackGuard';
  var EXIT_WINDOW_MS = 2000;
  var DEDUPE_MS = 250;
  var TOAST_MS = 1800;
  var TOAST_TEXT = 'Swipe back again to leave DSH';

  function install(win) {
    if (!win || win.__dshBackGuard) return false;

    var history = win.history;
    var navigator = win.navigator || {};
    var doc = win.document;
    if (!history || typeof history.pushState !== 'function') return false;

    function standalone() {
      if (navigator.standalone === true) return true;
      if (typeof win.matchMedia !== 'function') return false;
      return (
        win.matchMedia('(display-mode: standalone)').matches === true ||
        win.matchMedia('(display-mode: fullscreen)').matches === true
      );
    }

    // A browser tab keeps normal history: nothing below is installed for it.
    if (!standalone()) return false;

    var lastHandledAt = 0;
    var lastBackAt = 0;
    var lettingGo = false;
    var toastEl = null;

    function shielded() {
      var current = history.state;
      return !!(current && typeof current === 'object' && current[SENTINEL]);
    }

    function arm() {
      if (shielded()) return;
      try {
        // The sentinel is a history entry, not a route: the URL is deliberately
        // left alone so the app's own state and any ?dshSession= survive it.
        history.pushState({ [SENTINEL]: true }, '', win.location.href);
      } catch (err) {
        // An opaque or sandboxed origin refuses pushState. Best effort: the
        // gesture behaves as it did before rather than breaking the page.
      }
    }

    function toast(message) {
      if (!doc || !doc.body || typeof doc.createElement !== 'function') return;
      try {
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        var el = doc.createElement('div');
        el.textContent = message;
        el.setAttribute('data-dsh-back-toast', '');
        el.style.cssText =
          'position:fixed;left:50%;bottom:calc(32px + env(safe-area-inset-bottom, 0px));' +
          'transform:translateX(-50%);z-index:2147483647;' +
          'background:rgba(35,35,36,.96);color:#f9fafb;font:14px/1.4 system-ui,sans-serif;' +
          'padding:10px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.12);' +
          'box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;opacity:0;transition:opacity .18s ease';
        doc.body.appendChild(el);
        toastEl = el;
        var show = function () { el.style.opacity = '1'; };
        if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(show);
        else show();
        win.setTimeout(function () {
          el.style.opacity = '0';
          win.setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
            if (toastEl === el) toastEl = null;
          }, 200);
        }, TOAST_MS);
      } catch (err) {
        // A toast is a courtesy. It must never be able to break the guard.
      }
    }

    /**
     * One back gesture, whichever path reported it.
     * Returns "duplicate" when the same gesture already arrived, "exit" when the
     * user asked twice inside the window, otherwise "guard".
     */
    function verdictFor() {
      var now = Date.now();
      if (now - lastHandledAt < DEDUPE_MS) return 'duplicate';
      lastHandledAt = now;
      var deliberate = now - lastBackAt < EXIT_WINDOW_MS;
      lastBackAt = now;
      return deliberate ? 'exit' : 'guard';
    }

    function onBack() {
      if (lettingGo) return;
      var verdict = verdictFor();
      if (verdict === 'duplicate') return;
      if (verdict === 'exit') {
        // Stop shielding so the traversal below is the real one. The popstate
        // that follows returns early on lettingGo rather than arming again.
        lettingGo = true;
        history.back();
        return;
      }
      arm();
      toast(TOAST_TEXT);
    }

    arm();

    win.addEventListener('popstate', onBack);

    var nav = win.navigation;
    if (nav && typeof nav.addEventListener === 'function') {
      nav.addEventListener('navigate', function (event) {
        if (lettingGo) return;
        if (event.navigationType !== 'traverse') return;
        if (typeof event.canIntercept !== 'boolean' || !event.canIntercept) return;
        var current = nav.currentEntry;
        if (current && event.destination && event.destination.index >= current.index) return;
        event.intercept({ handler: onBack });
      });
    }

    win.__dshBackGuard = true;
    return true;
  }

  install(typeof window === 'undefined' ? undefined : window);
})();

/**
 * Device enrollment.
 *
 * A phone that signs in once should not have to paste a code again, but the
 * launch code is minted per dsh web process, so remembering it would be useless.
 * What survives a restart is the session cookie's signing secret, so the host can
 * mint a fresh cookie for a device it recognises. This records the device's half
 * of that: a random key, kept in the app's own storage and never sent anywhere
 * except back to the host that issued it. The host keeps only a hash.
 */
(function () {
  'use strict';

  var win = typeof window === 'undefined' ? undefined : window;
  if (!win || typeof win.fetch !== 'function' || !win.indexedDB) return;

  var DB_NAME = 'dsh-pwa';
  var STORE = 'device';

  function label() {
    var ua = String((win.navigator && win.navigator.userAgent) || '');
    if (/Android/i.test(ua)) return /Chrome/i.test(ua) ? 'Android Chrome' : 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua)) return 'Windows';
    return 'Browser';
  }

  function open() {
    return new Promise(function (resolve) {
      var request = win.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
    });
  }

  open().then(function (db) {
    if (!db || !db.objectStoreNames.contains(STORE)) return;
    var read = db.transaction(STORE, 'readonly').objectStore(STORE).get('key');
    read.onsuccess = function () {
      if (typeof read.result === 'string' && read.result !== '') return;
      // The app is open, so this request carries a session the host accepts. The
      // host checks that for itself rather than trusting the caller.
      win.fetch('/dsh-pwa/device', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label() })
      }).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (granted) {
        if (!granted || typeof granted.key !== 'string') return;
        try {
          db.transaction(STORE, 'readwrite').objectStore(STORE).put(granted.key, 'key');
        } catch (err) {
          // Losing the write costs one more code prompt, never a broken app.
        }
      }).catch(function () {});
    };
    read.onerror = function () {};
  }).catch(function () {});
})();

/**
 * Android polish: stop the accidental reload, clear the bars we own, and keep
 * the device key through storage pressure.
 *
 * 1. `overscroll-behavior-y: contain` on the root. The shell sets this on its own
 *    inner scrollers (the confirmation sheet, wide tables, the JSON tree) but
 *    never on html or body, so a pull-down at the top of a transcript still
 *    reaches the browser - which in an installed Android app is Chrome's
 *    pull-to-refresh, reloading the whole document mid-conversation. Containing
 *    it on the root keeps that overscroll inside the app; it changes no scroller
 *    the shell already configured and never blocks in-page scrolling.
 *
 * 2. Safe areas, for what this plugin owns and nothing else. The harness's own
 *    CSS contains no env(safe-area-inset-*) rule at all, so declaring
 *    viewport-fit=cover would slide dsh's composer and header under the Android
 *    gesture and status bars with nothing on the other side to compensate. The
 *    one surface that IS ours - the back-guard toast - clears the inset itself.
 *    env() resolves to 0px while the viewport is fit=auto (the current state), so
 *    it is correct today and still correct if edge-to-edge is ever forced on the
 *    app.
 *
 * 3. Storage persistence. The device key is what stops the phone asking for a
 *    code again, and it lives in IndexedDB, which is evictable under storage
 *    pressure. persist() asks Chrome to exempt this origin; Chrome grants it
 *    without a prompt once the site is installed and engaged, so the call waits
 *    for the first real gesture instead of firing on load.
 */
(function () {
  'use strict';

  var win = typeof window === 'undefined' ? null : window;
  if (!win || !win.document) return;
  var doc = win.document;
  var nav = win.navigator || {};

  function addStyle(css) {
    if (!doc.head || typeof doc.createElement !== 'function') return;
    try {
      var el = doc.createElement('style');
      el.setAttribute('data-dsh-pwa', '');
      el.textContent = css;
      doc.head.appendChild(el);
    } catch (err) {
      // A document without a usable head keeps the browser's own overscroll.
    }
  }

  // 1. The reload guard.
  addStyle('html,body{overscroll-behavior-y:contain}');

  // 2. Persistence, asked once, on the first real gesture.
  function installStorage() {
    var storage = nav.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    if (typeof win.addEventListener !== 'function') return false;
    if (win.__dshPwaStorageAsked) return false;
    win.__dshPwaStorageAsked = true;

    function report(granted) {
      var state = { persisted: granted === true };
      win.__dshPwaStorage = state;
      if (typeof storage.estimate === 'function') {
        try {
          var estimate = storage.estimate();
          if (estimate && typeof estimate.then === 'function') {
            estimate.then(function (usage) {
              if (!usage) return;
              state.usage = usage.usage;
              state.quota = usage.quota;
            }).catch(function () {});
          }
        } catch (err) {
          // An estimate is a diagnostic; losing it changes nothing.
        }
      }
      if (typeof console !== 'undefined' && console.log) {
        console.log('[DSH PWA] storage persistence:', state.persisted ? 'granted' : 'denied');
      }
    }

    function ask() {
      try {
        var pending = storage.persist();
        if (pending && typeof pending.then === 'function') {
          pending.then(report, function () { report(false); });
          return;
        }
        report(pending);
      } catch (err) {
        report(false);
      }
    }

    var asked = false;
    function once() {
      if (asked) return;
      asked = true;
      ask();
    }
    for (var i = 0; i < 3; i++) {
      win.addEventListener(['pointerdown', 'keydown', 'touchstart'][i], once, { once: true, capture: true });
    }
    return true;
  }

  installStorage();
})();
