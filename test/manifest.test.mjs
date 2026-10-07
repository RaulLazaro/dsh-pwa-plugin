import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf-8'));

// The revision stamped on every icon URL in the manifest. Chrome treats an
// unchanged `icons` field as immutable and does not download the icon bytes
// again, so a regenerated icon that keeps its URL never reaches an installed
// app. Bumping this (and the `?rev=` in the manifest with it) is what makes
// Android fetch the new artwork. See README, "Changing the artwork".
const ICON_REV = '1';

/** The manifest src carries a revision query; the file on disk is its path. */
const iconPath = (src) => new URL(src, 'https://dsh.test').pathname;
const onDisk = (src) => join(publicDir, iconPath(src).replace(/^\//, ''));

// What each icon hashed to when ICON_REV was minted. Chrome will not look at
// these bytes again under the same URL, so a mismatch here means the revision
// has to move with the artwork.
const ARTWORK = {
  '/icons/icon.svg': 'f9335c1ac23a9c4df2ec54213ef80a637bcf31445e784e421b4a0aa1d5d08ed7',
  '/icons/icon-192.png': '12fb86d0e8b6b8b8542488c439922ed8f19f1d48be358c69680da0201deaaf4e',
  '/icons/icon-512.png': '6f9f93d39c17730eb77e67033ad8d80e5615a43c771715d06aeff8d2cffa7b97',
  '/icons/icon-monochrome.svg': '790dd6e132028e5e55aa3eeb0d309b4fcd6985e623a17596b58e6297b005ff3e',
  '/icons/icon-192-maskable.png': 'b0b92669b00434952d2efcaa39395dc291f660490d4e54acf12e374b36e5d6e2',
  '/icons/icon-512-maskable.png': 'a4b4664b2455d21cf6b6b6d65cf2400e9c72a880c7823f2ac10064433f17f036',
};

test('manifest parses and carries the install-as-app essentials', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.name && manifest.short_name, 'name and short_name are required');
});

test('manifest declares both regular and maskable icons at 192 and 512', () => {
  const maskable = manifest.icons.filter((i) => i.purpose === 'maskable');
  const regular = manifest.icons.filter((i) => i.purpose === 'any');
  assert.deepEqual(
    maskable.map((i) => i.sizes).sort(),
    ['192x192', '512x512'],
    'maskable icons must cover both required densities (Android crop-safe path)'
  );
  assert.ok(regular.some((i) => i.sizes === '192x192'), 'regular 192 icon missing');
  assert.ok(regular.some((i) => i.sizes === '512x512'), 'regular 512 icon missing');
});

test('every icon src exists on disk under public/', () => {
  for (const icon of manifest.icons) {
    const file = onDisk(icon.src);
    assert.ok(existsSync(file), `icon file missing: ${icon.src}`);
    assert.ok(readFileSync(file).length > 0, `icon file empty: ${icon.src}`);
  }
});

test('every icon URL carries the same revision, so Chrome re-downloads them', () => {
  const revs = new Set(manifest.icons.map((i) => new URL(i.src, 'https://dsh.test').searchParams.get('rev')));
  assert.deepEqual(
    [...revs],
    [ICON_REV],
    'all icons share one rev; bump it here and in the manifest together, or an updated icon keeps its old URL and Android never fetches it'
  );
});

test('the artwork on disk is still the revision the manifest advertises', () => {
  const seen = new Set();
  for (const icon of manifest.icons) {
    const path = iconPath(icon.src);
    const expected = ARTWORK[path];
    assert.ok(expected, `${path} has no pinned hash: add it to ARTWORK`);
    seen.add(path);
    const actual = createHash('sha256').update(readFileSync(onDisk(icon.src))).digest('hex');
    assert.equal(
      actual,
      expected,
      `${basename(path)} changed on disk: regenerate the icon URLs with a new ?rev= (and ICON_REV, and ARTWORK) or Chrome keeps serving the old icon`
    );
  }
  assert.equal(seen.size, manifest.icons.length, 'two manifest icons point at the same file');
});

test('the manifest does NOT pin an orientation, so the device lock wins', () => {
  // Chrome ignores the OS rotation lock inside an installed PWA whenever the
  // manifest declares an orientation, and that includes "any". Omitting the
  // member makes the browser apply no lock at all, so the system lock governs
  // and a user who locked portrait stays in portrait.
  assert.equal(
    Object.hasOwn(manifest, 'orientation'),
    false,
    'an explicit orientation (even "any") overrides the Android rotation lock in standalone mode'
  );
});

test('theme and background colors are valid hex', () => {
  for (const key of ['theme_color', 'background_color']) {
    assert.match(manifest[key], /^#[0-9a-f]{6}$/i, `${key} must be a #rrggbb color`);
  }
});

test('the manifest declares the surface Chrome uses for a richer install', () => {
  assert.deepEqual(manifest.display_override, ['standalone', 'minimal-ui']);
  assert.equal(manifest.launch_handler?.client_mode, 'navigate-existing');
  assert.equal(manifest.lang, 'en');
  assert.equal(manifest.dir, 'ltr');
});

test('a monochrome icon is declared for themed launchers', () => {
  const monochrome = manifest.icons.filter((i) => i.purpose === 'monochrome');
  assert.equal(monochrome.length, 1, 'the launcher tints a monochrome icon with the wallpaper colours');
  assert.equal(monochrome[0].type, 'image/svg+xml');
  assert.ok(existsSync(onDisk(monochrome[0].src)), 'the monochrome source is missing');
});

test('no icon points at the dsh /favicon.svg mark', () => {
  // dsh serves /favicon.svg (black, for the light scheme) and /favicon-dark.svg;
  // the built-in manifest pointed at the first one, which is how the app ended up
  // wearing dsh's own flat mark instead of this plugin's icon set.
  const paths = manifest.icons.map((i) => iconPath(i.src));
  assert.equal(
    paths.some((p) => p === '/favicon.svg' || p === '/favicon-dark.svg'),
    false,
    'dsh\'s own favicon is not this app icon'
  );
  assert.ok(paths.includes('/icons/icon.svg'), 'the DSH mark must be the vector icon');
});
