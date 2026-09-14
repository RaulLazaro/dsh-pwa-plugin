# Changelog

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
