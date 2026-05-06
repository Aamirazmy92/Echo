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

// ---------- PNG decoder ----------

/**
 * Decode an 8-bit RGB or RGBA PNG to a row-major RGBA pixel buffer.
 *
 * Supports the subset of PNG features we need to ingest a hand-authored
 * source asset (`src/renderer/assets/echo-logo.png`): color types 2 (RGB)
 * and 6 (RGBA), bit depth 8, no interlacing. Anything else throws — we
 * surface those at build time rather than silently shipping a broken
 * tray icon.
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
function decodePng(buf) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
    throw new Error('Not a PNG file');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prevLine = new Uint8Array(stride);
  const curLine = new Uint8Array(stride);
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[pos];
    pos += 1;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? curLine[x - channels] : 0;
      const up = prevLine[x];
      const upLeft = x >= channels ? prevLine[x - channels] : 0;
      const raw = inflated[pos];
      pos += 1;
      let val;
      switch (filter) {
        case 0: val = raw; break;
        case 1: val = (raw + left) & 0xFF; break;
        case 2: val = (raw + up) & 0xFF; break;
        case 3: val = (raw + ((left + up) >> 1)) & 0xFF; break;
        case 4: {
          // Paeth predictor — picks whichever of left / up / up-left is
          // closest to the linear extrapolation `left + up - upLeft`.
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          let pred;
          if (pa <= pb && pa <= pc) pred = left;
          else if (pb <= pc) pred = up;
          else pred = upLeft;
          val = (raw + pred) & 0xFF;
          break;
        }
        default: throw new Error(`Unsupported PNG filter: ${filter}`);
      }
      curLine[x] = val;
    }

    for (let x = 0; x < width; x += 1) {
      const dstIdx = (y * width + x) * 4;
      const srcIdx = x * channels;
      rgba[dstIdx + 0] = curLine[srcIdx + 0];
      rgba[dstIdx + 1] = curLine[srcIdx + 1];
      rgba[dstIdx + 2] = curLine[srcIdx + 2];
      rgba[dstIdx + 3] = channels === 4 ? curLine[srcIdx + 3] : 255;
    }
    prevLine.set(curLine);
  }

  return { width, height, rgba };
}

// ---------- Box-average downscaler ----------

/**
 * Resize an RGBA buffer using area-weighted averaging. Premultiplies
 * alpha while accumulating so transparent pixels don't bleed their
 * (often-undefined) RGB into the result. Box averaging is ideal for
 * the large downscale ratios we hit for tray/icon sizes (1024 → 256 /
 * 48 / 32 / 16); the high-frequency detail of the source mark stays
 * visually intact without the ringing a Lanczos kernel would add at
 * 16 px.
 *
 * @param {Uint8Array} src
 * @param {number} sw  source width
 * @param {number} sh  source height
 * @param {number} dw  destination width
 * @param {number} dh  destination height
 * @returns {Uint8Array} row-major RGBA, length = dw*dh*4
 */
function resizeRgba(src, sw, sh, dw, dh) {
  const dst = new Uint8Array(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = dy * yRatio;
    const y1 = (dy + 1) * yRatio;
    const sy0 = Math.floor(y0);
    const sy1 = Math.min(sh, Math.ceil(y1));

    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = dx * xRatio;
      const x1 = (dx + 1) * xRatio;
      const sx0 = Math.floor(x0);
      const sx1 = Math.min(sw, Math.ceil(x1));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let totalWeight = 0;

      for (let sy = sy0; sy < sy1; sy += 1) {
        const yWeight = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = sx0; sx < sx1; sx += 1) {
          const xWeight = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const w = xWeight * yWeight;
          const idx = (sy * sw + sx) * 4;
          const sa = src[idx + 3] / 255;
          // Premultiplied accumulation — the standard fix for the
          // "halos around transparency" artefact you get when you
          // average raw RGB through translucent pixels.
          r += src[idx + 0] * sa * w;
          g += src[idx + 1] * sa * w;
          b += src[idx + 2] * sa * w;
          a += src[idx + 3] * w;
          totalWeight += w;
        }
      }

      const dstIdx = (dy * dw + dx) * 4;
      const finalA = totalWeight > 0 ? a / totalWeight : 0;
      if (finalA > 0) {
        const inv = 1 / (finalA / 255);
        dst[dstIdx + 0] = Math.max(0, Math.min(255, Math.round((r / totalWeight) * inv)));
        dst[dstIdx + 1] = Math.max(0, Math.min(255, Math.round((g / totalWeight) * inv)));
        dst[dstIdx + 2] = Math.max(0, Math.min(255, Math.round((b / totalWeight) * inv)));
      }
      dst[dstIdx + 3] = Math.round(finalA);
    }
  }

  return dst;
}

