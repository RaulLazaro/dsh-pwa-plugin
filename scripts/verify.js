#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function log(msg) {
  console.log(`[dsh-pwa] ${msg}`);
}

function error(msg) {
  console.error(`[dsh-pwa] ERROR: ${msg}`);
}

function check(name, condition, message) {
  if (condition) {
    log(`✓ ${name}`);
    return true;
  } else {
    error(`✗ ${name}: ${message}`);
    return false;
  }
}

function verify() {
  log('Verifying DSH PWA Plugin installation...\n');

  let allPassed = true;

  // Check required files
  allPassed = check(
    'Service Worker',
    existsSync(join(rootDir, 'src', 'sw.js')),
    'Service worker not found'
  ) && allPassed;

  allPassed = check(
    'Host Plugin',
    existsSync(join(rootDir, 'src', 'host', 'index.js')),
    'Host plugin not found'
  ) && allPassed;

  allPassed = check(
    'Manifest',
    existsSync(join(rootDir, 'public', 'manifest.webmanifest')),
    'Manifest not found'
  ) && allPassed;

  allPassed = check(
    'Package.json',
    existsSync(join(rootDir, 'package.json')),
    'Package.json not found'
  ) && allPassed;

  // Validate manifest
  if (existsSync(join(rootDir, 'public', 'manifest.webmanifest'))) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(rootDir, 'public', 'manifest.webmanifest'), 'utf-8')
      );

      allPassed = check(
        'Manifest: name',
        manifest.name && manifest.name.length > 0,
        'Missing app name'
      ) && allPassed;

      allPassed = check(
        'Manifest: short_name',
        manifest.short_name && manifest.short_name.length > 0,
        'Missing short name'
      ) && allPassed;

      allPassed = check(
        'Manifest: start_url',
        manifest.start_url && manifest.start_url.length > 0,
        'Missing start_url'
      ) && allPassed;

      allPassed = check(
        'Manifest: display',
        ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display),
        'Invalid display mode'
      ) && allPassed;

      allPassed = check(
        'Manifest: icons',
        Array.isArray(manifest.icons) && manifest.icons.length >= 6,
        `Expected at least 6 icon entries (any + maskable x 2 sizes + monochrome), found ${manifest.icons?.length ?? 0}`
      ) && allPassed;

      // Check that 'any', 'maskable' and 'monochrome' purposes are all present
      const purposes = new Set(manifest.icons.map(i => i.purpose).flat());
      allPassed = check(
        'Manifest: maskable icon purpose',
        purposes.has('maskable'),
        'No icon with purpose "maskable" found'
      ) && allPassed;

      allPassed = check(
        'Manifest: monochrome icon purpose',
        purposes.has('monochrome'),
        'No icon with purpose "monochrome" found (themed launchers need one)'
      ) && allPassed;

      allPassed = check(
        'Manifest: no dsh favicon as an app icon',
        !manifest.icons.some(i => i.src === '/favicon.svg' || i.src === '/favicon-dark.svg'),
        'The manifest must not reuse dsh\'s own favicon as the app icon'
      ) && allPassed;
    } catch (err) {
      error(`Manifest parsing failed: ${err.message}`);
      allPassed = false;
    }
  }

  // Check icon files exist on disk
  const iconsDir = join(rootDir, 'public', 'icons');
  const requiredIcons = [
    'icon.svg',
    'icon-maskable.svg',
    'icon-monochrome.svg',
    'icon-32.png',
    'icon-192.png',
    'icon-192-maskable.png',
    'icon-512.png',
    'icon-512-maskable.png'
  ];
  log('\nChecking icon files...');
  for (const icon of requiredIcons) {
    allPassed = check(
      `Icon: ${icon}`,
      existsSync(join(iconsDir, icon)),
      `Missing ${icon} in public/icons/`
    ) && allPassed;
  }
  for (const [name, file] of [['apple-touch-icon.png', join(rootDir, 'public', 'apple-touch-icon.png')], ['favicon.ico', join(rootDir, 'public', 'favicon.ico')]]) {
    allPassed = check(
      `Icon: ${name}`,
      existsSync(file),
      `Missing public/${name} (Chrome needs a raster icon for the site identity)`
    ) && allPassed;
  }

  // Check DSH installation (informational — not required for CI)
  const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh');

  if (existsSync(DSH_HOME)) {
    log('\nChecking DSH installation...');
    check('DSH plugins directory', existsSync(join(DSH_HOME, 'plugins')), 'Not found');
    check('DSH profiles directory', existsSync(join(DSH_HOME, 'profiles')), 'Not found');
  }

  console.log('');

  if (allPassed) {
    log('All checks passed! ✓');
  } else {
    error('Some checks failed. Please fix the issues above.');
    process.exit(1);
  }
}

verify();
