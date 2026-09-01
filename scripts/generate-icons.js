#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// SVG template for DSH icon (DeepSeek whale on dark background)
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
  const rx = Math.round(size * 0.15);
  const fontSize = Math.round(size * 0.25);

  const svg = svgTemplate
    .replace(/{SIZE}/g, size)
    .replace(/{RX}/g, rx)
    .replace(/{FONTSIZE}/g, fontSize);

  const iconsDir = join(rootDir, 'public', 'icons');
  if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });

  // Always generate SVG
  const svgPath = join(iconsDir, `icon-${size}.svg`);
  writeFileSync(svgPath, svg);
  console.log(`Generated: ${svgPath}`);

  // Try to generate PNG with sharp if available
  try {
    const sharp = (await import('sharp')).default;
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
    const pngPath = join(iconsDir, `icon-${size}.png`);
    writeFileSync(pngPath, pngBuffer);
    console.log(`Generated: ${pngPath}`);
  } catch {
    console.log(`PNG generation skipped for ${size}x${size} (install sharp: npm install sharp)`);
  }
}

async function main() {
  console.log('Generating PWA icons...\n');

  for (const size of sizes) {
    await generatePNG(size);
  }

  console.log('\nDone!');
}

main().catch(console.error);
