/*
 * Procedural icon generator for Echo.
 *
 * Why this exists: shipping requires real PNG tray icons + a multi-resolution
 * .ico for the installer/window. Rather than depend on Sharp / ImageMagick /
 * a designer round-trip, we encode valid PNG (RGBA) + ICO (PNG-compressed)
 * files using only Node's stdlib. The art is intentionally minimal — a
 * recognisable mic glyph rendered into a 16×16 / 32×32 / 256×256 grid using
 * a hand-painted bitmap mask. Replace the source mask if you ever want
 * fancier art; everything else stays.
 *
 * Output:
 *   assets/tray-idle.png        16×16 RGBA
 *   assets/tray-recording.png   16×16 RGBA
 *   assets/tray-processing.png  16×16 RGBA
 *   assets/tray-error.png       16×16 RGBA
 *   assets/icon.png             256×256 RGBA (source for the .ico)
 *   assets/icon.ico             multi-resolution: 16, 32, 48, 256
 *
 * Run with:  node scripts/generate-icons.cjs
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');

// ---------- PNG encoder ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encode an RGBA pixel grid to a PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba   row-major, length = width*height*4
 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type RGBA
  ihdr.writeUInt8(0, 10);  // compression method (deflate)
  ihdr.writeUInt8(0, 11);  // filter method
  ihdr.writeUInt8(0, 12);  // interlace
  const ihdrChunk = pngChunk('IHDR', ihdr);

  // PNG requires a 1-byte filter type prefix per scanline; we use 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = 0;
    rgba.subarray(y * stride, (y + 1) * stride).copy
      ? rgba.subarray(y * stride, (y + 1) * stride).copy(raw, y * (1 + stride) + 1)
      : Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (1 + stride) + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const idatChunk = pngChunk('IDAT', compressed);
  const iendChunk = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// ---------- ICO encoder ----------

/**
 * Build a multi-image .ico file from an array of { size, png } entries.
 * Modern Vista+ ICOs accept PNG-compressed payloads directly, which keeps
 * this trivially simple compared to the legacy BMP+AND-mask format.
 * @param {Array<{ size: number, png: Buffer }>} images
 */
function encodeIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  const dirSize = headerSize + entrySize * images.length;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = icon
  header.writeUInt16LE(images.length, 4);  // image count

  const directory = Buffer.alloc(entrySize * images.length);
  let offset = dirSize;
  const payloads = [];

  images.forEach((img, idx) => {
    const entryOffset = idx * entrySize;
    // 0 means 256 in the ICO spec.
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, entryOffset + 0);  // width
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, entryOffset + 1);  // height
    directory.writeUInt8(0, entryOffset + 2);   // palette colour count
    directory.writeUInt8(0, entryOffset + 3);   // reserved
    directory.writeUInt16LE(1, entryOffset + 4);   // colour planes
    directory.writeUInt16LE(32, entryOffset + 6);  // bits per pixel
    directory.writeUInt32LE(img.png.length, entryOffset + 8);   // size of payload
    directory.writeUInt32LE(offset, entryOffset + 12);          // offset
    payloads.push(img.png);
    offset += img.png.length;
  });

  return Buffer.concat([header, directory, ...payloads]);
}

// ---------- Mic glyph (16×16 source) ----------

// 1 = filled mic, 0 = transparent. Hand-painted to read clearly at 16 px.
const MIC_MASK_16 = [
  '................',
  '................',
  '......XXXX......',
  '.....XXXXXX.....',
  '.....XXXXXX.....',
  '.....XXXXXX.....',
  '.....XXXXXX.....',
  '......XXXX......',
  '....X..XX..X....',
  '....X..XX..X....',
  '....XXXXXXXX....',
  '.......XX.......',
  '......XXXX......',
  '................',
  '................',
  '................',
];

