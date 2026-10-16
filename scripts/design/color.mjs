// Colour maths for the design tools: hex <-> rgb <-> hsl, WCAG contrast, mixing.
// Only 6-digit hex colours are used anywhere in Shipyard design files.

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const isHex = (value) => typeof value === 'string' && HEX_RE.test(value);

/** "#ABCDEF" -> "#abcdef". Accepts 3-digit hex too. Returns null for anything else. */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return HEX_RE.test(v) ? v.toLowerCase() : null;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** "#336699" -> [51, 102, 153] */
export function hexToRgb(hex) {
  const h = normalizeHex(hex);
  if (!h) throw new Error(`"${hex}" is not a 6-digit hex colour like #336699.`);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** [51, 102, 153] -> "#336699" (values are rounded and clamped to 0..255) */
export function rgbToHex([r, g, b]) {
  const part = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** rgb 0..255 -> { h: 0..360, s: 0..1, l: 0..1 } */
export function rgbToHsl([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: clamp(s, 0, 1), l };
}

/** { h, s, l } -> [r, g, b] (0..255, not rounded) */
export function hslToRgb({ h, s, l }) {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export const hexToHsl = (hex) => rgbToHsl(hexToRgb(hex));
export const hslToHex = (hsl) => rgbToHex(hslToRgb(hsl));

/** Same colour with a different lightness (0..1). Hue and saturation stay. */
export function withLightness(hex, l) {
  const { h, s } = hexToHsl(hex);
  return hslToHex({ h, s, l: clamp(l, 0, 1) });
}

/** WCAG 2.x relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex) {
  const lin = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two colours, 1 .. 21. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mix two colours. amount 0 = all `a`, 1 = all `b` (straight sRGB mix, like CSS color-mix). */
export function mix(a, b, amount) {
  const t = clamp(amount, 0, 1);
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex(ra.map((v, i) => v + (rb[i] - v) * t));
}

/** Hue in degrees, saturation 0..100 and lightness 0..100 (whole numbers) for plain-language reports. */
export function describeHsl(hex) {
  const { h, s, l } = hexToHsl(hex);
  return { hue: Math.round(h), saturation: Math.round(s * 100), lightness: Math.round(l * 100) };
}

/** Rough colour family name for a hex, used in plain-English summaries ("a blue accent"). */
export function colourName(hex) {
  const { h, s, l } = hexToHsl(hex);
  if (l < 0.1) return 'near-black';
  if (l > 0.95) return 'near-white';
  if (s < 0.1) return l < 0.45 ? 'dark grey' : 'grey';
  const names = [
    [15, 'red'], [40, 'orange'], [65, 'yellow'], [90, 'lime'], [165, 'green'], [195, 'teal'],
    [255, 'blue'], [290, 'purple'], [335, 'pink'], [361, 'red'],
  ];
  return names.find(([max]) => h < max)[1];
}
