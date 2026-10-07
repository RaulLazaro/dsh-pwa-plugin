# DSH PWA Plugin

PWA plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) that adds offline support and install-as-app capability.

## Features

- **Service Worker** with smart caching strategy
- **PWA Manifest** with proper maskable icons
- **Automatic updates** — silently activates new versions
- **Offline-first** for static assets
- **Sign in from inside the app** — a locked-out navigation shows a code box instead of dsh's plain-text 401
- **One sign-in per device** — a device that signed in once keeps a key of its own and
  renews its own session, so the launch code is needed once, not on every launch
- **Swipe-back guard** — an Android edge swipe no longer throws you out of the app
  mid-conversation; a second swipe inside two seconds still leaves, deliberately
- **Mobile composer fix** — on a phone, Enter inserts a newline instead of sending, and a paste whose payload the composer cannot see is recovered (from the clipboard API, or replayed from the one `insertText` the Android keyboard's clipboard panel sends)
- **Keyboard stays down** — on a phone the on-screen keyboard only opens for a tap on
  the text area itself, so **New session** and **Send** stop covering the transcript
  with it (Android; the reason is under [Limitations](#limitations))
- **DSH mark icon set** — the official mark as a white silhouette on dsh's dark
  neutral ground (the `#151517` base and `#f9fafb` label colour the app UI itself
  uses), for the app icon, the favicon and the apple touch icon, with a maskable
  variant and a single-colour silhouette for the manifest's `monochrome` slot

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
| `icons/icon.svg` | 50×50 viewBox | Transparent whale mark, scalable |
| `icons/icon-maskable.svg` | 50×50 viewBox | Maskable source |
| `icons/icon-monochrome.svg` | 50×50 viewBox | Single-colour silhouette (manifest `monochrome`) |
| `icons/icon-32.png` | 32×32 | Favicon |
| `icons/icon-192.png` | 192×192 | Regular (any) |
| `icons/icon-512.png` | 512×512 | Regular (any) |
| `icons/icon-192-maskable.png` | 192×192 | Maskable (20% safe zone) |
| `icons/icon-512-maskable.png` | 512×512 | Maskable (20% safe zone) |
| `apple-touch-icon.png` | 180×180 | iOS home screen |
| `favicon.ico` | 16/32/48 | Classic favicon; PNG entries packed by hand, no dependency |

### After regenerating: bump the icon revision

Every icon URL in the manifest carries a `?rev=` query, and that is not cosmetic. Chrome
treats the manifest's `icons` array as effectively `Cache-Control: immutable`: when the
field is unchanged it does not download the icon bytes again, so artwork regenerated under
the same URL never reaches anyone who already installed the app. The home-screen icon and
the header of every notification keep the old art, and no amount of restarting the server
changes that. Changing the URL is Chrome's documented trigger for an icon update, so a
regeneration is three edits together:

1. bump `ICON_REV` in `test/manifest.test.mjs`,
2. bump the `?rev=` on all six `src` entries in `public/manifest.webmanifest`,
3. refresh the `ARTWORK` hash map in that test from the newly generated files.

`test/manifest.test.mjs` fails if the set carries two different revisions, and fails again
when the bytes on disk stop matching the map - which is what forces the bump next time.
The manifest is read from disk per request, so this needs no restart, and the phone picks
the new URL up through the normal web-app update. Background:
[Chrome's web app update guidance](https://developer.chrome.com/blog/improvements-to-web-app-updates).

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

## Trusted devices (sign in once)

The code rotates with every `dsh web` process, so remembering it would be useless.
The session cookie is the opposite: it is signed with a credential that survives
restarts, but it is bound to one host and port and the app has no way to obtain a new
one once it is gone. That is the whole reason a phone asks again.

A device key closes it:

1. While the app is open and signed in it asks the host for a device key
   (`POST /dsh-pwa/device`) and stores it in the app's own IndexedDB. The host keeps
   only a SHA-256 hash of it.
2. When the app is later locked out, the sign-in page finds the key and offers it
   (`POST /dsh-pwa/device/claim`). The host mints a fresh session cookie using dsh's
   own contract — same name, same payload, same signature, signed with the durable
   browser-session secret — and the page then confirms it through the host's own probe
   (`GET /dsh-pwa/auth-state` with `x-dsh-pwa-probe: 1`), which reports `cookieValid`
   from the same check the fence uses. A page-side `fetch('/')` cannot answer that
   question: it sends `accept: */*`, so the fence serves the app shell and never
   exercises the HTML branch. The page redirects only once the probe reports a valid
   cookie.
3. Only if that fails does the page fall back to the code box.

A device key is a durable credential, so enrollment requires an existing session: the
route checks the cookie itself, because the fence gates only the index document. The
key is compared in constant time, only its hash is stored, and at most 10 devices are
kept. **Forget this device** on the sign-in page drops the key; the host-side record
can be dropped with `POST /dsh-pwa/device/forget`. If dsh ever changes its cookie
contract the mint fails closed — the phone is asked for a code, exactly as before.

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
- The installed launcher icon is baked at install. Chrome will not re-download icon bytes
  while the manifest's `icons` field is unchanged, so regenerated artwork needs a new icon
  URL (the `?rev=` query) before an app that is already installed shows it; see
  [After regenerating](#after-regenerating-bump-the-icon-revision). The server can serve
  the new art correctly and the phone will still show the old icon until that URL moves.
- The app document stays behind dsh's token fence, and the plugin's own routes
  (`/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/dsh-pwa/version`) are not fenced —
  exact routes registered through `webServer.register` bypass it (measured 2026-10-07:
  those paths answer `200` with no cookie while `/` answers `401`). That is what makes
  the app installable at all, and it is why the sign-in page can reach an
  unauthenticated client. It exposes only static assets.
- A device key only exists after one signed-in app load: an app cannot enroll while it
  is locked out. A brand-new install in a browser that has never signed in still needs
  one signed-in page load there (the printed URL), after which every launch is covered.
  Clearing site data removes the key along with the cookie.
- The swipe-back guard is Chromium-shaped: it intercepts the traversal through the
  Navigation API where that exists and falls back to `popstate`, and it installs only
  in standalone display mode, so a browser tab keeps normal history.
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
│   ├── device.js             # Cookie contract + trusted-device store
│   ├── mobile-composer.js    # The mobile composer fix (inlined into the app HTML)
│   ├── pwa-client.js         # Swipe-back guard + device enrollment (inlined)
│   └── sw.js                 # Service Worker
├── public/
│   ├── manifest.webmanifest  # PWA Manifest
│   ├── favicon.svg           # DSH whale icon (same as upstream)
│   ├── favicon.ico           # 16/32/48, hand-packed
│   ├── apple-touch-icon.png  # 180x180 for iOS
│   └── icons/                # PWA icons (maskable + monochrome + regular)
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
- `test/host.test.mjs` — route registration (sw, manifest, 9 icon assets, version, auth
  probe, the three device routes), response headers, the index-HTML script injection,
  enrollment / claim / forget driven against a temporary home, and the effect cleanup
  used on HMR unmounts.
- `test/device.test.mjs` — the cookie identity pinned against dsh's own derivation, a
  minted cookie accepted by the same contract the fence uses (and rejected for another
  authority, another secret, a tampered payload, a rewritten version or an expired
  window), the credentials-file reader, and the device store's cap, lookup and
  corrupt-file path.
- `test/icons.test.mjs` — every icon's real dimensions and format, parsed out of the
  PNG/ICO bytes rather than trusted.
- `test/pwa-client.test.mjs` — the back-gesture guard against a fake window: the
  sentinel is armed, one gesture is counted once across both interception paths, a
  second swipe inside the window lets the exit through, and a browser tab is untouched.

## License

MIT
