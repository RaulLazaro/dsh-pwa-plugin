import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf-8'));

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
    const file = join(publicDir, icon.src.replace(/^\//, ''));
    assert.ok(existsSync(file), `icon file missing: ${icon.src}`);
    assert.ok(readFileSync(file).length > 0, `icon file empty: ${icon.src}`);
  }
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
  assert.ok(existsSync(join(publicDir, monochrome[0].src.replace(/^\//, ''))), 'the monochrome source is missing');
});

test('no icon points at the dsh /favicon.svg mark', () => {
  // dsh serves /favicon.svg (black, for the light scheme) and /favicon-dark.svg;
  // the built-in manifest pointed at the first one, which is how the app ended up
  // wearing dsh's own flat mark instead of this plugin's icon set.
  assert.equal(
    manifest.icons.some((i) => i.src === '/favicon.svg' || i.src === '/favicon-dark.svg'),
    false,
    'dsh\'s own favicon is not this app icon'
  );
  assert.ok(
    manifest.icons.some((i) => i.src === '/icons/icon.svg'),
    'the transparent whale must be the vector icon'
  );
});
