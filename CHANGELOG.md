# Changelog

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
