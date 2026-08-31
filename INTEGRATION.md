# PWA Plugin Integration in DSH

## Plugin Structure

```
dsh-pwa-plugin/
├── src/
│   ├── host/
│   │   └── index.js          # Host plugin (Node.js)
│   └── sw.js                 # Service Worker
├── public/
│   ├── manifest.webmanifest  # PWA Manifest
│   ├── favicon.svg           # Favicon (DeepSeek whale)
│   └── icons/                # Generated icons
├── scripts/
│   ├── generate-icons.js     # Icon generator
│   ├── install.js            # Installation script
│   └── verify.js             # Verification
├── example/
│   ├── cordis.patch.yml      # Configuration example
│   └── package.json          # Package.json example
└── package.json
```

## Quick Start

### 1. Copy the plugin

```bash
# Option A: Copy directly
cp -r dsh-pwa-plugin ~/.dsh/plugins/

# Option B: Create symlink (recommended for development)
ln -s /path/to/dsh-pwa-plugin ~/.dsh/plugins/dsh-pwa-plugin
```

### 2. Install dependencies

```bash
cd ~/.dsh/plugins/dsh-pwa-plugin
npm install  # Only if you need to generate PNG icons with sharp
```

### 3. Configure the web profile

#### In the profile's `package.json`:

```json
{
  "name": "dsh-web",
  "dependencies": {
    "dsh-pwa-plugin": "file:~/.dsh/plugins/dsh-pwa-plugin"
  }
}
```

#### In the profile's `cordis.patch.yml`:

```yaml
# Add to the end of the file
- insert:
    - id: pwa
      name: 'dsh-pwa-plugin'
```

### 4. Restart DSH

```bash
dsh web
```

## Advanced Configuration

### Plugin Options

The plugin supports the following options in `cordis.patch.yml`:

```yaml
- id: pwa
  name: 'dsh-pwa-plugin'
  config:
    # Enable offline cache (default: true)
    enableOfflineCache: true

    # Enable install prompt (default: true)
    enableInstallPrompt: true

    # Update check interval in ms (default: 3600000)
    updateIntervalMs: 3600000
```

### Custom Icons

To use custom icons:

1. Place your PNG icons in `public/icons/`
2. Name the files `icon-192.png` and `icon-512.png`
3. Update `manifest.webmanifest` if needed

### Generate PNG Icons

If you need to generate PNG icons from SVG:

```bash
cd ~/.dsh/plugins/dsh-pwa-plugin
npm install sharp
node scripts/generate-icons.js
```

## How It Works

### Installation Flow

1. **Plugin Load**: DSH loads the host plugin during boot
2. **Script Injection**: The plugin injects the registration script into the HTML
3. **Service Worker Registration**: The browser registers the service worker
4. **Asset Caching**: The service worker caches static assets
5. **PWA Ready**: The app is ready for installation and offline use

### Caching Strategy

| Resource Type | Strategy | Description |
|---------------|----------|-------------|
| HTML | Network-first | Always tries to fetch the latest version |
| JS/CSS/Fonts | Cache-first | Serves from cache if available |
| Images | Cache-first | Cached for fast loading |
| API calls | No cache | Always goes to the network |

### Updates

1. The service worker checks for updates every hour
2. When an update is detected, it shows a dialog to the user
3. If the user accepts, the page reloads with the new version
4. New assets are cached automatically

## Troubleshooting

### Service worker doesn't register

- Make sure you're using HTTPS (except localhost)
- Check the browser console for errors
- Ensure the `/sw.js` file is accessible

### Icons don't appear

- Verify that icons exist in `public/icons/`
- Check `manifest.webmanifest` to ensure paths are correct

### App can't be installed

- Verify that the manifest is valid
- Ensure the service worker is registered
- Chrome requires the app to meet installation criteria

## Development

### Code Structure

- `src/host/index.js`: Host plugin that handles script injection
- `src/sw.js`: Service Worker for offline caching
- `public/manifest.webmanifest`: PWA Manifest

### Testing

```bash
# Verify installation
node scripts/verify.js

# Generate icons
node scripts/generate-icons.js
```

### Debugging

1. Open the browser DevTools
2. Go to the "Application" tab
3. Check "Service Workers" for registration status
4. Check "Manifest" for PWA configuration

## License

MIT
