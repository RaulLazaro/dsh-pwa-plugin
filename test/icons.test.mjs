/**
 * The committed icon set is verified by decoding it, not by trusting the build.
 *
 * CI installs nothing (see .github/workflows), and sharp is deliberately not a
 * dependency, so these tests carry their own PNG reader: IHDR + IDAT, the five
 * scanline filters, and a pixel sampler. That is enough to assert the two things
 * a launcher actually cares about - a transparent icon has real transparency,
 * and a maskable icon is opaque to its corners - plus that favouring them from
 * the SVG sources produced the sizes the manifest advertises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ic = (name) => join(root, 'public', 'icons', name);
const pub = (name) => join(root, 'public', name);

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Minimal PNG decoder: enough for the 8-bit non-interlaced files we emit. */
function decodePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], PNG_SIGNATURE, 'not a PNG');
  const idat = [];
  let header;
  for (let at = 8; at + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    at += 12 + length;
    if (type === 'IEND') break;
  }
  assert.ok(header, 'PNG has no IHDR');
  assert.equal(header.bitDepth, 8, 'only 8-bit depth is decoded here');
  assert.equal(header.interlace, 0, 'only non-interlaced PNGs are decoded here');
  const channels = CHANNELS[header.colorType];
  assert.ok(channels, `unsupported colour type ${header.colorType}`);
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * header.height);
  let src = 0;
  for (let y = 0; y < header.height; y++) {
    const filter = raw[src++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const line = raw.subarray(src, src + stride);
    src += stride;
    const prev = y === 0 ? Buffer.alloc(stride) : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.equal(filter, 0, `unknown scanline filter ${filter}`);
      row[x] = value & 0xff;
    }
  }
  const channelsOf = channels;
  return {
    header,
    at(x, y) {
      const base = y * stride + x * channelsOf;
      return {
        r: out[base],
        g: out[base + 1] ?? 0,
        b: out[base + 2] ?? 0,
        a: channelsOf === 4 ? out[base + 3] : 255,
      };
    },
    count(predicate) {
      let n = 0;
      for (let y = 0; y < header.height; y++) {
        for (let x = 0; x < header.width; x++) if (predicate(this.at(x, y))) n++;
      }
      return n;
    },
  };
}

const read = (file) => decodePng(readFileSync(file));
const isBlue = (p) => p.a > 200 && p.b > 150 && p.b > p.r && p.b > p.g;
const isGround = (p) => p.a > 200 && p.r === 0x0f && p.g === 0x17 && p.b === 0x2a;

test('the transparent icons really are transparent, not a baked-in background', () => {
  for (const [file, size] of [[ic('icon-32.png'), 32], [ic('icon-192.png'), 192], [ic('icon-512.png'), 512]]) {
    const png = read(file);
    assert.equal(png.header.width, size, `${file} width`);
    assert.equal(png.header.height, size, `${file} height`);
    assert.equal(png.header.colorType, 6, `${file} must keep an alpha channel`);
    // The glyph is inset to 90%, so the corners are outside the artwork. If a
    // ground rect ever creeps into this SVG, Android shows a square tile in the
    // notification shade and the adaptive launcher crops it into a blob.
    assert.equal(png.at(0, 0).a, 0, `${file} top-left corner must be transparent`);
    assert.equal(png.at(size - 1, size - 1).a, 0, `${file} bottom-right corner must be transparent`);
    const opaque = png.count((p) => p.a === 255);
    assert.ok(opaque > size * size * 0.05, `${file} should be a solid whale, ${opaque} of ${size * size} pixels are opaque`);
    assert.ok(png.count(isBlue) > 0, `${file} should draw the #4D6BFE whale`);
  }
});

test('the maskable icons are opaque to their corners', () => {
  for (const [file, size] of [[ic('icon-192-maskable.png'), 192], [ic('icon-512-maskable.png'), 512]]) {
    const png = read(file);
    assert.equal(png.header.width, size, `${file} width`);
    assert.equal(png.header.colorType, 6, `${file} colour type`);
    // Android masks a maskable icon to its own shape; every pixel outside that
    // shape has to be filled by the icon itself or the launcher pads it with
    // white. The 0.80 inset guarantees the corners are ground, not artwork.
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1], [size >> 1, 0]]) {
      assert.ok(isGround(png.at(x, y)), `${file} ${x},${y} must be the #0f172a ground`);
    }
    assert.ok(png.count(isBlue) > 0, `${file} should still draw the whale`);
    const transparent = png.count((p) => p.a !== 255);
    assert.equal(transparent, 0, `${file} must have no translucent pixels`);
  }
});

test('the apple touch icon is opaque because iOS composites alpha onto black', () => {
  const png = read(pub('apple-touch-icon.png'));
  assert.equal(png.header.width, 180);
  assert.equal(png.header.height, 180);
  assert.equal(png.count((p) => p.a !== 255), 0, 'a transparent apple-touch-icon turns into a black square on iOS');
});

test('favicon.ico packs real PNGs at the three sizes a browser asks for', () => {
  const buf = readFileSync(pub('favicon.ico'));
  assert.equal(buf.readUInt16LE(0), 0, 'reserved must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'type 1 is an icon');
  const count = buf.readUInt16LE(4);
  assert.equal(count, 3, 'ico should carry 16, 32 and 48 px entries');
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const width = buf.readUInt8(at) || 256;
    const height = buf.readUInt8(at + 1) || 256;
    const length = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    assert.equal(width, height, `entry ${i} must be square`);
    assert.equal(buf.readUInt16LE(at + 4), 1, `entry ${i} colour planes`);
    assert.equal(buf.readUInt16LE(at + 6), 32, `entry ${i} declared bit depth`);
    const png = decodePng(buf.subarray(offset, offset + length));
    assert.equal(png.header.width, width, `entry ${i} payload must match its directory width`);
    assert.equal(png.header.colorType, 6, `entry ${i} payload keeps alpha`);
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
});

test('the three committed SVGs carry the glyph, the right fills and no XML trap', () => {
  const spec = {
    'icon.svg': { fills: ['#4D6BFE'], rect: false },
    'icon-maskable.svg': { fills: ['#0f172a', '#4D6BFE'], rect: true },
    'icon-monochrome.svg': { fills: ['#ffffff'], rect: false },
  };
  for (const [name, { fills, rect }] of Object.entries(spec)) {
    const text = readFileSync(ic(name), 'utf-8');
    assert.match(text, /viewBox="0 0 50 50"/, `${name} viewBox`);
    for (const fill of fills) assert.ok(text.includes(`fill="${fill}"`), `${name} must use ${fill}`);
    assert.equal(text.includes('<rect'), rect, `${name} ground rect`);
    const d = /<path[^>]*\sd="([^"]+)"/.exec(text)?.[1];
    assert.ok(d && d.length > 3000, `${name} must carry the vendored whale path`);
    // A "--" inside an XML comment makes librsvg reject the whole file, which is
    // how the first generation run failed after writing a valid-looking SVG.
    const comment = /<!--([\s\S]*?)-->/.exec(text)?.[1];
    assert.ok(comment && comment.length > 0, `${name} keeps its provenance comment`);
    assert.equal(comment.includes('--'), false, `${name} has an XML-illegal "--" in its comment`);
  }
});

test('every manifest icon resolves to a committed file with real bytes', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'public', 'manifest.webmanifest'), 'utf-8'));
  for (const icon of manifest.icons) {
    const file = join(root, 'public', icon.src.replace(/^\//, ''));
    const bytes = readFileSync(file);
    assert.ok(bytes.length > 100, `${icon.src} is empty`);
  }
});