/**
 * Overlay a small filled circle (with a darker outline ring for
 * legibility on light Windows themes) in the lower-right of an RGBA
 * tile. Used to tag the tray icon with its current state without
 * having to re-author four artwork variants.
 *
 * @param {Uint8Array} rgba
 * @param {number} size
 * @param {[number, number, number, number]|null} accent
 */
function compositeStateDot(rgba, size, accent) {
  if (!accent) return rgba;
  const cx = Math.round(size * 0.78);
  const cy = Math.round(size * 0.78);
  const outerR = size * 0.18;
  const innerR = size * 0.13;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= outerR) {
        setRgba(rgba, size, x, y, [0x04, 0x05, 0x12, 0xEE]);
      }
      if (dist <= innerR) {
        setRgba(rgba, size, x, y, accent);
      }
    }
  }
  return rgba;
}

// ---------- Tray icon (16×16) ----------

// Brand colours used for both the tray and the larger app tile.
const BRAND_TOP    = [0x05, 0x07, 0x16];   // indigo-700 ish
const BRAND_BOT    = [0x0E, 0x12, 0x34];   // indigo-500 ish
const BRAND_BORDER = [0x7C, 0x8C, 0xFF, 0x28];
const BRAND_WHITE  = [0xD8, 0xE5, 0xFF, 0xFF];

// Per-state accent dot. The tray body is the same indigo gradient + white
// E for every state, so the only thing that changes between idle/recording/
// processing/error is a small dot in the lower-right corner.
const STATE_PALETTE = {
  idle:       { accent: null },
  recording:  { accent: [0xEF, 0x44, 0x44, 0xFF] },
  processing: { accent: [0xFA, 0xCC, 0x15, 0xFF] },
  error:      { accent: [0xEA, 0x58, 0x0C, 0xFF] },
};

// White "E" mask drawn into a 16×16 grid. Sits on the left half so a small
// state accent can live in the lower-right without overlapping it.
const E_MASK_16 = [
  '................',
  '................',
  '....XXXXX.......',
  '...XXXXXXX......',
  '..XXX...XX......',
  '..XX....XX......',
  '..XX.XXXXX......',
  '..XXXXXXXX......',
  '..XXX...........',
  '...XXXXXXX......',
  '....XXXXX.......',
  '................',
  '................',
  '................',
  '................',
  '................',
];

const ACCENT_MASK_16 = [
  [11, 11], [12, 11], [13, 11],
  [11, 12], [12, 12], [13, 12],
  [11, 13], [12, 13], [13, 13],
];

function setRgba(rgba, w, x, y, color) {
  const idx = (y * w + x) * 4;
  const a = (color[3] !== undefined ? color[3] : 0xFF) / 255;
  const inv = 1 - a;
  rgba[idx + 0] = Math.round(color[0] * a + rgba[idx + 0] * inv);
  rgba[idx + 1] = Math.round(color[1] * a + rgba[idx + 1] * inv);
  rgba[idx + 2] = Math.round(color[2] * a + rgba[idx + 2] * inv);
  rgba[idx + 3] = Math.min(255, Math.round((color[3] ?? 0xFF) + rgba[idx + 3] * inv));
}

function renderTray16(state) {
  const palette = STATE_PALETTE[state];
  if (!palette) throw new Error(`Unknown tray state: ${state}`);

  const W = 16;
  const H = 16;
  const rgba = new Uint8Array(W * H * 4);

  // Rounded-square indigo background so the tray icon is a coloured tile
  // (visible on both light and dark Windows themes), not a transparent
  // glyph that disappears against a similar-toned taskbar.
  const r = 3;
  for (let y = 0; y < H; y += 1) {
    const t = y / Math.max(1, H - 1);
    const bg = [
      Math.round(BRAND_TOP[0] * (1 - t) + BRAND_BOT[0] * t),
      Math.round(BRAND_TOP[1] * (1 - t) + BRAND_BOT[1] * t),
      Math.round(BRAND_TOP[2] * (1 - t) + BRAND_BOT[2] * t),
      0xFF,
    ];
    for (let x = 0; x < W; x += 1) {
      const inX = x >= r && x < W - r;
      const inY = y >= r && y < H - r;
      let inside = inX || inY;
      if (!inside) {
        const cx = x < r ? r : (x >= W - r ? W - 1 - r : x);
        const cy = y < r ? r : (y >= H - r ? H - 1 - r : y);
        const dx = x - cx;
        const dy = y - cy;
        inside = dx * dx + dy * dy <= r * r;
      }
      if (inside) {
        const idx = (y * W + x) * 4;
        rgba[idx + 0] = bg[0];
        rgba[idx + 1] = bg[1];
        rgba[idx + 2] = bg[2];
        rgba[idx + 3] = bg[3];
      }
    }
  }

  // White E stamped on top of the indigo tile.
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (E_MASK_16[y][x] === 'X') {
        setRgba(rgba, W, x, y, BRAND_WHITE);
      }
    }
  }

  if (palette.accent) {
    for (const [x, y] of ACCENT_MASK_16) {
      setRgba(rgba, W, x, y, palette.accent);
    }
  }

  return encodePng(W, H, rgba);
}

