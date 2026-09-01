# DSH PWA Plugin

PWA plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) that adds offline support and install-as-app capability.

## Features

- **Service Worker** with smart caching strategy
- **PWA Manifest** with icons and metadata
- **Automatic updates** — silently activates new versions
- **Offline-first** for static assets
- **Custom icons** (gradient background with DSH branding)

## Installation

### 1. Add as a dependency

In your DSH web profile's `package.json`:

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

The plugin ships with SVG icons. To generate PNG icons (required for some browsers):

```bash
cd dsh-pwa-plugin
npm install sharp --save-dev
node scripts/generate-icons.js
```

## How It Works

1. The host plugin serves `/sw.js`, `/manifest.webmanifest`, and icon files
2. It injects a service worker registration script into the HTML
3. The service worker caches static assets for offline use
4. The manifest enables installing the app as a PWA
5. Updates are detected automatically and silently activated

## Caching Strategy

| Resource Type | Strategy | Description |
|---------------|----------|-------------|
| HTML | Network-first | Always tries to fetch the latest version |
| JS/CSS/Fonts/Images | Cache-first | Serves from cache if available |
| API calls | Not cached | Always goes to the network |

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
│   ├── favicon.svg           # Favicon
│   └── icons/                # App icons (SVG + PNG)
├── scripts/
│   ├── generate-icons.js     # Icon generator
│   ├── install.js            # Verification script
│   └── verify.js             # Verification
├── example/
│   ├── cordis.patch.yml      # Configuration example
│   └── package.json          # Profile example
├── cordis.patch.yml          # Plugin registration
├── LICENSE
└── package.json
```

## License

MIT