// Distinguishing accent colour per state. The mic body itself stays a
// single dark colour so the glyph reads as "Echo"; the accent dot tints
// the bottom-right pixel cluster so each state is recognisable in the
// system tray at a glance.
const STATE_PALETTE = {
  idle:       { body: [0x1A, 0x1F, 0x2C, 0xFF], accent: null },
  recording:  { body: [0x1A, 0x1F, 0x2C, 0xFF], accent: [0xDC, 0x26, 0x26, 0xFF] },
  processing: { body: [0x1A, 0x1F, 0x2C, 0xFF], accent: [0x25, 0x63, 0xEB, 0xFF] },
  error:      { body: [0x1A, 0x1F, 0x2C, 0xFF], accent: [0xEA, 0x58, 0x0C, 0xFF] },
};

// 3×3 accent dot in the lower-right corner so the recording state in
// particular is unmissable.
const ACCENT_MASK_16 = [
  [12, 11], [13, 11], [14, 11],
  [12, 12], [13, 12], [14, 12],
  [12, 13], [13, 13], [14, 13],
];

function renderTray16(state) {
  const palette = STATE_PALETTE[state];
  if (!palette) throw new Error(`Unknown tray state: ${state}`);

  const W = 16;
  const H = 16;
  const rgba = new Uint8Array(W * H * 4);

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const idx = (y * W + x) * 4;
      if (MIC_MASK_16[y][x] === 'X') {
        rgba[idx + 0] = palette.body[0];
        rgba[idx + 1] = palette.body[1];
        rgba[idx + 2] = palette.body[2];
        rgba[idx + 3] = palette.body[3];
      }
    }
  }

  if (palette.accent) {
    for (const [x, y] of ACCENT_MASK_16) {
      const idx = (y * W + x) * 4;
      rgba[idx + 0] = palette.accent[0];
      rgba[idx + 1] = palette.accent[1];
      rgba[idx + 2] = palette.accent[2];
      rgba[idx + 3] = palette.accent[3];
    }
  }

  return encodePng(W, H, rgba);
}

// ---------- App icon (256×256 + scaled-down siblings for ICO) ----------

/**
 * Render a rounded-square brand tile at arbitrary size with a centred mic
 * glyph. The design echoes the in-app `AudioLines` motif but uses a clean
 * mic to avoid being mistaken for a music app.
 */
