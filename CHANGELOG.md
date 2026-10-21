# Changelog

## 1.4.10

- A hold right after typing now sends. The composer treats Enter as part of the keyboard's
  composing state for a moment after text arrives and drops it without cancelling it, so the
  first hold on a page - typed, then held - could send nothing. The chord is now tried along
  a ladder of 30, 150 and 400 ms that outlives that window, stopping at the first attempt the
  composer takes and whenever the draft changed underneath it. The pill says `Sending…` while
  it works, names the mode when one lands, and only says `Not sent — hold again` when the
  ladder ends.
- Tapping the model chip no longer closes the keyboard. Cancelling the press was not
  enough: the browser focuses the chip about 10 ms after it, which on Android takes the
  keyboard with it. When a control in the composer card takes focus from the draft, the
  caret now goes straight back. The chips' menus do not take focus of their own, so nothing
  is closed; a field, a menu, a dialog, and a press made while the caret is elsewhere are
  left alone.
- Tests: 193.
- Client-side only: no restart, the phone picks it up on its next load.

## 1.4.9

- The keyboard now stays up through a hold. What closed it: 40 to 90 ms after the chord went
  out - about 395 ms after the touch - Chrome focuses the control under the finger, and on
  Android a focused button closes the keyboard the draft was holding. Nothing in the app did
  it, and preventing the menu cannot undo a focus that has already moved. Now the caret goes
  back to the draft when focus lands on a control in the card while the gesture's window is
  open, so the composer keeps the keyboard. A press well after the gesture keeps whatever
  focus the app gives it.
- Tests: 190.
- Client-side only: no restart, the phone picks it up on its next load.

## 1.4.8

- The confirmation pill now actually stays on screen. A press that had fired cleared
  it on the next `pointermove`, and a finger resting on a button reports those from its
  own tremor - so the pill was written and taken away within a frame, and the phone
  never showed one. Moving after the fire no longer touches it; the pill goes on its
  own timer, or when the next gesture replaces it.
- Tests: 189.
- Client-side only: no restart, the phone picks it up on its next load.

## 1.4.7

- The hold fires again on a real phone. Android's own long press opens its selection menu
  about 400 ms into a press on the Send button, takes the focus and drops the touch, and the
  gesture treated that as "the page went away" and cancelled - so a 400 ms hold lost the race
  by a few milliseconds on every attempt.
  - The window is now 300 ms, inside the tap the button owns and ahead of the menu.
  - A press that loses the page after 150 ms fires instead of cancelling: the finger has been
    down long enough to mean it.
  - The engine's menu is held off for 1.5 s after a hold fires, so it cannot land on the
    confirmation while the finger is still down.
- The pill now reports the outcome (Queued, Steering, Sent, or `Not sent — hold again`)
  instead of naming a mode, and stays for a moment after the finger lifts. It is created
  when the chord goes out, so it is no longer shown for a press that never fired.
- Tests: 189. New coverage for the fire-on-focus-loss path, the menu guard, and the
  unanswered-chord pill.
- Client-side only: no restart, the phone picks it up on its next load.

## 1.4.6

- The composer's keep-focus press no longer requires `document.activeElement` to name the
  draft. Android can hold a composer under an open keyboard that the DOM no longer reports
  as focused, so that check could go dark at the moment the press had to be kept. A field
  inside the card still takes its own press.
- Tests: 186.
- Client-side only: no restart, the phone picks it up on its next load.

## 1.4.5

- A pointer cancel no longer ends the hold. Chrome on Android cancels the pointer when its
  own long-press gesture claims the touch, and it does that while the keyboard is up -
  exactly the state queueing is for - so the gesture could die at the moment it mattered.
  A cancel that arrives with the finger still on the button (within `SLOP_PX` of where the
  press started) now lets the timer finish; a cancel that reports the finger somewhere else
  (a pan that started there) still ends it, and `pointerleave` still ends it outright.
- Tests: 185, up from 183.
- Client-only, so it reaches the app on its next load. The PWA blocks pull-to-refresh on
  purpose, so that has to be a real load: close it from recents and reopen, or reload from
  the browser's own menu.

