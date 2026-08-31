# DSH PWA Plugin

PWA plugin for DeepSeek Harness that adds offline support and install-as-app capability.

## Features

- **Service Worker** with smart caching strategy
- **PWA Manifest** with icons and metadata
- **Automatic updates** with user notification
- **Offline-first** for static assets
- **Official DeepSeek icons** (whale on black background)

## Installation

### Option 1: Local plugin

```bash
# Copy the plugin to the DSH plugins directory
cp -r dsh-pwa-plugin ~/.dsh/plugins/

# Or create a symlink
ln -s /path/to/dsh-pwa-plugin ~/.dsh/plugins/dsh-pwa-plugin
```

### Option 2: Use with the web profile

Add to your web profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-pwa-plugin": "file:../dsh-pwa-plugin"
  }
}
```

And in `cordis.patch.yml`:

```yaml
- insert:
    - id: pwa
      name: 'dsh-pwa-plugin'
```

## Generate PNG Icons

To generate the PNG icons required by the manifest:

```bash
npm install sharp --save-dev
node scripts/generate-icons.js
```

## How It Works

1. The host plugin injects a service worker registration script into the HTML
2. The service worker caches static assets for offline use
3. The manifest enables installing the app as a PWA
4. Updates are detected automatically

## Caching Strategy

- **HTML**: Network-first (always tries to fetch the latest version)
- **Static assets** (JS, CSS, fonts, images): Cache-first (serves from cache if available)
- **API calls**: Not cached (always goes to the network)

## Limitations

- Requires HTTPS to work (except localhost)
- Service worker cannot cache API calls
- Updates require a page reload

## License

MIT
