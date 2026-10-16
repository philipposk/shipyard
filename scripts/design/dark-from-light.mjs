// Make a dark colour set from a light one. Used when a screenshot or website shows only a light
// design, and by the tests. The dark look keeps the accent's hue and gets a tinted near-black page.
import { contrast, hexToHsl, hslToHex, mix, normalizeHex } from './color.mjs';
import { COLOR_KEYS } from './tokens.mjs';

const NEAR_BLACK = '#0b0d12';
const WHITE = '#ffffff';

/** Lighten `hex` (hue and saturation stay) until it reaches `min` against every backdrop. */
function lightenUntil(hex, backdrops, min) {
  const ok = (c) => backdrops.every((b) => contrast(c, b) >= min);
  if (ok(hex)) return hex;
  const { h, s, l } = hexToHsl(hex);
  for (let k = 1; k <= 100; k++) {
    const nl = Math.min(1, l + k * 0.01);
    const cand = hslToHex({ h, s, l: nl });
    if (ok(cand)) return cand;
    if (nl >= 1) break;
  }
  return WHITE;
}

/** Near-black or white, whichever reads better on `bg` (at least 4.5 to 1 is always possible). */
function readableOn(bg, prefer = NEAR_BLACK) {
  const other = prefer === NEAR_BLACK ? WHITE : NEAR_BLACK;
  if (contrast(prefer, bg) >= 4.5) return prefer;
  return contrast(other, bg) > contrast(prefer, bg) ? other : prefer;
}

/**
 * darkFromLight(light) -> dark: the same 11 colour keys for the dark look.
 * `light` is the light colour block (or a whole token file, then its `light` block is used).
 */
export function darkFromLight(lightOrTokens) {
  const light = lightOrTokens?.light ?? lightOrTokens;
  const accentLight = normalizeHex(light?.accent);
  if (!accentLight) throw new Error('darkFromLight needs a light look with a 6-digit hex accent.');
  const { s: sat } = hexToHsl(accentLight);
  const tint = sat < 0.08 ? 0 : 0.06; // grey accents give a neutral dark page, coloured ones tint it

  const background = mix('#0f1115', accentLight, tint);
  const card = mix(background, WHITE, 0.055);
  const foreground = mix('#f1f2f4', accentLight, tint / 2);
  const bgHsl = hexToHsl(background);
  const muted = hslToHex({ h: tint === 0 ? 0 : bgHsl.h, s: tint === 0 ? 0 : 0.12, l: 0.66 });
  const line = mix(card, WHITE, 0.09);
  const lineStrong = mix(card, WHITE, 0.2);

  const accent = lightenUntil(accentLight, [background, card], 4.5);
  const accentContrast = readableOn(accent);
  const lightDanger = normalizeHex(light?.danger) ?? '#c0362c';
  const danger = lightenUntil(lightDanger, [background, card], 4.5);
  const dangerContrast = readableOn(danger);

  const dark = { background, foreground, card, muted, line, lineStrong, accent, accentContrast, focus: accent, danger, dangerContrast };
  return Object.fromEntries(COLOR_KEYS.map((k) => [k, dark[k]]));
}
