# Changelog

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

- Mobile composer: a pasted block that arrives as one large `insertText` (Android
  keyboard clipboard panel) is replayed as a real paste; a block that arrives with no
  editable under it is recovered into the composer
- Mobile composer: Enter inserts a newline on coarse pointers instead of sending
- Mobile composer: an armed diagnosis overlay (probe buttons + `sel`/`bi`/`mut` trace)
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
