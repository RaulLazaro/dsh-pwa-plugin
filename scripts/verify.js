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
        Array.isArray(manifest.icons) && manifest.icons.length >= 4,
        `Expected ≥4 icon entries (any + maskable × 2 sizes), found ${manifest.icons?.length ?? 0}`
      ) && allPassed;

      // Check that both 'any' and 'maskable' purposes are present
      const purposes = new Set(manifest.icons.map(i => i.purpose).flat());
      allPassed = check(
        'Manifest: maskable icon purpose',
        purposes.has('maskable'),
        'No icon with purpose "maskable" found'
      ) && allPassed;
    } catch (err) {
      error(`Manifest parsing failed: ${err.message}`);
      allPassed = false;
    }
  }

  // Check icon files exist on disk
  const iconsDir = join(rootDir, 'public', 'icons');
  const requiredIcons = [
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

  // Check DSH installation
  const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh');

  log('\nChecking DSH installation...');

  allPassed = check(
    'DSH_HOME',
    existsSync(DSH_HOME),
    `DSH_HOME not found at ${DSH_HOME}`
  ) && allPassed;

  if (existsSync(DSH_HOME)) {
    allPassed = check(
      'DSH plugins directory',
      existsSync(join(DSH_HOME, 'plugins')),
      'Plugins directory not found'
    ) && allPassed;

    allPassed = check(
      'DSH profiles directory',
      existsSync(join(DSH_HOME, 'profiles')),
      'Profiles directory not found'
    ) && allPassed;
  }

  console.log('');

  if (allPassed) {
    log('All checks passed! ✓');
    log('\nNext steps:');
    log('1. Run: node scripts/install.js');
    log('2. Add the plugin to your DSH web profile');
    log('3. Restart DSH web');
  } else {
    error('Some checks failed. Please fix the issues above.');
    process.exit(1);
  }
}

verify();
