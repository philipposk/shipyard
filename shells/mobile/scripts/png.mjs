// Tiny PNG reader/writer and image helpers with no packages: only node:zlib.
// Used to make the app icon without a transparent layer (the App Store refuses icons with one), to resize
// the Android icons and splash pictures, and by store-check to read an image's size.
// Shipyard copies this file into the app's mobile/scripts folder; the plugin's own scripts import it from shells/mobile/scripts.
import { inflateSync, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** Size and colour type from the first bytes: { width, height, bitDepth, colorType, hasAlpha } or null. */
export function pngInfo(buf) {
  if (!isPng(buf) || buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType,
    interlaced: buf[28] === 1,
    // 4 = grey + alpha, 6 = RGBA. A palette image (3) can also carry transparency in a tRNS chunk.
    hasAlpha: colorType === 4 || colorType === 6 || (colorType === 3 && buf.includes('tRNS', 33, 'latin1')),
  };
}

/** Decode an 8-bit, non-interlaced PNG to { width, height, data } where data is RGBA bytes. */
export function decodePng(buf) {
  const info = pngInfo(buf);
  if (!info) throw new Error('This is not a PNG file.');
  if (info.bitDepth !== 8 || info.interlaced) throw new Error('Only 8-bit PNG pictures that are not interlaced are supported. Save the picture again as a normal PNG.');
  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[info.colorType];
  if (!channels) throw new Error('This PNG colour type is not supported.');
  let palette = null;
  let trns = null;
  const idat = [];
  for (let pos = 8; pos + 8 <= buf.length;) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IDAT') idat.push(body);
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = info;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('The PNG file is cut short.');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[rowOut + x - channels] : 0;
      const b = y > 0 ? px[rowOut - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[rowOut - stride + x - channels] : 0;
      let v = raw[rowIn + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter > 4) throw new Error('The PNG file uses an unknown filter.');
      px[rowOut + x] = v & 0xff;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r; let g; let b; let a = 255;
    if (info.colorType === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    else if (info.colorType === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (info.colorType === 0) { r = g = b = px[i]; }
    else if (info.colorType === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else {
      if (!palette) throw new Error('The PNG palette is missing.');
      const idx = px[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width, height, data };
}

/** Encode { width, height, data (RGBA) } as a PNG. With { alpha: false } the picture has no transparent layer at all. */
export function encodePng({ width, height, data }, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (stride + 1) + 1 + x * channels;
      raw[d] = data[s]; raw[d + 1] = data[s + 1]; raw[d + 2] = data[s + 2];
      if (alpha) raw[d + 3] = data[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** "#rgb" or "#rrggbb" to [r, g, b], or null. */
export function parseHex(text) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** A picture of one colour. */
export function solid(width, height, rgb, a = 255) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = a;
  }
  return { width, height, data };
}

/** Put `top` on `bottom` at (x, y). Changes and returns `bottom`. */
export function overlay(bottom, top, x, y) {
  for (let ty = 0; ty < top.height; ty++) {
    const by = y + ty;
    if (by < 0 || by >= bottom.height) continue;
    for (let tx = 0; tx < top.width; tx++) {
      const bx = x + tx;
      if (bx < 0 || bx >= bottom.width) continue;
      const s = (ty * top.width + tx) * 4;
      const d = (by * bottom.width + bx) * 4;
      const sa = top.data[s + 3] / 255;
      if (sa === 0) continue;
      const da = bottom.data[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) {
        bottom.data[d + k] = Math.round((top.data[s + k] * sa + bottom.data[d + k] * da * (1 - sa)) / (oa || 1));
      }
      bottom.data[d + 3] = Math.round(oa * 255);
    }
  }
  return bottom;
}

/** Same picture on a solid background, with no transparency left. */
export function flatten(img, rgb) {
  return overlay(solid(img.width, img.height, rgb), img, 0, 0);
}

/** A new picture of the wanted size. Smaller: every new pixel is the average of the pixels it covers. Larger: smooth blend. */
export function resize(img, width, height) {
  if (width === img.width && height === img.height) return { width, height, data: Buffer.from(img.data) };
  const out = Buffer.alloc(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0; let weight = 0;
      if (sx >= 1 && sy >= 1) {
        const x0 = x * sx; const x1 = (x + 1) * sx;
        const y0 = y * sy; const y1 = (y + 1) * sy;
        for (let py = Math.floor(y0); py < Math.min(img.height, Math.ceil(y1)); py++) {
          const wy = Math.min(py + 1, y1) - Math.max(py, y0);
          for (let px = Math.floor(x0); px < Math.min(img.width, Math.ceil(x1)); px++) {
            const w = wy * (Math.min(px + 1, x1) - Math.max(px, x0));
            const i = (py * img.width + px) * 4;
            const pa = img.data[i + 3] / 255;
            r += img.data[i] * pa * w; g += img.data[i + 1] * pa * w; b += img.data[i + 2] * pa * w; a += pa * w;
            weight += w;
          }
        }
      } else {
        const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
        const x0 = Math.floor(fx); const y0 = Math.floor(fy);
        const x1 = Math.min(img.width - 1, x0 + 1); const y1 = Math.min(img.height - 1, y0 + 1);
        const tx = fx - x0; const ty = fy - y0;
        for (const [px, py, w] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]]) {
          const i = (py * img.width + px) * 4;
          const pa = img.data[i + 3] / 255;
          r += img.data[i] * pa * w; g += img.data[i + 1] * pa * w; b += img.data[i + 2] * pa * w; a += pa * w;
          weight += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / weight) * 255);
      }
    }
  }
  return { width, height, data: out };
}

/** A splash picture: one colour with the logo in the middle (`size` is the logo's share of the shorter side). */
export function splashPicture(width, height, bgRgb, logo, size = 0.28) {
  const side = Math.max(1, Math.round(Math.min(width, height) * size));
  const base = solid(width, height, bgRgb);
  return overlay(base, resize(logo, side, side), Math.round((width - side) / 2), Math.round((height - side) / 2));
}

/** An Android adaptive-icon foreground: the logo in the middle two thirds of a transparent square (the rest may be cropped). */
export function adaptiveForeground(logo, side) {
  const inner = Math.round(side * 0.62);
  const base = solid(side, side, [0, 0, 0], 0);
  return overlay(base, resize(logo, inner, inner), Math.round((side - inner) / 2), Math.round((side - inner) / 2));
}

/** The icon cut to a circle (older Android phones show it round). */
export function roundIcon(img) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  const r = img.width / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = x + 0.5 - r; const dy = y + 0.5 - r;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const edge = Math.min(1, Math.max(0, r - dist));
      out.data[(y * img.width + x) * 4 + 3] = Math.round(out.data[(y * img.width + x) * 4 + 3] * edge);
    }
  }
  return out;
}
