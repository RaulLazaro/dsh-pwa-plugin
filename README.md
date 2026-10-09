# DSH PWA Plugin

PWA plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) that adds offline support and install-as-app capability.

## Features

- **Service Worker** with smart caching strategy
- **PWA Manifest** with proper maskable icons
- **Automatic updates** — new versions activate silently and reload the page exactly once (a first-ever visit never reloads)
- **Versioned caches** — cache names carry the package version, so upgrading the plugin purges stale caches automatically
- **Offline-first** for static assets
- **Official DSH whale icon** — derived from the upstream SVG favicon

## Installation

### 1. Add as a dependency

From npm (once published):

```bash
npm install dsh-pwa-plugin
```

Or, for a local checkout, in your DSH web profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-pwa-plugin": "file:~/workspace/dsh-pwa-plugin"
  }
}
```

### 2. Register the plugin

In your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-pwa
      name: 'dsh-pwa-plugin'
```

### 3. Restart DSH

```bash
dsh web
```

## Generate PNG Icons

The plugin ships pre-built PNG icons. To regenerate (requires [sharp](https://sharp.pixelplumbing.com/)):

```bash
cd dsh-pwa-plugin
node scripts/generate-icons.js
```

This reads the official `public/favicon.svg` and produces:

| File | Size | Purpose |
|------|------|---------|
| `icon-192.png` | 192×192 | Regular (any) |
| `icon-192-maskable.png` | 192×192 | Maskable (20% safe zone) |
| `icon-512.png` | 512×512 | Regular (any) |
| `icon-512-maskable.png` | 512×512 | Maskable (20% safe zone) |

## How It Works

1. The host plugin serves `/sw.js` (stamped with the package version), `/manifest.webmanifest`, and icon files
2. It injects a service worker registration script into the HTML
3. The service worker pre-caches static assets (one failing URL never aborts the install) and caches them for offline use
4. The manifest enables installing the app as a PWA
5. Updates are detected automatically and silently activated; the page reloads once per update
6. DSH's built-in `/favicon.svg` is used as-is (not overridden)

## Caching Strategy

| Resource Type | Strategy | Description |
|---------------|----------|-------------|
| HTML | Network-first | Always fetches the latest version; only storable `200` responses become the offline fallback |
| JS/CSS/Fonts/Images | Cache-first | Kept in a cache named after the package version, so an upgrade invalidates it without a manual version bump |
| Dynamic DSH routes | Not intercepted | `/api`, `/auth-api`, `/oauth`, `/open-in-app`, `/plugins`, `/ws`, `/hooks` and `/dsh-pwa` always reach the network |
| `Cache-Control: no-store` | Never cached | The server's directive wins over the service worker |
| API/WebSocket | Not cached | Always goes to the network |

## Limitations

- Requires HTTPS to work (except localhost)
- Service worker cannot cache API calls
- Updates require a page reload (automatic after detection)

## Project Structure

```
dsh-pwa-plugin/
├── src/
│   ├── host/
│   │   └── index.js          # Host plugin (Node.js)
│   └── sw.js                 # Service Worker
├── public/
│   ├── manifest.webmanifest  # PWA Manifest
│   ├── favicon.svg           # DSH whale icon (same as upstream)
│   └── icons/                # PWA icons (maskable + regular)
├── scripts/
│   ├── generate-icons.js     # Icon generator (sharp)
│   ├── install.js            # Verification script
│   └── verify.js             # Verification
├── cordis.patch.yml          # Plugin registration
├── LICENSE
└── package.json
```

## Testing

```bash
npm test
```

Zero-dependency suite on Node's built-in runner (`node --test`):

- `test/manifest.test.mjs` — manifest required fields, icon densities (regular +
  maskable at 192/512) and that every icon file exists on disk.
- `test/sw.test.mjs` — the service worker evaluated against a fake `self`:
  install/activate cache lifecycle (per-URL resilient pre-cache, versioned
  cache names, orphan cleanup), the bypass rules (non-GET, non-HTTP schemes,
  `/api`, `/auth-api`, `/oauth`, `/open-in-app`, `/plugins`, `/ws`, `/hooks`,
  `/dsh-pwa`, websocket upgrades), network-first HTML with its offline
  fallbacks, cache-first statics with the store guard (`200`/`basic`/
  `no-store`), and the `GET_VERSION` / `SKIP_WAITING` messages.
- `test/host.test.mjs` — route registration (sw, manifest, 4 icons, version),
  response headers, the package-version stamping of `/sw.js`, the
  index-HTML script injection, the registration script's reload guard
  (executed in a sandboxed VM), and the effect cleanup used on HMR unmounts.

## License

MIT