function renderTrayIcon(state) {
  const palette = STATE_PALETTE[state];
  if (!palette) throw new Error(`Unknown tray state: ${state}`);

  const size = 32;
  const { rgba } = renderAppIcon(size);

  if (palette.accent) {
    const cx = Math.round(size * 0.78);
    const cy = Math.round(size * 0.78);
    const outer = size * 0.15;
    const inner = size * 0.105;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist <= outer) {
          setRgba(rgba, size, x, y, [0x04, 0x05, 0x12, 0xEE]);
        }
        if (dist <= inner) {
          setRgba(rgba, size, x, y, palette.accent);
        }
      }
    }
  }

  return encodePng(size, size, rgba);
}

// ---------- App icon (256×256 + scaled-down siblings for ICO) ----------

/**
 * Render a rounded-square brand tile at arbitrary size with a centred mic
 * glyph. The design echoes the in-app `AudioLines` motif but uses a clean
 * mic to avoid being mistaken for a music app.
 */
function renderAppIcon(size) {
  const rgba = new Uint8Array(size * size * 4);

  const bgTop = [0x04, 0x05, 0x12, 0xFF];
  const bgBot = [0x12, 0x16, 0x3B, 0xFF];
  const r = Math.round(size * 0.22);

  function setPixel(x, y, color) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= size || yi < 0 || yi >= size) return;
    const idx = (yi * size + xi) * 4;
    const a = color[3] / 255;
    const inv = 1 - a;
    rgba[idx + 0] = Math.round(color[0] * a + rgba[idx + 0] * inv);
    rgba[idx + 1] = Math.round(color[1] * a + rgba[idx + 1] * inv);
    rgba[idx + 2] = Math.round(color[2] * a + rgba[idx + 2] * inv);
    rgba[idx + 3] = Math.min(255, Math.round(color[3] + rgba[idx + 3] * inv));
  }

  function inRoundRect(x, y, inset, radius) {
    const min = inset;
    const max = size - 1 - inset;
    const cx = x < min + radius ? min + radius : (x > max - radius ? max - radius : x);
    const cy = y < min + radius ? min + radius : (y > max - radius ? max - radius : y);
    const dx = x - cx;
    const dy = y - cy;
    return x >= min && x <= max && y >= min && y <= max && dx * dx + dy * dy <= radius * radius;
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!inRoundRect(x, y, 0, r)) continue;
      const t = (x + y) / (2 * Math.max(1, size - 1));
      const glow = Math.max(0, 1 - Math.hypot((x - size * 0.62) / (size * 0.48), (y - size * 0.36) / (size * 0.44)));
      const idx = (y * size + x) * 4;
      rgba[idx + 0] = Math.round(bgTop[0] * (1 - t) + bgBot[0] * t + 10 * glow);
      rgba[idx + 1] = Math.round(bgTop[1] * (1 - t) + bgBot[1] * t + 12 * glow);
      rgba[idx + 2] = Math.round(bgTop[2] * (1 - t) + bgBot[2] * t + 28 * glow);
      rgba[idx + 3] = 0xFF;
    }
  }
  // Hairline outer border so the tile reads as a discrete shape on light
  // backgrounds (Windows light-theme taskbar) too.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inRoundRect(x, y, 0, r) && !inRoundRect(x, y, Math.max(1, size * 0.006), Math.max(1, r - size * 0.006))) {
        setPixel(x, y, BRAND_BORDER);
      }
    }
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function resolveColor(color, x, y, coverage) {
    const resolved = typeof color === 'function' ? color(x, y) : color;
    return [resolved[0], resolved[1], resolved[2], Math.round(resolved[3] * coverage)];
  }

  function drawCapsule(x1, y1, x2, y2, width, color) {
    const minX = Math.floor(Math.min(x1, x2) - width);
    const maxX = Math.ceil(Math.max(x1, x2) + width);
    const minY = Math.floor(Math.min(y1, y2) - width);
    const maxY = Math.ceil(Math.max(y1, y2) + width);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy || 1;
    const radius = width / 2;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq));
        const px = x1 + t * dx;
        const py = y1 + t * dy;
        const dist = Math.hypot(x - px, y - py);
        if (dist <= radius) {
          setPixel(x, y, resolveColor(color, x, y, 1));
        } else if (dist <= radius + 1) {
          setPixel(x, y, resolveColor(color, x, y, 1 - (dist - radius)));
        }
      }
    }
  }

  function drawArc(cx, cy, radius, width, startDeg, endDeg, color) {
    const minX = Math.floor(cx - radius - width);
    const maxX = Math.ceil(cx + radius + width);
    const minY = Math.floor(cy - radius - width);
    const maxY = Math.ceil(cy + radius + width);
    const halfWidth = width / 2;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const angle = (Math.atan2(y - cy, x - cx) * 180 / Math.PI + 360) % 360;
        const inAngle = startDeg <= endDeg ? angle >= startDeg && angle <= endDeg : angle >= startDeg || angle <= endDeg;
        if (!inAngle) continue;
        const dist = Math.hypot(x - cx, y - cy);
        const delta = Math.abs(dist - radius);
        if (delta <= halfWidth) {
          setPixel(x, y, resolveColor(color, x, y, 1));
        } else if (delta <= halfWidth + 1) {
          setPixel(x, y, resolveColor(color, x, y, 1 - (delta - halfWidth)));
        }
      }
    }
  }

  const markTop = [0xF1, 0xF6, 0xFF, 0xFF];
  const markMid = [0x83, 0xB1, 0xFF, 0xFF];
  const markBot = [0x4D, 0x49, 0xFF, 0xFF];
  const markColor = (x, y) => {
    const t = clamp01((y - size * 0.24) / (size * 0.58));
    const first = t < 0.5 ? markTop : markMid;
    const second = t < 0.5 ? markMid : markBot;
    const localT = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const shine = Math.max(0, 1 - Math.hypot((x - size * 0.58) / (size * 0.44), (y - size * 0.33) / (size * 0.34)));
    return [
      Math.min(255, Math.round(first[0] * (1 - localT) + second[0] * localT + 18 * shine)),
      Math.min(255, Math.round(first[1] * (1 - localT) + second[1] * localT + 22 * shine)),
      Math.min(255, Math.round(first[2] * (1 - localT) + second[2] * localT + 8 * shine)),
      0xFF,
    ];
  };
  const drawEchoMark = (ox, oy, scale, color) => {
    const cx = size * (0.57 + ox);
    const cy = size * (0.52 + oy);
    const radius = size * 0.285 * scale;
    const thick = size * 0.158 * scale;
    drawArc(cx, cy, radius, thick, 22, 335, color);
    drawCapsule(cx - radius * 0.32, cy, cx + radius * 0.86, cy, thick * 0.92, color);
  };

  drawEchoMark(-0.21, 0.01, 0.96, [0x1B, 0x1F, 0x78, 0x8A]);
  drawEchoMark(-0.115, 0.00, 0.98, [0x30, 0x49, 0xCC, 0xB8]);
  drawEchoMark(0.00, 0.00, 1.00, markColor);

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

