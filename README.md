# DSH PWA Plugin

PWA plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) that adds offline support and install-as-app capability.

## Features

- **Service Worker** with smart caching strategy
- **PWA Manifest** with proper maskable icons
- **Automatic updates** — new versions activate silently and reload the page exactly once (a first-ever visit never reloads)
- **Versioned caches** — cache names carry the package version, so upgrading the plugin purges stale caches automatically
- **Offline-first** for static assets
- **Sign in from inside the app** — a locked-out navigation shows a code box instead of dsh's plain-text 401
- **One sign-in per device** — a device that signed in once keeps a key of its own and
  renews its own session, so the launch code is needed once, not on every launch
- **Swipe-back guard** — an Android edge swipe no longer throws you out of the app
  mid-conversation; a second swipe inside two seconds still leaves, deliberately
- **Mobile composer fix** — on a phone, Enter inserts a newline instead of sending, and a paste whose payload the composer cannot see is recovered (from the clipboard API, or replayed from the one `insertText` the Android keyboard's clipboard panel sends)
- **Keyboard stays down** — on a phone the on-screen keyboard only opens for a tap on
  the text area itself, so **New session** stops covering the transcript with it
  (Android; the reason is under [Limitations](#limitations))
- **Composer above the keyboard** — on a phone the composer rises with the soft keyboard
  instead of staying in the strip it covers: Chrome 108+ through the viewport meta's
  `interactive-widget=resizes-content`, iOS Safari and older Chromium through an inlined
  `visualViewport` script. Desktop layout is unchanged.
- **A keyboard that stays while you chat** — tapping the transcript, a link, an
  attachment or any control in the composer card (Send, the model chip, the permission
  mode, the microphone) leaves the keyboard open, so a press is never lost to the
  composer moving under it; opening the sidebar, switching view tabs or entering Settings
  puts it away. A control the browser focuses anyway - the model chip, about 10 ms after a
  cancelled press - gives the caret straight back to the draft.
- **Hold Send to queue** — a press held for 300 ms sends through the composer's other
  busy mode, so a phone set to *Steer* while busy can still queue a message; the queued
  row keeps its own Steer button. The window closes before the engine's own long press,
  which on Android opens its selection menu about 400 ms in, takes the focus and drops the
  touch: a press that loses the page after 150 ms still fires, the menu is held off for a
  moment afterwards, and the caret goes back to the draft when the engine's long press
  focuses the button under the finger, so the keyboard stays up. A chord the composer never
  saw is tried again along a short ladder that outlives the keyboard's composing window,
  and a pill above the button says what happened (Queued, Steering, Sent, `Sending…` while
  a retry is still going, or a request to try again).
- **DSH mark icon set** — the official mark as a white silhouette on dsh's dark
  neutral ground (the `#151517` base and `#f9fafb` label colour the app UI itself
  uses), for the app icon, the favicon and the apple touch icon, with a maskable
  variant and a single-colour silhouette for the manifest's `monochrome` slot
- **A real install card** — `description` plus three phone-width `screenshots` (a
  conversation, the trajectory of a run, and the context panel), served from
  `/screenshots/`, which is what switches Chrome from the compact "Add to home screen"
  prompt to the full card
- **No accidental pull-to-refresh** — the root scroller gets
  `overscroll-behavior-y: contain`, which the app shell sets only on inner scrollers, so
  a scroll that reaches the top can no longer reload the app mid-conversation
- **Safe-area aware** — the surfaces this plugin owns (its toast) offset by
  `env(safe-area-inset-bottom, 0px)`, so they clear the Android gesture bar
- **Durable storage** — on the first real gesture, once per page, the client asks for
  `navigator.storage.persist()`, so Chrome is asked not to evict the cache (and the
  device key) under storage pressure

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

## Android

Install the app from **Chrome** (⋮ menu → *Install app*, or *Add to Home screen*).
Samsung Internet cannot host it: it has no flags UI, and the option below needs one.

The composer follows the keyboard. Chrome 108 and later reads
`interactive-widget=resizes-content` from the host's viewport meta and shrinks the layout
viewport when the keyboard opens, so the composer rises by itself. Chromium builds
without that token use the inlined `mobile-keyboard.js`, which boxes the app to the
visible part of the window. Where the layout viewport already shrank, the script measures
a gap of 0 and does nothing, so the two paths do not stack.

The keyboard closes when you leave the conversation, not when you tap inside it. Presses
in `[data-conversation-region]` leave it open — the transcript and its links,
attachments, and the controls in the composer card, **Send** and the model, permission
and microphone chips alike; presses outside it, which are the session sidebar, the
header's view tabs and Settings, put it away. That order matters now that the app's
height follows the keyboard: a press that dismissed it before the click would move the
composer down under the finger and the tap would land on whatever slid into its place.
A press on a control also has to be stopped from taking the caret the way the engine
does by default, which is what `mobile-composer.js` does while the draft is focused.

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

1. The host plugin serves `/sw.js` (stamped with the package version), `/manifest.webmanifest`, and icon files
2. It injects a service worker registration script into the HTML
3. The service worker pre-caches static assets (one failing URL never aborts the install) and caches them for offline use
4. The manifest enables installing the app as a PWA
5. Updates are detected automatically and silently activated; the page reloads once per update
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

A device that is refused says why. The sign-in page's diagnosis line carries the
claim's own result — `the host answered 401 for the key this device sent` means the
host holds no record of that key, while `the host minted a cookie the fence refused`
means the mint itself did not satisfy the fence — together with the host, the cookie's
state and the number of enrolled devices. Those two families of failure look identical
on a phone and need different fixes. The host logs the same decisions under the
`[DSH PWA]` prefix: every enrollment (with the id it evicted once the list is full),
every refused claim (with the key's length, an 8-character fingerprint of its hash and
the device count), every accepted claim, every forgotten device, and the probe's
verdict. A fingerprint is not the key and cannot be replayed; neither the cookie value
nor the signing secret is ever logged.

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
- The installed launcher icon is baked at install. Chrome will not re-download icon bytes
  while the manifest's `icons` field is unchanged, so regenerated artwork needs a new icon
  URL (the `?rev=` query) before an app that is already installed shows it; see
  [After regenerating](#after-regenerating-bump-the-icon-revision). The server can serve
  the new art correctly and the phone will still show the old icon until that URL moves.
- The app document stays behind dsh's token fence, and the plugin's own routes
  (`/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/screenshots/*`, `/dsh-pwa/version`)
  are not fenced — routes registered through `webServer.register` bypass it (measured
  2026-10-07: those paths answer `200` with no cookie while `/` answers `401`, and the
  screenshots route is matched by the same table). That is what makes
  the app installable at all, and it is why the sign-in page can reach an
  unauthenticated client. It exposes only static assets: the screenshots handler opens a
  name only when a fresh listing of `public/screenshots` contains it.
- A regenerated screenshot needs a new URL for the same reason a regenerated icon does
  (Chrome treats an unchanged `screenshots` field as unchanged), so the manifest entries
  carry a `?rev=` query, and `test/manifest.test.mjs` pins the hash of each reviewed
  capture: a re-capture is a deliberate change, not a surprise in a diff.
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
  the `focus()` wrapper is installed only for a coarse pointer. On an iPhone the fallback
  is a blur under the mute: the keyboard does go away, but the draft loses its caret,
  where Android hides the keyboard and keeps it.
- The iOS composer now rises with the keyboard, but that half is untested on a device.
  Safari ignores `interactive-widget`, so `mobile-keyboard.js` boxes the app to
  `visualViewport.height` at `visualViewport.offsetTop`; the path has been exercised in
  Chromium against a simulated visual viewport, not in iOS Safari.
- Tapping inside the conversation keeps the keyboard open, and that includes **Send**.
  The keyboard used to be dismissed on that press; now that the composer moves with the
  keyboard, dismissing it mid-press moved the button away from the finger and made a
  send take two taps. The cost is that the keyboard stays over part of the transcript
  after a send until you close it yourself or leave the conversation.

## Project Structure

```
dsh-pwa-plugin/
├── src/
│   ├── host/
│   │   └── index.js          # Host plugin (Node.js)
│   ├── device.js             # Cookie contract + trusted-device store
│   ├── mobile-composer.js    # The mobile composer fix (inlined into the app HTML)
│   ├── mobile-keyboard.js    # Boxes the app to the visual viewport while the keyboard is open (inlined)
│   ├── mobile-queue.js       # Hold the send button to use the other busy mode (inlined)
│   ├── pwa-client.js         # Swipe-back guard, device enrollment, Android polish (inlined)
│   └── sw.js                 # Service Worker
├── public/
│   ├── manifest.webmanifest  # PWA Manifest
│   ├── favicon.svg           # DSH whale icon (same as upstream)
│   ├── favicon.ico           # 16/32/48, hand-packed
│   ├── apple-touch-icon.png  # 180x180 for iOS
│   ├── icons/                # PWA icons (maskable + monochrome + regular)
│   └── screenshots/          # Install-card captures (824x1830, phone at DPR 2)
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
  maskable at 192/512), that every icon file exists on disk, and that each install-card
  screenshot exists at the exact pixel size it advertises (read out of its own IHDR)
  with the hash of the reviewed capture pinned.
- `test/sw.test.mjs` — the service worker evaluated against a fake `self`:
  install/activate cache lifecycle (including an install where a pre-cache URL
  fails), the bypass rules (non-GET, non-HTTP schemes, `/api`, `/auth-api`,
  `/oauth`, `/open-in-app`, `/plugins`, `/ws`, `/hooks`, `/dsh-pwa`, websocket
  upgrades), network-first HTML with its offline fallbacks, the `401` to
  sign-in-page replacement, a `no-store` or `5xx` navigation served but never
  stored, cache-first statics with the store guard, and the `GET_VERSION` /
  `SKIP_WAITING` messages.
- `test/mobile-composer.test.mjs` — the mobile composer fix against a fake DOM:
  Enter inserts a newline on a coarse pointer while the slash and reference menus
  keep it, a payload-less `beforeinput` falls back to `navigator.clipboard.readText()`
  and then `read()`, one oversized `insertText` is replayed as a real paste exactly
  once (and the retry is not claimed a second time), a paste carrying markup is
  normalised to its plain text, a paste with no editable under it lands in the editor
  last typed in, an insertion the editor drops is measured and re-sent exactly once,
  a programmatic focus of a composer the user is not in is muted and then dismissed
  while a focus on the one they are typing in is left alone, a tap on the text area
  re-arms the keyboard, a press in the chat leaves it open and a press on the sidebar or
  Settings puts it away, a control pressed in the card is cancelled while the draft has
  the caret where a field in the same card still takes its own press, and the module
  ships no diagnostic overlay.
- `test/mobile-queue.test.mjs` — the hold gesture against a fake DOM: a coarse pointer
  arms only on an enabled primary button with draft text and no trigger menu, a 300 ms
  hold dispatches one Ctrl+Enter chord at the editor the card holds at that moment and
  swallows the click behind it, a chord the composer does not cancel is tried again along
  the 30/150/400 ms ladder, stopping when it lands or the draft moved on, a tap and the
  ways a press can end early
  (release, leaving the button, blur, backgrounding) send nothing, a page that goes away
  once the press is older than 150 ms fires instead of dropping the hold, a cancel with the
  finger still down keeps the hold while one that reports the finger moved ends it, a
  cancel after the fire still swallows the release click, the engine's long press menu is
  kept off a hold that just fired, and the pill reports the mode the chord landed in, says
  so when it went unanswered, and outlives the release.
- `test/mobile-keyboard.test.mjs` — the keyboard box against a fake visual viewport in
  `node:vm`: a closed keyboard leaves the app at `height:100%`, an open one copies the
  visible height and `offsetTop` into the two variables the rule reads, a `scroll`-only
  pan is followed, a pinch zoom (both with and without the box) is not treated as a
  keyboard, a visual viewport taller than the window and a covered strip under 120px are
  ignored, a burst of events is measured once per frame, closing removes both variables
  and restores the document scroll once, loading with the keyboard already open measures
  immediately, and a second copy reuses the first stylesheet.
- `test/host.test.mjs` — route registration (sw, manifest, 9 icon assets, the
  screenshots prefix, version, auth probe, the three device routes), response headers,
  the `/sw.js` package-version stamping, the index-HTML script injection (including the
  viewport rewrite, the verbatim inlined composer, keyboard and queue fixes, and the
  registration script's reload guard executed in a sandboxed VM), enrollment / claim /
  forget driven against a temporary home, and the effect cleanup used on HMR unmounts.
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
  The Android polish runs in its own sandbox: the root overscroll rule, the safe-area
  offset on the guard's toast, that no floating controls are appended even when the
  browser offers `navigator.share`, and persistence asked for exactly once, on the first
  gesture, never at load.

## License

MIT
