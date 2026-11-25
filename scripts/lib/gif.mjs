// A small animated GIF encoder with no dependencies, for quick-sketch variations.
// Input: RGBA frames of one size. Output: a looping GIF89a Buffer with one shared palette.
// Sketches use a few greys and one accent, so the palette is usually exact; larger colour
// counts fall back to a fixed 216-colour cube plus 40 greys, matched to the nearest colour.

const MAX_CODE = 4096;

/** RGBA pixel to an RGB number, transparent pixels laid on white. */
function rgbAt(rgba, i) {
  const a = rgba[i + 3] / 255;
  const r = Math.round(rgba[i] * a + 255 * (1 - a));
  const g = Math.round(rgba[i + 1] * a + 255 * (1 - a));
  const b = Math.round(rgba[i + 2] * a + 255 * (1 - a));
  return (r << 16) | (g << 8) | b;
}

/** The fallback palette: 6x6x6 colour cube plus 40 greys (256 entries). */
export function fallbackPalette() {
  const out = [];
  const steps = [0, 51, 102, 153, 204, 255];
  for (const r of steps) for (const g of steps) for (const b of steps) out.push((r << 16) | (g << 8) | b);
  for (let i = 0; i < 40; i++) {
    const v = Math.round(((i + 1) * 255) / 41);
    out.push((v << 16) | (v << 8) | v);
  }
  return out;
}

function nearest(palette, rgb) {
  const r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = (p >> 16) - r, dg = ((p >> 8) & 255) - g, db = (p & 255) - b;
    const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
    if (d < bestD) {
      bestD = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

/** One palette for all frames, and each frame as palette indices. */
export function indexFrames(frames) {
  const seen = new Map();
  for (const f of frames) {
    for (let i = 0; i < f.rgba.length; i += 4) {
      const c = rgbAt(f.rgba, i);
      if (!seen.has(c)) {
        seen.set(c, seen.size);
        if (seen.size > 256) break;
      }
    }
    if (seen.size > 256) break;
  }
  const exact = seen.size <= 256;
  const palette = exact ? [...seen.keys()] : fallbackPalette();
  const lookup = exact ? seen : new Map();
  const indexed = frames.map((f) => {
    const out = new Uint8Array(f.width * f.height);
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      const c = rgbAt(f.rgba, i);
      let idx = lookup.get(c);
      if (idx === undefined) {
        idx = nearest(palette, c);
        lookup.set(c, idx);
      }
      out[p] = idx;
    }
    return out;
  });
  return { palette, indexed, exact };
}

/** LZW-compress palette indices the way GIF expects (variable code size, clear at 4096). */
export function lzwEncode(indices, minCodeSize) {
  const bytes = [];
  let cur = 0, bits = 0;
  const write = (code, size) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(cur & 255);
      cur >>>= 8;
      bits -= 8;
    }
  };
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let table = new Map();
  write(clear, size);
  if (!indices.length) {
    write(eoi, size);
    if (bits > 0) bytes.push(cur & 255);
    return bytes;
  }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    write(prefix, size);
    if (next === MAX_CODE) {
      write(clear, size);
      table = new Map();
      size = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  write(prefix, size);
  write(eoi, size);
  if (bits > 0) bytes.push(cur & 255);
  return bytes;
}

/**
 * Encode frames ([{ width, height, rgba }], all one size) as a looping GIF.
 * delayMs: one number or one per frame. loop: 0 means forever.
 */
export function encodeGif(frames, { delayMs = 700, loop = 0 } = {}) {
  if (!frames.length) throw new Error('A GIF needs at least one frame.');
  const { width, height } = frames[0];
  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error('Every frame must be the same size.');
    if (f.rgba.length !== width * height * 4) throw new Error('A frame has the wrong number of pixels.');
  }
  if (width > 0xffff || height > 0xffff) throw new Error('The frames are too large for a GIF.');
  const { palette, indexed } = indexFrames(frames);
  let depth = 1;
  while (1 << depth < palette.length) depth++;
  const tableSize = 1 << depth;
  const minCodeSize = Math.max(2, depth);
  const out = [];
  const u16 = (n) => out.push(n & 255, (n >> 8) & 255);
  for (const ch of 'GIF89a') out.push(ch.charCodeAt(0));
  u16(width);
  u16(height);
  out.push(0x80 | ((depth - 1) << 4) | (depth - 1), 0, 0);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] ?? 0;
    out.push(c >> 16, (c >> 8) & 255, c & 255);
  }
  // Netscape loop extension
  out.push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') out.push(ch.charCodeAt(0));
  out.push(0x03, 0x01);
  u16(loop);
  out.push(0x00);
  indexed.forEach((pixels, n) => {
    const delay = Array.isArray(delayMs) ? delayMs[n] ?? delayMs[delayMs.length - 1] : delayMs;
    out.push(0x21, 0xf9, 0x04, 0x04);
    u16(Math.max(2, Math.round(delay / 10)));
    out.push(0x00, 0x00);
    out.push(0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    out.push(0x00, minCodeSize);
    const data = lzwEncode(pixels, minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255);
      out.push(block.length, ...block);
    }
    out.push(0x00);
  });
  out.push(0x3b);
  return Buffer.from(out);
}
