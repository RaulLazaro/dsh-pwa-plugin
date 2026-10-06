# Security Policy

## Reporting

If you discover a security vulnerability in this plugin, please report it responsibly by opening a GitHub issue with the `security` label.

## Scope

This plugin serves static files (service worker, manifest, icons) and injects two inline `<script>` blocks into the HTML. It does not:

- Handle user authentication
- Process sensitive data
- Make external network requests
- Execute code supplied by a request

## Service Worker Security

- Only `GET` requests are intercepted, and only responses that are same-origin with status 200 are cached (`src/sw.js`, the `fetch` handler)
- Requests under `/api`, `/plugins`, `/ws` and `/hooks`, non-`http(s)` schemes, and WebSocket upgrades bypass the worker entirely (`src/sw.js`)
- The worker is served from `/sw.js` and registered with scope `/`, so it controls the whole origin. Only one worker may own a scope; this plugin is that owner.

## Injected Scripts

The plugin appends two inline `<script>` blocks to `index.html` (`src/host/index.js`, section 4): the service-worker registration and the mobile composer fix. Inline script requires `script-src 'unsafe-inline'`, a nonce, or a hash if a Content-Security-Policy is set; a policy that forbids inline script will break both.

The composer fix is inlined rather than served as a separate file on purpose: the worker answers non-HTML `GET`s cache-first, so an external script would be pinned to its first version.

## Updates

Security updates are released as patch versions. Update by pulling the latest from the repository.