## 1.4.4

- The keyboard stays for the whole composer card, not just for Send. Chromium focuses a
  button on press, and that default action blurred the draft, so a tap on the model chip,
  the permission mode or the microphone closed the keyboard under a press the user made
  to stay in the exchange. The press is now cancelled while the draft owns the caret
  (`mousedown`, capture): the app's own trick for the card's blank space
  (`client.js:18925`) and for Send (`client.js:18386`, `client.js:19129`), extended to
  the controls it deliberately leaves to the engine. Fields inside the card still take
  their own press, and a press with the keyboard down is untouched.
- A press inside the conversation also renews the window in which a focus call counts as
  the user's, so the app re-focusing the draft after such a press is no longer read as a
  programmatic focus and muted.
- The hold gesture queues even when the draft lost the caret. Its chord is dispatched at
  the editor the card holds when the hold completes, not the one captured as the finger
  went down (a re-render replaces the node), and it asks the composer fix for the caret
  back first, which un-quiets and focuses without muting the keyboard. Whether the
  composer took the chord is now read from the event itself - Lexical cancels every Enter
  it handles (`client.js:18243`) - and an ignored chord is retried once, 30ms later, on
  the same draft only. A pointer cancel that arrives after the fire (the browser's own
  long-press gesture, which cancels under a finger that is still down) no longer drops the
  click suppressor, so the release cannot submit a second time.
- Tests: 183, up from 174. Five pin the card's keep rule (a control press is cancelled
  while the draft has the caret, a field press is not, a press with nothing focused is
  not, a chat press renews the intent, and the hold's hook returns the caret without
  silencing the keyboard); four pin the chord's acknowledgement, its retry, the editor it
  is sent to, and the cancel-after-fire path.
- Both fixes are client-only: they reach the app on its next load, with no dsh restart.

## 1.4.3

- A tap on Send is a tap on Send again. The composer fix used to hide the keyboard on
  every press in the composer card, and 1.4.2 made that dismissal destructive: the app's
  height follows the keyboard now, so the composer slid down between `pointerdown` and
  `click`, the press landed where the button had been, and a send took two taps. The
  keyboard is dismissed only by a press that leaves the conversation - the session
  sidebar, the header's view tabs, Settings, all outside
  `[data-conversation-region]` (`client.js:17867`, `client.js:17859`). Presses in the
  chat - the transcript, a link, an attachment, and every composer button, Send
  included - leave it alone. A dismissal still marks the composer quiet, so a re-focus
  on the way back cannot raise the keyboard again.
- Hold the send button to queue. With **Send behavior while busy** set to *Steer*, a
  phone had no way to queue a message for a running turn: the button's mode is fixed
  when it renders (`primarySubmitMode`, `client.js:18951`), and the only other gesture is
  Cmd/Ctrl+Enter, which a soft keyboard cannot type. Holding that button for 400 ms now
  dispatches the composer's own accelerated chord (`client.js:18246`) at the editor, so
  the message takes the other busy mode - queue, on a Steer setup - while a tap keeps
  doing exactly what the button's label says. It arms only with draft text in the
  composer, which excludes the two states where that chord means something else: an
  empty composer turns the button into Stop (`client.js:18948`), and an empty composer
  with queued messages is the chord that steers every one of them
  (`client.js:18362`). Release, a slide past 10 px, a cancel, blur and backgrounding all
  end it, a 10 ms vibration marks the commit, and the click the same press would
  otherwise deliver is swallowed once so nothing sends twice.
- Tests: 174, up from 144. `test/mobile-queue.test.mjs` drives the hold gesture and its
  exclusions against a fake DOM (28 cases); `test/mobile-composer.test.mjs` pins the new
  dismissal rule - a press on Send or in the transcript keeps the keyboard, a press on
  the sidebar or Settings puts it away - and `test/host.test.mjs` pins the queue source as
  inlined verbatim before `</body>`.
- Both client scripts are host-injected, so they need a dsh restart before the shell
  carries them; after that the files themselves are read per request.

## 1.4.2