// Designer-authored brand mark, used as the source-of-truth for every
// icon size we emit. Lives inside the renderer's Vite root so it can
// also be `import`ed by the React app without a duplicate copy. If this
// file is removed the script falls back to the procedural renderer
// below so existing build steps keep working.
const SOURCE_LOGO = path.join(ROOT, 'src', 'renderer', 'assets', 'echo-logo.png');

/**
 * Hand-authored PNGs almost always come with a generous transparent
 * margin around the artwork (so the source displays well as a hero
 * image). Windows then renders our `.ico` inside a fixed taskbar slot
 * and includes all that padding, leaving the visible mark looking
 * tiny. Crop to the non-transparent bounding box, expand to a square
 * around the visual centre, and add a small uniform breathing margin
 * so the mark fills its canvas without touching the edges.
 *
 * @param {{ rgba: Uint8Array, width: number, height: number }} source
 * @param {number} marginPct  fraction of the cropped side to reserve as padding
 */
function tightlyFrameSource(source, marginPct = 0.04) {
  const { rgba, width: w, height: h } = source;
  // Treat near-transparent pixels as empty — JPEG-resaved or anti-aliased
  // sources can have stray alpha=1..3 noise in their "transparent" margins.
  const alphaThreshold = 8;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = rgba[(y * w + x) * 4 + 3];
      if (a > alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return source; // fully transparent — nothing to do

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const side = Math.max(bboxW, bboxH);
  const padding = Math.round(side * marginPct);
  const finalSide = side + padding * 2;
  const cx = minX + bboxW / 2;
  const cy = minY + bboxH / 2;
  const startX = Math.round(cx - finalSide / 2);
  const startY = Math.round(cy - finalSide / 2);

  const out = new Uint8Array(finalSide * finalSide * 4);
  for (let dy = 0; dy < finalSide; dy += 1) {
    const sy = startY + dy;
    if (sy < 0 || sy >= h) continue;
    for (let dx = 0; dx < finalSide; dx += 1) {
      const sx = startX + dx;
      if (sx < 0 || sx >= w) continue;
      const srcIdx = (sy * w + sx) * 4;
      const dstIdx = (dy * finalSide + dx) * 4;
      out[dstIdx + 0] = rgba[srcIdx + 0];
      out[dstIdx + 1] = rgba[srcIdx + 1];
      out[dstIdx + 2] = rgba[srcIdx + 2];
      out[dstIdx + 3] = rgba[srcIdx + 3];
    }
  }
  return { rgba: out, width: finalSide, height: finalSide };
}

function renderFromSource(source) {
  const framed = tightlyFrameSource(source);
  if (framed !== source) {
    console.log(`framed:    cropped to ${framed.width}\u00D7${framed.height} (was ${source.width}\u00D7${source.height})`);
  }

  // Resize the framed source down to each icon size in one pass so we
  // don't redo the (relatively expensive) resample work four times.
  const renders = [256, 48, 32, 16].map((s) => {
    const rgba = resizeRgba(framed.rgba, framed.width, framed.height, s, s);
    return { size: s, rgba, png: encodePng(s, s, rgba) };
  });

  writeIfChanged(path.join(ASSETS_DIR, 'icon.png'), renders.find((r) => r.size === 256).png);
  const ico = encodeIco(renders.map(({ size, png }) => ({ size, png })));
  writeIfChanged(path.join(ASSETS_DIR, 'icon.ico'), ico);

  // Tray icons share one 32×32 base — we just composite the per-state
  // accent dot on top of a fresh copy. Idle stays as the bare brand mark.
  const traySize = 32;
  const trayBase = resizeRgba(framed.rgba, framed.width, framed.height, traySize, traySize);
  for (const state of ['idle', 'recording', 'processing', 'error']) {
    const palette = STATE_PALETTE[state];
    const rgba = new Uint8Array(trayBase);
    if (palette && palette.accent) {
      compositeStateDot(rgba, traySize, palette.accent);
    }
    writeIfChanged(path.join(ASSETS_DIR, `tray-${state}.png`), encodePng(traySize, traySize, rgba));
  }
}

function renderProcedural() {
  // Tray icons (32×32 RGBA).
  for (const state of ['idle', 'recording', 'processing', 'error']) {
    const buf = renderTrayIcon(state);
    writeIfChanged(path.join(ASSETS_DIR, `tray-${state}.png`), buf);
  }

  // Source 256×256 app tile, plus 48 / 32 / 16 px siblings for the ICO.
  const sizes = [256, 48, 32, 16];
  const renders = sizes.map((s) => ({ size: s, ...renderAppIcon(s) }));
  writeIfChanged(path.join(ASSETS_DIR, 'icon.png'), renders.find((r) => r.size === 256).png);
  const ico = encodeIco(renders.map(({ size, png }) => ({ size, png })));
  writeIfChanged(path.join(ASSETS_DIR, 'icon.ico'), ico);
}

function main() {
  ensureDir(ASSETS_DIR);

  if (fs.existsSync(SOURCE_LOGO)) {
    try {
      const source = decodePng(fs.readFileSync(SOURCE_LOGO));
      console.log(`source:    ${path.relative(ROOT, SOURCE_LOGO)} (${source.width}\u00D7${source.height})`);
      renderFromSource(source);
      return;
    } catch (err) {
      console.warn(`[generate-icons] failed to use ${path.relative(ROOT, SOURCE_LOGO)}: ${err.message}`);
      console.warn('[generate-icons] falling back to procedural renderer');
    }
  } else {
    console.log(`[generate-icons] ${path.relative(ROOT, SOURCE_LOGO)} not found, using procedural renderer`);
  }

  renderProcedural();
}

main();
