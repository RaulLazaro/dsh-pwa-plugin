# DSH PWA Plugin

PWA plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) that adds offline support and install-as-app capability.

## Features

- **Service Worker** with smart caching strategy
- **PWA Manifest** with proper maskable icons
- **Automatic updates** — silently activates new versions
- **Offline-first** for static assets
- **Sign in from inside the app** — a locked-out navigation shows a code box instead of dsh's plain-text 401
- **Mobile composer fix** — on a phone, Enter inserts a newline instead of sending, and a paste whose payload the composer cannot see is recovered (from the clipboard API, or replayed from the one `insertText` the Android keyboard's clipboard panel sends)
- **Keyboard stays down** — on a phone the on-screen keyboard only opens for a tap on
  the text area itself, so **New session** and **Send** stop covering the transcript
  with it (Android; the reason is under [Limitations](#limitations))
- **Official DSH whale icon** — derived from the upstream SVG favicon

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

## Android

Install the app from **Chrome** (⋮ menu → *Install app*, or *Add to Home screen*).
Samsung Internet cannot host it: it has no flags UI, and the option below needs one.

The composer fix covers the clipboard panel of an Android keyboard (the panel that
opens from the clipboard icon above the keys):

- **Text** from that panel needs no setup. The block arrives with no paste event at
  all, which is why it used to vanish; the fix notices the oversized `insertText`,
  replays it as a real paste, and then checks the text actually reached the editor.
- **Image** from that panel needs a Chromium feature that is off by default. In the
  same Chrome profile, open `chrome://flags/#enable-android-media-insertion`, set it
  to **Enabled**, and restart Chrome. With the flag off, the panel's image item is
  greyed or crossed out and the page receives nothing — that is the browser's gate,
  not the app's. A long-press *Paste* of an image is a separate route (the fix reads
  it with `navigator.clipboard.read()`) and does not need the flag.
- Chrome updates can reset flags. If image paste from the panel stops working after
  an update, check that flag before anything else.

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

1. The host plugin serves `/sw.js`, `/manifest.webmanifest`, and icon files
2. It injects a service worker registration script into the HTML
3. The service worker caches static assets (including icons) for offline use
4. The manifest enables installing the app as a PWA
5. Updates are detected automatically and silently activated
6. DSH's built-in `/favicon.svg` is used as-is (not overridden)
7. A locked-out HTML navigation is replaced by the worker's sign-in page (see below)

## Signing in from inside the app (the dsh token fence)

dsh web fences its own HTML behind a launch-token exchange: `GET /?token=<code>`
answers `303` with a signed session cookie (its name is derived from the host), and
anything else gets `401 dsh web authentication required` as plain text. A browser
passes the code in the address bar; an installed app has no address bar, so without
this plugin the fence body is a dead end.

The worker closes that hole. An HTML navigation answered `401` is replaced by a
sign-in page (`X-DSH-PWA-Signin: 1`, never cached) that accepts the code — or the
whole URL carrying `?token=` — and repeats the same exchange.

- The code is the one dsh prints once at startup (`dsh web: http://.../?token=<code>`),
  and it rotates on every `dsh web` restart. On this machine `dshw-token.ps1`
  prints the current one.
- The cookie is signed with a persistent browser-session credential, not the
  per-process launch token (`dsh-client-connection`, `BrowserAuth`), so a signed-in
  app survives `dsh web` restarts. Only the code rotates.
- The cookie is bound to the authority it was minted for: sign in at the same host
  and port the app was installed from.
- Pre-caching is per URL, not `addAll`, so a client that is signed out (and therefore
  gets a `401` for `/`) can still install a new worker — otherwise the one worker that
  could rescue it would never activate.

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
- The app document stays behind dsh's token fence, and the plugin's own routes
  (`/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/dsh-pwa/version`) are not fenced —
  exact routes registered through `webServer.register` bypass it (measured 2026-10-07:
  those paths answer `200` with no cookie while `/` answers `401`). That is what makes
  the app installable at all, and it is why the sign-in page can reach an
  unauthenticated client. It exposes only static assets.
- The worker's sign-in page can only help a client that has a worker installed, which
  needs one successful page load in that browser first. A brand-new install in a
  browser that has never signed in still needs one signed-in page load there (the
  printed URL), after which every launch is covered.
- Image paste from an Android keyboard's clipboard panel needs the Chromium flag
  described under [Android](#android). Chrome updates can reset flags, so a
  crossed-out image item is the first thing to check if that ever regresses.
- The keyboard mute in the mobile composer fix is Android only. It rides on
  `inputmode="none"` and `virtualkeyboardpolicy="manual"`, which iOS Safari ignores, and
  the `focus()` wrapper is installed only for a coarse pointer. On an iPhone the
  keyboard still comes up for **New session** and **Send**; closing it there needs a
  different lever (a blur instead of a mute), which is not written yet.

## Project Structure

```
dsh-pwa-plugin/
├── src/
│   ├── host/
│   │   └── index.js          # Host plugin (Node.js)
│   ├── mobile-composer.js    # The mobile composer fix (inlined into the app HTML)
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
  install/activate cache lifecycle (including an install where a pre-cache URL
  fails), the bypass rules (non-GET, non-HTTP schemes, `/api`, `/plugins`, `/ws`,
  `/hooks`, websocket upgrades), network-first HTML with its offline fallbacks,
  the `401` to sign-in-page replacement, cache-first statics with the 200/basic
  cache guard, and the `GET_VERSION` / `SKIP_WAITING` messages.
- `test/mobile-composer.test.mjs` — the mobile composer fix against a fake DOM:
  Enter inserts a newline on a coarse pointer while the slash and reference menus
  keep it, a payload-less `beforeinput` falls back to `navigator.clipboard.readText()`
  and then `read()`, one oversized `insertText` is replayed as a real paste exactly
  once (and the retry is not claimed a second time), a paste carrying markup is
  normalised to its plain text, a paste with no editable under it lands in the editor
  last typed in, an insertion the editor drops is measured and re-sent exactly once,
  a programmatic focus of a composer the user is not in is muted and then dismissed
  while a focus on the one they are typing in is left alone, a tap on the text area
  re-arms the keyboard where a tap on any other composer button closes it, and the
  module ships no diagnostic overlay.
- `test/host.test.mjs` — route registration (sw, manifest, 4 icons, version),
  response headers, the index-HTML script injection, and the effect cleanup
  used on HMR unmounts.

## License

MIT