- The composer rises with the soft keyboard. The app is a `html,body,#root{height:100%}`
  column (`index-BxpfOGf3.css`) and the composer is its last flex item, so at 100% it sits
  at the bottom of the window - exactly where the keyboard opens. Neither `dvh` nor a CSS
  resize fixes that: Chromium has resized only the visual viewport since Chrome 108,
  Safari has never resized the layout viewport, and the dynamic viewport units follow the
  URL bar rather than the keyboard.
- On Android the host appends `interactive-widget=resizes-content` to the shell's
  existing `<meta name="viewport">` (`dsh-web-frontend/dist/index.html:5`). Chrome 108+
  honours the token, so the layout viewport shrinks when the keyboard opens, the composer
  rises with no script and the transcript loses the strip the keyboard covers. The token
  is Chromium only - WebKit has it implemented but unshipped - and the rewrite is a no-op
  when the tag already carries an `interactive-widget` value or the shell ships no
  viewport meta.
- On iOS Safari the same geometry comes from `src/mobile-keyboard.js`, inlined into the
  app HTML before `</body>`. While the keyboard is open it boxes `#root` to
  `visualViewport.height` at `visualViewport.offsetTop`, and removes the box and its two
  variables on dismissal. Following `offsetTop` as well as `height` is what keeps the
  composer above the keyboard when Safari pans the visible area to reveal a field instead
  of resizing it. The script also covers Chromium builds without the token: where the
  layout viewport already shrank, the measured gap is 0 and the script stays idle, so the
  two paths cannot double up.
- The script folds a burst of events into one animation frame, follows a `scroll`-only
  pan, does not treat a pinch zoom as a keyboard (a box already open stays where it is),
  ignores a visual viewport taller than the window and a covered strip under 120px, and
  restores the document scroll once on close (iOS leaves the document scrolled after
  revealing a field).
- Desktop is untouched: the script returns before adding a style or a listener unless
  `(pointer: coarse)` matches (`__DSH_FORCE_MOBILE_KEYBOARD__` is the test seam), and the
  viewport rewrite only changes a phone layout.
- **The token and the extra inline script are both host code, so they need a dsh
  restart** before the shell carries them. Once the host runs this version, the script
  file is read per request, so a later edit to it reaches the app on the next load
  without another restart.
- Tests: 144, up from 123. `test/mobile-keyboard.test.mjs` drives the script in `node:vm`
  against a fake visual viewport: closed, open, panned, zoomed with the box open,
  rubber-banded above the window, a gap too small to be a keyboard, a burst folded into
  one frame, close and reopen, load with the keyboard already open, and a second copy
  reusing the first stylesheet. `test/host.test.mjs` pins the viewport rewrite (token
  added once, not duplicated, no meta invented) and the verbatim inline injection.

## 1.4.1

