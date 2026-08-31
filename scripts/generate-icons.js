#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// SVG template for DSH icon
const svgTemplate = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#8b5cf6;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="{SIZE}" height="{SIZE}" rx="{RX}" fill="url(#grad)"/>
  <text x="50%" y="55%" font-family="system-ui, -apple-system, sans-serif" font-size="{FONTSIZE}" font-weight="700" fill="white" text-anchor="middle" dominant-baseline="middle">DSH</text>
</svg>`;

const sizes = [192, 512];

async function generatePNG(size) {
  // For now, create SVG files at different sizes
  // In production, you'd use sharp or another library to convert to PNG
  const rx = Math.round(size * 0.15);
  const fontSize = Math.round(size * 0.25);

  const svg = svgTemplate
    .replace(/{SIZE}/g, size)
    .replace(/{RX}/g, rx)
    .replace(/{FONTSIZE}/g, fontSize);

  const svgPath = join(rootDir, 'public', 'icons', `icon-${size}.svg`);
  writeFileSync(svgPath, svg);
  console.log(`Generated: ${svgPath}`);

  // Note: For actual PNG generation, install sharp:
  // npm install sharp
  // Then uncomment:
  //
  // import sharp from 'sharp';
  // const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  // const pngPath = join(rootDir, 'public', 'icons', `icon-${size}.png`);
  // writeFileSync(pngPath, pngBuffer);
  // console.log(`Generated: ${pngPath}`);
}

async function main() {
  console.log('Generating PWA icons...');

  for (const size of sizes) {
    await generatePNG(size);
  }

  console.log('\nDone!');
  console.log('\nTo generate PNG files, install sharp:');
  console.log('  npm install sharp');
  console.log('Then run this script again.');
}

main().catch(console.error);