function renderAppIcon(size) {
  const rgba = new Uint8Array(size * size * 4);

  // Background gradient: vertical light-to-light (kept neutral so the icon
  // works on dark and light Windows themes). Slightly more saturated than
  // the in-app shell so the icon pops on the taskbar.
  const bgTop = [0xEF, 0xF1, 0xF6, 0xFF];
  const bgBot = [0xD9, 0xDD, 0xE6, 0xFF];

  // Rounded-rect mask radius scales with size.
  const r = Math.round(size * 0.22);

  for (let y = 0; y < size; y += 1) {
    const t = y / Math.max(1, size - 1);
    const row = [
      Math.round(bgTop[0] * (1 - t) + bgBot[0] * t),
      Math.round(bgTop[1] * (1 - t) + bgBot[1] * t),
      Math.round(bgTop[2] * (1 - t) + bgBot[2] * t),
      0xFF,
    ];
    for (let x = 0; x < size; x += 1) {
      // Rounded-rect alpha test.
      const inX = x >= r && x < size - r;
      const inY = y >= r && y < size - r;
      let inside = inX || inY;
      if (!inside) {
        // Corner check.
        const cx = x < r ? r : (x >= size - r ? size - 1 - r : x);
        const cy = y < r ? r : (y >= size - r ? size - 1 - r : y);
        const dx = x - cx;
        const dy = y - cy;
        inside = dx * dx + dy * dy <= r * r;
      }
      const idx = (y * size + x) * 4;
      if (inside) {
        rgba[idx + 0] = row[0];
        rgba[idx + 1] = row[1];
        rgba[idx + 2] = row[2];
        rgba[idx + 3] = row[3];
      }
    }
  }

  // Centred mic glyph rendered as a vector composition (capsule head +
  // stem + base bar). Coordinates are derived from the icon size so the
  // proportions stay identical at 16, 32, 48, 256.
  const cx = size / 2;
  const headTop = size * 0.20;
  const headBot = size * 0.58;
  const headHalfW = size * 0.13;
  const stemBot = size * 0.72;
  const baseY = size * 0.78;
  const baseHalfW = size * 0.22;
  const standBot = size * 0.84;
  const ink = [0x14, 0x18, 0x22, 0xFF];

  function plot(x, y) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= size || yi < 0 || yi >= size) return;
    const idx = (yi * size + xi) * 4;
    rgba[idx + 0] = ink[0];
    rgba[idx + 1] = ink[1];
    rgba[idx + 2] = ink[2];
    rgba[idx + 3] = ink[3];
  }

  // Capsule head (filled rounded rect made from a vertical rect + two
  // semicircles top/bottom).
  for (let y = headTop; y <= headBot; y += 1) {
    let halfW;
    if (y < headTop + headHalfW) {
      const dy = headTop + headHalfW - y;
      halfW = Math.sqrt(Math.max(0, headHalfW * headHalfW - dy * dy));
    } else if (y > headBot - headHalfW) {
      const dy = y - (headBot - headHalfW);
      halfW = Math.sqrt(Math.max(0, headHalfW * headHalfW - dy * dy));
    } else {
      halfW = headHalfW;
    }
    for (let x = cx - halfW; x <= cx + halfW; x += 1) {
      plot(x, y);
    }
  }

  // Stem from head bottom to base bar top.
  const stemHalfW = Math.max(1, size * 0.025);
  for (let y = headBot; y <= stemBot; y += 1) {
    for (let x = cx - stemHalfW; x <= cx + stemHalfW; x += 1) {
      plot(x, y);
    }
  }

  // Base bar (the U-shaped cradle is approximated as a thick bar).
  const barThick = Math.max(2, size * 0.04);
  for (let y = baseY; y <= baseY + barThick; y += 1) {
    for (let x = cx - baseHalfW; x <= cx + baseHalfW; x += 1) {
      plot(x, y);
    }
  }

  // Stand (centre vertical from bar to bottom).
  for (let y = baseY + barThick; y <= standBot; y += 1) {
    for (let x = cx - stemHalfW; x <= cx + stemHalfW; x += 1) {
      plot(x, y);
    }
  }

  return { rgba, png: encodePng(size, size, rgba) };
}

// ---------- Main ----------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfChanged(filePath, buffer) {
  try {
    const existing = fs.readFileSync(filePath);
    if (existing.equals(buffer)) {
      console.log(`unchanged: ${path.relative(ROOT, filePath)}`);
      return;
    }
  } catch {
    // File doesn't exist — fall through and write.
  }
  fs.writeFileSync(filePath, buffer);
  console.log(`wrote:     ${path.relative(ROOT, filePath)} (${buffer.length} bytes)`);
}

function main() {
  ensureDir(ASSETS_DIR);

  // Tray icons (16×16 RGBA).
  for (const state of ['idle', 'recording', 'processing', 'error']) {
    const buf = renderTray16(state);
    writeIfChanged(path.join(ASSETS_DIR, `tray-${state}.png`), buf);
  }

  // Source 256×256 app tile, plus 48 / 32 / 16 px siblings for the ICO.
  const sizes = [256, 48, 32, 16];
  const renders = sizes.map((s) => ({ size: s, ...renderAppIcon(s) }));
  writeIfChanged(path.join(ASSETS_DIR, 'icon.png'), renders.find((r) => r.size === 256).png);
  const ico = encodeIco(renders.map(({ size, png }) => ({ size, png })));
  writeIfChanged(path.join(ASSETS_DIR, 'icon.ico'), ico);
}

main();
