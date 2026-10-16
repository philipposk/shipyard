// Colour helpers for the website capture: read what the browser reports, flatten transparency,
// and group near-identical colours so "the three main colours" means something.
import { contrast, hexToHsl, hexToRgb, luminance, mix, rgbToHex } from '../color.mjs';

const clamp255 = (n) => Math.min(255, Math.max(0, Math.round(n)));

/**
 * Read a CSS colour into { r, g, b, a } (0..255, a 0..1). Handles #rgb, #rrggbb, #rrggbbaa, rgb()/rgba()
 * in the old and new syntax, and "transparent". Returns null for anything else (the browser side
 * converts every other colour space to rgb before sending).
 */
export function parseCssColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) {
    const [r, g, b, a = 'f'] = m[1].split('');
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) / 255 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p) => (p.endsWith('%') ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p));
    const [r, g, b] = parts.slice(0, 3).map(num);
    let a = 1;
    if (parts[3] !== undefined) a = parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
    if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: Math.min(1, Math.max(0, a)) };
  }
  return null;
}

/** [r, g, b, a] (from the browser) -> { r, g, b, a } */
export const fromArray = (arr) => (Array.isArray(arr) && arr.length >= 3 ? { r: clamp255(arr[0]), g: clamp255(arr[1]), b: clamp255(arr[2]), a: arr[3] === undefined ? 1 : Math.min(1, Math.max(0, arr[3])) } : null);

/** Anything the capture may hold (css string, [r,g,b,a], {r,g,b,a}) -> { r, g, b, a } or null */
export function toRgba(value) {
  if (typeof value === 'string') return parseCssColor(value);
  if (Array.isArray(value)) return fromArray(value);
  if (value && typeof value === 'object' && 'r' in value) return fromArray([value.r, value.g, value.b, value.a ?? 1]);
  return null;
}

export const isTransparent = (c, min = 0.05) => !c || c.a < min;

/** Lay a possibly see-through colour over a solid hex backdrop -> "#rrggbb" */
export function flatten(value, backdropHex = '#ffffff') {
  const c = toRgba(value);
  if (!c) return null;
  const bg = hexToRgb(backdropHex);
  const a = c.a;
  return rgbToHex([c.r * a + bg[0] * (1 - a), c.g * a + bg[1] * (1 - a), c.b * a + bg[2] * (1 - a)]);
}

/** How far apart two colours look (straight RGB distance, 0..441). Good enough to merge near-twins. */
export function colorDistance(a, b) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * Group near-identical colours. `samples` is [{ hex, weight }]. Returns [{ hex, weight, share, count }] biggest
 * first; `hex` is the heaviest member of each group, `share` is its part of the total weight (0..1).
 */
export function clusterColors(samples, { distance = 14 } = {}) {
  const items = samples.filter((s) => s && /^#[0-9a-f]{6}$/i.test(s.hex) && s.weight > 0).map((s) => ({ hex: s.hex.toLowerCase(), weight: s.weight }));
  const total = items.reduce((sum, s) => sum + s.weight, 0);
  const groups = [];
  for (const s of items.sort((a, b) => b.weight - a.weight)) {
    const home = groups.find((g) => colorDistance(g.hex, s.hex) <= distance);
    if (home) {
      home.weight += s.weight;
      home.count += 1;
    } else {
      groups.push({ hex: s.hex, weight: s.weight, count: 1 });
    }
  }
  return groups.sort((a, b) => b.weight - a.weight).map((g) => ({ ...g, share: total > 0 ? g.weight / total : 0 }));
}

/** [{ color, weight }] (browser colours) -> clusters, after laying each over the page colour. */
export function clusterReported(list, pageHex, opts) {
  const samples = [];
  for (const item of list ?? []) {
    const hex = flatten(item.color, pageHex);
    if (hex) samples.push({ hex, weight: item.weight });
  }
  return clusterColors(samples, opts);
}

export const saturationOf = (hex) => hexToHsl(hex).s;
export const lightnessOf = (hex) => hexToHsl(hex).l;
export { contrast, luminance, mix };

/** "Looks coloured": clearly not a grey. */
export const isColourful = (hex, min = 0.3) => {
  const { s, l } = hexToHsl(hex);
  return s >= min && l > 0.12 && l < 0.94;
};

/** Is `hex` almost the same as `other` (so it is no separate colour)? */
export const nearlySame = (hex, other, distance = 10) => colorDistance(hex, other) <= distance;