- Device trust is diagnosable. A phone whose key was refused was left showing
  `Checking this device...` while the page's real verdict - "This device is no longer
  trusted" - was written into a line that already had text and silently dropped, so the
  failure looked like a hang. A verdict now replaces that transient line, and the
  diagnosis line carries the claim's own result (`the host answered 401 for this device
  key` versus `the host minted a cookie the fence refused`) plus how many devices the
  host has enrolled. Those two families of failure look identical on the phone and need
  different fixes.
- Every device decision the host makes is logged with the `[DSH PWA]` prefix:
  enrollment (including the evicted id once the list is full), a refused claim (with the
  key's length, an 8-character fingerprint of its hash, and the device count), an
  accepted claim, a forgotten device, and the auth probe's verdict. A fingerprint is not
  the key - it cannot be replayed - and it is what joins a refused claim to the
  enrollment that handed the key out. Neither the cookie value nor the signing secret is
  ever logged.
- **The route logging is host code, so it needs a dsh restart** before it appears. The
  sign-in page lives in the worker, which the host reads per request, so that half is
  live once the app reloads; the version bump is what makes an installed client fetch
  the new worker at all.
- Tests: 123, up from 122. The new case drives the device routes against a temporary
  home and asserts the log lines themselves: a refused claim names the key's
  fingerprint and the device count, an enrollment names its id and the resulting count,
  and the probe reports the verdict it published.

## 1.4.0

- Install card: the manifest now declares three phone-width `screenshots` (a
  conversation, the trajectory of a run, and the context panel), captured at 412x915
  with a device pixel ratio of 2, so Chrome has something to show in the richer install
  dialog instead of a bare name. They are served by a new `/screenshots` prefix route
  that opens a name only when a fresh listing of `public/screenshots` contains it, so no
  path can escape the directory. **A new route is host code, so this release needs a dsh
  restart** before the install card can fetch the images; the manifest itself is read
  per request, so until then the URLs 404 and Chrome falls back to the plain prompt.
- Android polish, all in the page client: the root scroller gets
  `overscroll-behavior-y: contain` - the app shell sets it only on inner scrollers, so a
  scroll that reached the top could still trigger Chrome's pull-to-refresh and reload
  the app mid-conversation. The plugin's own surface (the guard's toast) offsets by
  `env(safe-area-inset-bottom, 0px)`. `viewport-fit=cover` was deliberately NOT added:
  `safe-area-inset` appears nowhere in the frontend, so `cover` would slide dsh's own
  composer under the gesture bar with nothing compensating.
- Storage: on the first real gesture - never at load, once per page - the client asks for
  `navigator.storage.persist()` and records `{persisted, usage, quota}` on
  `window.__dshPwaStorage`, so Chrome is asked not to evict the cache and the device key
  behind "one sign-in per device".
- Tests: 121, up from 113. The route inventory and the HMR-dispose count include the new
  route, and the manifest suite reads each screenshot's own IHDR to check the advertised
  `sizes` and pins the hash of each reviewed capture.
- Note: there are no entries here for 1.2.0 - 1.3.1; those releases were tagged without
  one. This entry does not backfill them.

## 1.1.6

- Mobile composer: the on-screen keyboard no longer comes up for anything but a tap on
  the text area itself. Tapping **New session** raised it, because the composer
  re-focuses whenever the session changes, and so did every composer button — send,
  stop, `+`, model picker — because each passes its own `mousedown` on to the editor.
  On a phone that covered half the transcript. A `focus()` on an editor the user is
  not already in is now muted (`inputmode="none"` plus `virtualkeyboardpolicy="manual"`)
  and closed outright through the VirtualKeyboard API; a `focus()` on the editor they
  are typing in is left alone, because Lexical re-focuses its own root mid-sentence and
  silencing that would shut the keyboard while they type. After a send the composer is
  left quiet, so a stray second tap cannot raise the keyboard again until they tap the
  text area, which re-arms it inside the tap.
- Mobile composer: this is done by wrapping `HTMLElement.prototype.focus` for the
  composer subtree, and it is coarse-pointer only — a fine pointer installs nothing and
  desktop behaviour is untouched.
- README: the mute is Android only (iOS ignores both attributes), noted under
  Limitations.
- Confirmed on the device, 2026-10-07 on Android Chrome installed as an app: **New
  session** and **Send** no longer raise the keyboard, and a tap on the text area still
  opens it.

## 1.1.5

- Mobile composer: the diagnostic probe buttons, the plain `field` comparison
  editables and the trace panel are gone. They existed to close the Android
  clipboard-panel paste report, which 1.1.4 resolved and a device test confirmed, and
  they were shipping an overlay to every phone. Git history keeps them if a paste
  regression ever needs them again; a test now asserts the module carries no
  `data-dsh-pwa-probe` / `data-dsh-pwa-diagnostic` element.
- Mobile composer: the `origin` strings that only fed that trace went with it.
- README: the Android requirements for the keyboard's clipboard panel (install from
  Chrome; images need `chrome://flags/#enable-android-media-insertion`).

## 1.1.4

- Mobile composer: an insertion is measured instead of trusted. The composer
  answering `preventDefault` on the replayed paste was taken as proof that the text
  landed, so a paste that was accepted and then dropped (`ed=505` then `ed=0`) read
  as a success and was never retried; the text is now looked for in the editor and,
  when it did not stick, re-sent as a real `insertText` one macrotask later
