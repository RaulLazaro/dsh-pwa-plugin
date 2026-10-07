#!/usr/bin/env node
/**
 * Build the PWA icon set from the vendored whale glyph.
 *
 *   node scripts/generate-icons.js                  rasterize the committed SVGs
 *   node scripts/generate-icons.js --source <svg>   re-vendor the glyph from a dsh favicon.svg first
 *
 * The three SVGs in public/icons/ are the source of truth and are committed, so
 * CI and a fresh checkout need nothing installed:
 *
 *   icon.svg             transparent, "any" purpose
 *   icon-maskable.svg    opaque ground, artwork inside the 0.80 safe zone
 *   icon-monochrome.svg  white silhouette, "monochrome" purpose
 *
 * Rasterizing needs sharp, which is deliberately NOT a dependency (this package
 * ships no dependencies and its CI installs nothing). Install it locally before
 * regenerating; the generated PNGs and favicon.ico are committed.
 *
 * Android bakes a launcher icon into the WebAPK at install time, so a changed
 * icon reaches an already installed phone only after the app is reinstalled or
 * Chrome refreshes the WebAPK - a manifest edit alone does not repaint it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const ICONS_DIR = join(PUBLIC_DIR, 'icons');

const GROUND = '#0f172a';
const WHALE = '#4D6BFE';
const VIEW_BOX = '0 0 50 50';
const BOX = 50;

// Artwork insets: maskable icons are cropped to whatever shape the launcher
// wants, so the glyph stays inside the guaranteed-visible 80% circle; the plain
// and monochrome icons can breathe at 90%.
const MASKABLE_INSET = 0.8;
const REGULAR_INSET = 0.9;

// No double hyphen may appear here: this text becomes an XML comment, and "--"
// is illegal inside one (librsvg rejects the whole file).
const PROVENANCE =
  'Whale glyph from the DeepSeek Harness web frontend favicon (viewBox 0 0 50 50), vendored 2026-10-07 by scripts/generate-icons.js, re-vendor with its source flag';

function artBody(fill, inset, ground) {
  const scale = inset;
  const offset = (BOX - BOX * scale) / 2;
  const transform = scale === 1 ? '' : ` transform="translate(${offset} ${offset}) scale(${scale})"`;
  const back = ground ? `  <rect width="${BOX}" height="${BOX}" fill="${ground}"/>\n` : '';
  return `${back}  <path d="__D__" fill="${fill}"${transform}/>\n`;
}

function wrap(fill, inset, ground) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" width="${BOX}" height="${BOX}" role="img" aria-label="DeepSeek Harness">
  <!-- ${PROVENANCE} -->
${artBody(fill, inset, ground)}</svg>
`;
}

/** Pull the viewBox and the first path's `d` out of a dsh favicon.svg. */
export function extractGlyph(svgText) {
  const viewBox = /viewBox="([^"]+)"/.exec(svgText)?.[1];
  const d = /<path[^>]*\sd="([^"]+)"/.exec(svgText)?.[1];
  if (!viewBox || !d) throw new Error('no viewBox/path data found in the source SVG');
  const box = viewBox.trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) throw new Error(`unusable viewBox: ${viewBox}`);
  return { viewBox: viewBox.trim(), d };
}

/** Write the three committed SVGs from a glyph. Exported so a test can feed a fixture. */
export function writeArt({ d }, dir = ICONS_DIR) {
  mkdirSync(dir, { recursive: true });
  const files = {
    'icon.svg': wrap(WHALE, REGULAR_INSET, null),
    'icon-maskable.svg': wrap(WHALE, MASKABLE_INSET, GROUND),
    'icon-monochrome.svg': wrap('#ffffff', REGULAR_INSET, null),
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text.replaceAll('__D__', d), 'utf-8');
  }
  return Object.keys(files);
}

/** Pack PNG blobs into a PNG-in-ICO container (Vista+ accepts PNG payloads). */
export function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

async function main() {
  const sourceFlag = process.argv.indexOf('--source');
  if (sourceFlag !== -1) {
    const source = process.argv[sourceFlag + 1];
    if (!source) throw new Error('--source needs the path to a dsh favicon.svg');
    const written = writeArt(extractGlyph(readFileSync(source, 'utf-8')));
    console.log(`vendored glyph into ${written.join(', ')}`);
  }

  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    console.error('sharp is not installed - the committed SVGs were left alone.');
    console.error('Install it locally (npm i --no-save sharp) to regenerate the PNG set.');
    process.exit(1);
  }

  mkdirSync(ICONS_DIR, { recursive: true });
  const svg = (name) => readFileSync(join(ICONS_DIR, name));
  // Render far above the largest target and downscale: librsvg picks its own
  // raster size from the intrinsic 50x50 box, so density is what buys detail.
  const render = async (name, size) =>
    sharp(svg(name), { density: 1440 }).resize(size, size, { fit: 'fill' }).png().toBuffer();

  const written = [];
  const write = (file, buffer) => {
    writeFileSync(file, buffer);
    written.push(`${file} (${buffer.length} B)`);
  };

  write(join(ICONS_DIR, 'icon-192.png'), await render('icon.svg', 192));
  write(join(ICONS_DIR, 'icon-512.png'), await render('icon.svg', 512));
  write(join(ICONS_DIR, 'icon-192-maskable.png'), await render('icon-maskable.svg', 192));
  write(join(ICONS_DIR, 'icon-512-maskable.png'), await render('icon-maskable.svg', 512));
  write(join(ICONS_DIR, 'icon-32.png'), await render('icon.svg', 32));
  write(join(PUBLIC_DIR, 'apple-touch-icon.png'), await render('icon-maskable.svg', 180));

  const ico = [];
  for (const size of [16, 32, 48]) ico.push({ size, png: await render('icon.svg', size) });
  write(join(PUBLIC_DIR, 'favicon.ico'), packIco(ico));

  for (const line of written) console.log(`  ${line}`);
  console.log(`\n${written.length} assets written from the committed SVGs.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('Icon generation failed:', err.message);
    process.exit(1);
  });
}
