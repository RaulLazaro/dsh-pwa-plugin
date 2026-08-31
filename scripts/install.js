#!/usr/bin/env node

import { existsSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// DSH directories
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh');
const DSH_PLUGINS_DIR = join(DSH_HOME, 'plugins');
const DSH_PROFILES_DIR = join(DSH_HOME, 'profiles');

function log(msg) {
  console.log(`[dsh-pwa] ${msg}`);
}

function warn(msg) {
  console.warn(`[dsh-pwa] WARNING: ${msg}`);
}

function error(msg) {
  console.error(`[dsh-pwa] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log(`Created directory: ${dir}`);
  }
}

function installPlugin() {
  log('Installing DSH PWA Plugin...');

  // Ensure DSH directories exist
  ensureDir(DSH_HOME);
  ensureDir(DSH_PLUGINS_DIR);

  // Create symlink for the plugin
  const pluginLink = join(DSH_PLUGINS_DIR, 'dsh-pwa-plugin');
  if (!existsSync(pluginLink)) {
    try {
      symlinkSync(rootDir, pluginLink);
      log(`Created plugin symlink: ${pluginLink}`);
    } catch (err) {
      warn(`Could not create symlink: ${err.message}`);
      warn('You may need to create it manually:');
      warn(`  ln -s ${rootDir} ${pluginLink}`);
    }
  } else {
    log('Plugin already installed');
  }

  // Generate icons
  log('Generating icons...');
  try {
    execSync('node scripts/generate-icons.js', { cwd: rootDir, stdio: 'inherit' });
  } catch (err) {
    warn('Icon generation failed (non-fatal)');
  }

  log('\nInstallation complete!');
  log('\nTo activate the plugin, add it to your DSH web profile:');
  log('\n1. Add to your profile\'s package.json:');
  log('   "dependencies": { "dsh-pwa-plugin": "file:~/.dsh/plugins/dsh-pwa-plugin" }');
  log('\n2. Add to your profile\'s cordis.patch.yml:');
  log('   - insert:');
  log('       - id: pwa');
  log('         name: "dsh-pwa-plugin"');
  log('\n3. Restart DSH web:');
  log('   dsh web');
}

// Run installation
installPlugin();
