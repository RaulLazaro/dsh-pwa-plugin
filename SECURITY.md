# Security Policy

## Reporting

If you discover a security vulnerability in this plugin, please report it responsibly by opening a GitHub issue with the `security` label.

## Scope

This plugin serves static files (service worker, manifest, icons) and injects a registration script into the HTML. It does not:

- Handle user authentication
- Process sensitive data
- Make external network requests
- Execute arbitrary code

## Service Worker Security

- The service worker only caches GET requests
- API calls (`/api/*`, `/ws/*`) are never cached
- The iframe sandbox restricts capabilities to `allow-scripts allow-same-origin allow-forms allow-popups`

## The dsh token fence

dsh web authenticates browser sessions itself (``dsh-client-connection``, class
``BrowserAuth``): ``GET /?token=<code>`` exchanges the per-run launch token for a signed
cookie, and other document requests answer a plain-text ``401``. The plugin does not
participate in that check and cannot mint a session; what it does is serve a replacement page
for the ``401`` an HTML navigation receives, so an installed app - which has no address bar -
has somewhere to type the code. That page:

- holds no credential and stores none; the code the user pastes is put into ``/?token=<code>``
  exactly as the URL dsh prints would be,
- is never cached, carries ``Cache-Control: no-store``, and is marked ``X-DSH-PWA-Signin: 1``,
- is only reached with a ``401``; a normal response passes through untouched.

Worth knowing (measured 2026-10-07): the plugin's own routes - ``/sw.js``,
``/manifest.webmanifest``, ``/icons/*``, ``/dsh-pwa/version`` - are **not** behind the fence,
because exact routes registered through ``webServer.register`` bypass it. They answer ``200``
to an unauthenticated request while ``/`` answers ``401``. Those paths expose only static
assets, the worker, the manifest and icons; the app document stays fenced. Do not move data a
fenced user should not see onto those routes.

## Updates

Security updates are released as patch versions. Update by pulling the latest from the repository.
