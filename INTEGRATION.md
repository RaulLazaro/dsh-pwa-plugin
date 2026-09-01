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
| Static assets | Cache-first | Serves from cache if available, otherwise fetches |
| API/WebSocket | Passthrough | Never cached, always goes to network |

### Update Flow

1. The injected script calls `reg.update()` every hour
2. When the service worker detects a new version, it activates silently
3. On `controllerchange`, the page auto-reloads with the new version

## Custom Icons

### Generate PNGs from SVG

```bash
cd dsh-pwa-plugin
npm install sharp --save-dev
node scripts/generate-icons.js
```

### Use your own icons

1. Replace files in `public/icons/`:
   - `icon-192.png` and `icon-512.png` (required)
   - `icon-192.svg` and `icon-512.svg` (optional)
2. Update `public/manifest.webmanifest` if you change filenames

## Verification

```bash
node scripts/verify.js
```

Checks that all required files exist and the manifest is valid.

## Troubleshooting

### Service worker doesn't register

- Ensure HTTPS is used (localhost is exempt)
- Check browser console for errors
- Verify `/sw.js` is accessible via `curl http://localhost:3079/sw.js`

### Icons don't appear

- Check `public/icons/` for the PNG files
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
