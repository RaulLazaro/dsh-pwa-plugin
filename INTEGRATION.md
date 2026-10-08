# PWA Plugin Integration in DSH

## Quick Start

### 1. Add the dependency

In your DSH web profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-pwa-plugin": "file:~/workspace/dsh-pwa-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-pwa-plugin"
      ]
    }
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

## How It Works

### Plugin Loading

1. DSH loads the host plugin during boot via the `cordis.patch.yml` insert
2. The plugin registers routes on the web server for `/sw.js`, `/manifest.webmanifest`, and icon files
3. It uses `webServer.tapIndex()` to inject a service worker registration script into the HTML
4. The browser registers the service worker and begins caching assets

### Service Worker Strategy

| Request Type | Strategy | Details |
|-------------|----------|---------|
| HTML pages | Network-first | Fetches from network first, falls back to cache |
| Static assets | Cache-first | Served from a cache named after the package version (purged automatically on upgrade) |
| `/api`, `/auth-api`, `/oauth`, `/open-in-app`, `/plugins`, `/ws`, `/hooks`, `/dsh-pwa` | Passthrough | DSH's dynamic routes are never intercepted or cached |
| `Cache-Control: no-store` | Passthrough | The server's directive wins; the response is never stored |
| Other API/WebSocket | Passthrough | Never cached, always goes to network |

### Update Flow

1. The injected script calls `reg.update()` every hour
2. When the service worker detects a new version, it activates silently
3. On `controllerchange`, the page reloads once to pick up the new version —
   the very first install claims the page without reloading it, so a visitor's
   first load is never bounced, and duplicate events never reload twice
4. Cache names embed the package version (stamped into `/sw.js` when it is
   served), so upgrading the plugin purges the previous version's caches on
   activation without a manual version bump

## Icons

The plugin ships with 4 pre-built PNG icons derived from the official DSH whale SVG:

| File | Size | Purpose | Notes |
|------|------|---------|-------|
| `icon-192.png` | 192×192 | Any | 90% safe zone |
| `icon-192-maskable.png` | 192×192 | Maskable | 80% safe zone (20% inset) |
| `icon-512.png` | 512×512 | Any | 90% safe zone |
| `icon-512-maskable.png` | 512×512 | Maskable | 80% safe zone (20% inset) |

Maskable icons have a 20% safe-zone inset so the OS can crop them into circles, squircles, etc. without clipping the whale logo.

### Regenerate Icons

Requires [sharp](https://sharp.pixelplumbing.com/):

```bash
node scripts/generate-icons.js
```

### Use Your Own Icons

1. Replace files in `public/icons/`:
   - `icon-192.png` and `icon-512.png` (regular, required)
   - `icon-192-maskable.png` and `icon-512-maskable.png` (maskable, required)
2. Update `public/manifest.webmanifest` if you change filenames

## Verification

```bash
node scripts/verify.js
```

Checks that all required files exist, the manifest is valid, and icon variants are present.

## Troubleshooting

### Service worker doesn't register

- Ensure HTTPS is used (localhost is exempt)
- Check browser console for errors
- Verify `/sw.js` is accessible via `curl http://localhost:3079/sw.js`

### Icons don't appear

- Check `public/icons/` for all 4 PNG files
- Verify `manifest.webmanifest` paths are correct
- Run `node scripts/generate-icons.js` to regenerate

### App can't be installed

- Verify manifest is valid (Chrome DevTools → Application → Manifest)
- Ensure service worker is registered
- Chrome requires HTTPS and valid manifest for install prompt

## Debugging

1. Open browser DevTools
2. Go to **Application** tab
3. Check **Service Workers** for registration status
4. Check **Manifest** for PWA configuration
5. Check **Cache Storage** for cached assets

## License

MIT
