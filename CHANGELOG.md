# Changelog

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
