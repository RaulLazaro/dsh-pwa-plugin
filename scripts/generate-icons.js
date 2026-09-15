#!/usr/bin/env node
/**
 * Generate maskable + regular PWA icons from the DSH whale SVG favicon.
 *
 * Maskable icons: 20% safe-zone inset (logo in inner 80%).
 * Regular icons:  10% inset (logo in inner 90%).
 *
 * Requires: sharp (npm install sharp)
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const ICONS_DIR = join(PUBLIC_DIR, 'icons');
const SVG_PATH = join(PUBLIC_DIR, 'favicon.svg');

const BG_COLOR = '#0f172a';

// [size, maskable?]
const VARIANTS = [
  [192, true],
  [192, false],
  [512, true],
  [512, false],
];

async function generate() {
  mkdirSync(ICONS_DIR, { recursive: true });

  const svgBuffer = readFileSync(SVG_PATH);

  for (const [size, maskable] of VARIANTS) {
    const safeZone = maskable ? 0.80 : 0.90;
    const iconSize = Math.round(size * safeZone);
    const offset = Math.round((size - iconSize) / 2);

    const background = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="${BG_COLOR}"/>
      </svg>`
    );

    const resizedWhale = await sharp(svgBuffer)
      .resize(iconSize, iconSize, { fit: 'contain', background: 'transparent' })
      .png()
      .toBuffer();

    const filename = maskable
      ? `icon-${size}-maskable.png`
      : `icon-${size}.png`;

    await sharp(background)
      .composite([{ input: resizedWhale, left: offset, top: offset }])
      .png()
      .toFile(join(ICONS_DIR, filename));

    console.log(`✓ ${filename} (${size}×${size}, safe zone ${Math.round(safeZone * 100)}%)`);
  }

  console.log('\nDone. Update manifest.webmanifest references accordingly.');
}

generate().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
