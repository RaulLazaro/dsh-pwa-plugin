# Changelog

## 1.1.2

- Cache names now embed the package version: the host stamps it into `/sw.js` at serve time, so upgrading the package purges caches from older versions automatically (no more hand-bumped `vN` strings)
- Resilient pre-cache install: each URL is added individually, so one missing asset can no longer reject the atomic `cache.addAll` and leave the worker redundant forever
- Service worker now bypasses DSH's dynamic routes registered outside `/api` (`/auth-api`, `/oauth`, `/open-in-app`, `/dsh-pwa`), keeping identity JSON, OAuth callbacks and the application catalog out of the cache
- Strict store guard: `5xx` navigations and any response marked `Cache-Control: no-store` are never cached (both HTML and static branches)
- Injected registration script reloads only on genuine updates: the first-install `clients.claim()` no longer bounces the first page load, and duplicate `controllerchange` events reload at most once
- npm metadata: `repository`, `bugs`, `homepage` and `engines` (Node >= 20) added; `keywords` expanded; `CHANGELOG.md` now ships in the package
- Tests: 26 -> 35 (`node --test test/*.mjs`)

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
