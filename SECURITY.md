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

## Updates

Security updates are released as patch versions. Update by pulling the latest from the repository.