- Mobile composer: the retry lands *after* the window the shipped Lexical opens with
  `handledSelectionCommandTimeoutId` (`client.js:212554`): while that window is open
  the next non-empty `insertText` is prevented and the selection is collapsed into a
  caret, which is what "Select all, then paste" ran into
- Mobile composer: our own replayed `insertText` is no longer claimed a second time
  by the bulk-paste rule, which would have replayed it in a loop
- Mobile composer: the ARMED line prints `build=`, so a screenshot of the diagnostic
  panel says which version of the fix produced it

## 1.1.3

- Service worker: an HTML navigation answered `401` by dsh's token fence is replaced
  by a sign-in page that performs the same `?token=` exchange, so an installed app
  (no address bar) is no longer a dead end; a rejected code is called out instead of
  silently redisplaying the page
- Service worker: pre-cache one URL at a time instead of `addAll`, so a signed-out
  client (which gets `401` for `/`) can still install a new worker — previously the
  update that could rescue it never activated
- README + SECURITY: document the fence, why the plugin's own routes bypass it, and
  what the sign-in page does and does not hold

## 1.1.2
## 1.1.2

- Cache names embed the package version: the host stamps it into `/sw.js` at serve time,
  so upgrading the plugin purges caches from older versions automatically instead of
  relying on a hand-bumped `vN` string
- Resilient pre-cache install: each URL is added on its own, so one missing asset can no
  longer reject the whole install and leave the worker redundant forever
- The worker bypasses DSH's dynamic routes registered outside `/api` (`/auth-api`,
  `/oauth`, `/open-in-app`, `/dsh-pwa`), keeping identity JSON, OAuth callbacks and the
  application catalog out of the cache
- Store guard: `5xx` navigations and any response marked `Cache-Control: no-store` are
  never cached, in both the HTML and the static branch
- The injected registration script reloads only on a genuine update: the first-install
  `clients.claim()` no longer bounces the first page load, and a repeated
  `controllerchange` reloads at most once
- npm metadata: `repository`, `bugs`, `homepage` and `engines` (Node >= 20); `keywords`
  expanded; `CHANGELOG.md` now ships in the package
- Mobile composer: a pasted block that arrives as one large `insertText` (Android
  keyboard clipboard panel) is replayed as a real paste; a block that arrives with no
  editable under it is recovered into the composer
- Mobile composer: Enter inserts a newline on coarse pointers instead of sending
- Manifest: `orientation` no longer forced, so the OS rotation lock is respected

## 1.1.1

- Fix `TypeError: Failed to execute 'put' on 'Cache': Request scheme 'chrome-extension' is unsupported` — skip non-HTTP(S) schemes early
- Add `safeCachePut()` wrapper to swallow cache errors gracefully
- Service worker cache names bumped to v4

## 1.1.0

- Proper maskable icons with 20% safe-zone inset (OS crop-safe for circles/squircles)
- Separate `any` + `purpose: maskable` icon entries in manifest (no longer combined)
- Icon generation rewritten: derives from official DSH whale SVG via sharp, outputs `icon-{192,512}{,-maskable}.png`
- Removed redundant `/favicon.svg` route — DSH's built-in favicon is now used as-is
- Service worker v3: pre-caches all four PNG icons alongside manifest + favicon
- Manifest tightened: dropped `shortcuts` (unused), cleaned categories
- Host plugin: longer cache TTL for icons (1 day), cleaner route registration
- Removed obsolete SVG icon files (icon-{192,512}.svg)

## 1.0.0

- Initial release
- Service worker with smart caching strategy (network-first for HTML, cache-first for static)
- PWA manifest with DeepSeek icons and metadata
- Automatic silent updates (no confirm dialog)
- Offline fallback page for disconnected state
- Icon serving routes (SVG + PNG)
- `webServer.tapIndex()` injection for SW registration
- Verification script (`scripts/verify.js`)
- Icon generation script (`scripts/generate-icons.js`)
- Modern installation via `file:` dependency
