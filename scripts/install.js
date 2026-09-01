#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function log(msg) {
  console.log(`[dsh-pwa] ${msg}`);
}

function verify() {
  log('Verifying DSH PWA Plugin...\n');

  const requiredFiles = [
    ['src/host/index.js', 'Host plugin'],
    ['src/sw.js', 'Service Worker'],
    ['public/manifest.webmanifest', 'PWA Manifest'],
    ['public/favicon.svg', 'Favicon'],
    ['public/icons/icon-192.png', 'Icon 192px'],
    ['public/icons/icon-512.png', 'Icon 512px'],
  ];

  let ok = true;
  for (const [rel, label] of requiredFiles) {
    const full = join(rootDir, rel);
    if (existsSync(full)) {
      log(`  ✓ ${label}`);
    } else {
      console.error(`  ✗ ${label} — missing: ${rel}`);
      ok = false;
    }
  }

  if (!ok) {
    console.error('\nSome files are missing. Run: node scripts/generate-icons.js');
    process.exit(1);
  }

  log('\nAll files present!');
  log('\nTo activate the plugin, add it to your DSH web profile:\n');
  log('1. In your profile\'s package.json:');
  log('   "dependencies": { "dsh-pwa-plugin": "file:~/workspace/dsh-pwa-plugin" }');
  log('   "dsh": { "profile": { "bundles": [...existing, "dsh-pwa-plugin"] } }\n');
  log('2. In your profile\'s cordis.patch.yml:');
  log('   - insert:');
  log('       - id: dsh-pwa');
  log('         name: "dsh-pwa-plugin"\n');
  log('3. Restart DSH: dsh web');
}

verify();
