// Everything design-icons needs that is not the browser: reading the app's name and colours, drawing the
// monogram icon as SVG, and the small web pages the browser turns into PNGs (app icons, share image).
// Pure functions: easy to test without a browser.
//
// Style rules: no gradients, no effects, no stock imagery. The icon is a rounded accent square with the
// first letter (or the first letters of a two-word name) in the "text on accent" colour.
import { readMarkerBlock } from '../write-files.mjs';
import { loadFontData, SERIF_STACK } from '../fonts.mjs';
import { normalizeHex } from '../color.mjs';

export const ICON_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const PLACEHOLDER = /^<[A-Z_]+>$/;

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * The letters on the icon: the first letter of the name, or the first letters of the first two words.
 * "Recipe Box" -> "RB", "Hearth" -> "H", "  ...x" -> "X". Falls back to "A".
 */
export function monogramText(name) {
  const words = String(name ?? '')
    .split(/[\s\-_/]+/)
    .map((w) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ''))[0])
    .filter(Boolean);
  const letters = words.slice(0, 2).join('');
  return letters ? letters.toLocaleUpperCase() : 'A';
}

const fontSizeFor = (text, size, maskable) => {
  const one = Array.from(text).length === 1;
  const ratio = maskable ? (one ? 0.47 : 0.34) : one ? 0.59 : 0.43;
  return Math.round(size * ratio);
};

/**
 * The icon as SVG text. `maskable` makes a full-square version (no rounded corners) with the letters kept
 * inside the middle 80% so phones can crop it to any shape.
 */
export function monogramSvg({ name, accent, accentContrast, maskable = false, size = 512 }) {
  const text = monogramText(name);
  const a = normalizeHex(accent) ?? '#2563eb';
  const c = normalizeHex(accentContrast) ?? '#ffffff';
  const fs = fontSizeFor(text, size, maskable);
  const spacing = Array.from(text).length > 1 ? ' letter-spacing="-0.02em"' : '';
  const radius = maskable ? '' : ` rx="${Math.round(size * 0.22)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(String(name ?? '').slice(0, 60))}">
<rect width="${size}" height="${size}"${radius} fill="${a}"/>
<text x="${size / 2}" y="${size / 2}" dy="0.35em" text-anchor="middle" font-family='${ICON_FONT}' font-weight="700" font-size="${fs}"${spacing} fill="${c}">${esc(text)}</text>
</svg>
`;
}

/** The page the browser turns into an icon PNG: the SVG (or the approved artwork) in a square. `inset` keeps a margin (0.18 = 18% each side). */
export function iconPage({ svg = null, imageDataUrl = null, size, background = null, inset = 0 }) {
  const inner = Math.round(size * (1 - inset * 2));
  const art = imageDataUrl ? `<img src="${esc(imageDataUrl)}" alt="">` : (svg ?? '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${background ?? 'transparent'}}
body{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.art{width:${inner}px;height:${inner}px}
.art svg,.art img{display:block;width:100%;height:100%;object-fit:contain}
</style></head><body><div class="art">${art}</div></body></html>`;
}

const ogTitleSize = (name) => {
  const n = Array.from(String(name ?? '')).length;
  return n <= 14 ? 120 : n <= 24 ? 92 : 68;
};

/** The 1200x630 share image as a web page: background colour, name in the heading weight, tagline in the muted colour, a short accent bar. */
export function ogPage({ name, tagline, background, foreground, muted, accent, weight = 700, serif = false, imageDataUrl = null }) {
  const bg = normalizeHex(background) ?? '#ffffff';
  const fg = normalizeHex(foreground) ?? '#14161a';
  const mu = normalizeHex(muted) ?? '#5b6270';
  const ac = normalizeHex(accent) ?? '#2563eb';
  const family = serif ? SERIF_STACK : ICON_FONT;
  const w = [500, 600, 700, 800].includes(Number(weight)) ? Number(weight) : 700;
  const tag = String(tagline ?? '').trim();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${bg}}
body{width:1200px;height:630px;box-sizing:border-box;padding:0 96px;display:flex;flex-direction:column;justify-content:center;font-family:${family};color:${fg};overflow:hidden}
.icon{width:104px;height:104px;margin-bottom:44px;border-radius:24px;display:block}
.bar{width:112px;height:12px;border-radius:6px;background:${ac};margin-bottom:44px}
h1{margin:0;font-size:${ogTitleSize(name)}px;line-height:1.05;font-weight:${w};letter-spacing:-0.02em;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
p{margin:28px 0 0;max-width:900px;font-size:40px;line-height:1.3;color:${mu};display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
</style></head><body>${imageDataUrl ? `<img class="icon" src="${esc(imageDataUrl)}" alt="">` : ''}<div class="bar"></div><h1>${esc(name)}</h1>${tag ? `<p>${esc(tag)}</p>` : ''}</body></html>`;
}

// ---------- reading the app ----------

function stringConst(source, name) {
  const m = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')`).exec(source ?? '');
  if (!m) return null;
  let value;
  try {
    value = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].slice(1, -1).replace(/\\'/g, "'");
  } catch {
    return null;
  }
  value = String(value).trim();
  return value === '' || PLACEHOLDER.test(value) ? null : value;
}

/** The names the app uses (src/lib/constants.ts). Placeholders that were never filled in count as missing. */
export function readBrand(constantsTs) {
  return {
    name: stringConst(constantsTs, 'SITE_NAME'),
    shortName: stringConst(constantsTs, 'SITE_SHORT_NAME'),
    tagline: stringConst(constantsTs, 'SITE_TAGLINE') ?? stringConst(constantsTs, 'SITE_DESCRIPTION'),
  };
}

const VAR_KEYS = {
  background: '--background', foreground: '--foreground', muted: '--muted', accent: '--accent', accentContrast: '--accent-contrast',
};

/**
 * The colours the app opens in, from globals.css (the shipyard colour markers) and src/lib/theme.ts.
 * -> { theme: "light"|"dark", colors: { background, foreground, muted, accent, accentContrast }, headingWeight }
 */
export function readAppLook({ globalsCss = '', themeTs = '' }) {
  const m = /DEFAULT_THEME[^=]*=\s*"(light|dark)"/.exec(themeTs);
  const theme = m ? m[1] : 'light';
  const vars = readMarkerBlock(globalsCss, theme);
  const lightVars = theme === 'light' ? vars : readMarkerBlock(globalsCss, 'light');
  const colors = {};
  for (const [key, cssVar] of Object.entries(VAR_KEYS)) {
    const v = normalizeHex(vars[cssVar]) ?? normalizeHex(lightVars[cssVar]);
    colors[key] = v;
  }
  const weight = Number.parseInt(readMarkerBlock(globalsCss, 'shape')['--heading-weight'], 10);
  return { theme, colors, headingWeight: [500, 600, 700, 800].includes(weight) ? weight : 700 };
}

/** Does the app's heading font (or body font, when there is none) have serifs? Reads src/lib/fonts.ts. */
export function headingIsSerif(fontsTs) {
  const text = String(fontsTs ?? '');
  const fn = (key) => new RegExp(`const\\s+${key}\\s*=\\s*([A-Za-z0-9_]+)\\s*\\(`).exec(text)?.[1] ?? null;
  const importName = fn('heading') ?? fn('body');
  if (!importName) return false;
  const font = Object.values(loadFontData().fonts).find((f) => f.importName === importName);
  return font?.category === 'serif';
}
