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

test('theme and background colors are valid hex', () => {
  for (const key of ['theme_color', 'background_color']) {
    assert.match(manifest[key], /^#[0-9a-f]{6}$/i, `${key} must be a #rrggbb color`);
  }
});
