// Turns what design-from-url measured on a page (the "PageData" from extract.mjs) into a draft token file.
// Pure: no browser, no files. The draft is only a first guess; the caller validates and repairs it, and the
// student looks at the screenshots and says what to change.
//
// STYLE, NOT BRAND: only colours, a nearest-free font, corner size and layout feel are taken. The draft's
// name and description never contain a brand, a domain or any text from the page.
import { contrast, colourName, hexToHsl, hslToHex, luminance, mix, normalizeHex } from '../color.mjs';
import { darkFromLight } from '../dark-from-light.mjs';
import { COLOR_KEYS, DEFAULT_TYPE, DEFAULT_LAYOUT, WORDS } from '../tokens.mjs';
import { clusterColors, colorDistance, flatten, fromArray, isColourful, isTransparent } from './colors.mjs';
import { mapFonts } from './font-map.mjs';
import { guessLayout } from './layout-guess.mjs';

const NEAR_BLACK = '#0b0d12';
const median = (list) => {
  const a = list.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** The colour the page really shows behind everything. */
export function pageColor(data) {
  const body = fromArray(data?.body?.bg);
  const html = fromArray(data?.htmlBg);
  if (body && !isTransparent(body, 0.5)) return flatten(body, flatten(html, '#ffffff') ?? '#ffffff');
  if (html && !isTransparent(html, 0.5)) return flatten(html, '#ffffff');
  return '#ffffff';
}

/** Near-black or white, whichever reads better on `bg`. */
function readableOn(bg, prefer) {
  if (prefer && contrast(prefer, bg) >= 4.5) return prefer;
  return contrast('#ffffff', bg) >= contrast(NEAR_BLACK, bg) ? '#ffffff' : NEAR_BLACK;
}

/**
 * Pick the colours of one theme from what a page showed.
 * -> { colors: {11 keys}, notes: [string], accentFrom }
 * `danger` / `dangerContrast` are not visible on most pages, so the caller supplies calm defaults.
 */
export function extractColors(data, { danger = '#c0362c', dangerContrast = '#ffffff' } = {}) {
  const notes = [];
  const page = pageColor(data);
  const dark = luminance(page) < 0.2;

  // main text
  let foreground = flatten(data?.body?.color, page) ?? (dark ? '#f1f2f4' : '#14161a');
  if (contrast(foreground, page) < 3) {
    foreground = dark ? '#f1f2f4' : '#14161a';
    notes.push('The text colour on the page was hard to read, so a plain readable one is used.');
  }

  // accent: the colour of the main buttons, else links, else the main text (a black-and-white site)
  let accent = null;
  let accentFrom = '';
  let accentText = null;
  const filledButtons = (data?.buttons ?? []).filter((b) => b.filled && fromArray(b.bg));
  const samples = filledButtons.map((b) => ({ hex: flatten(b.bg, page), weight: Math.max(1, b.w * b.h) * (b.inHeader ? 0.6 : 1) }));
  const groups = clusterColors(samples).filter((g) => contrast(g.hex, page) >= 1.3);
  if (groups.length > 0) {
    let pick = groups[0];
    if (!isColourful(pick.hex)) {
      const colourful = groups.find((g) => isColourful(g.hex) && g.weight >= pick.weight * 0.5);
      if (colourful) pick = colourful;
    }
    accent = pick.hex;
    accentFrom = 'the main buttons';
    const btn = filledButtons.find((b) => colorDistance(flatten(b.bg, page), pick.hex) <= 14);
    accentText = btn ? flatten(btn.color, accent) : null;
  }
  if (!accent) {
    const links = clusterColors((data?.linkColors ?? []).map((l) => ({ hex: flatten(l.color, page), weight: l.weight })))
      .filter((g) => contrast(g.hex, page) >= 3 && contrast(g.hex, foreground) >= 1.5 && isColourful(g.hex, 0.25));
    if (links.length > 0) {
      accent = links[0].hex;
      accentFrom = 'the links';
    }
  }
  if (!accent) {
    const fills = clusterColors((data?.bgColors ?? []).map((c) => ({ hex: flatten(c.color, page), weight: c.weight })))
      .filter((g) => isColourful(g.hex, 0.4) && contrast(g.hex, page) >= 1.8);
    if (fills.length > 0) {
      accent = fills[0].hex;
      accentFrom = 'the biggest coloured area';
    }
  }
  if (!accent) {
    accent = foreground;
    accentFrom = 'the text colour (the site is black and white)';
  }
  const accentContrast = readableOn(accent, accentText);

  // card colour
  let card = null;
  const cards = data?.cards ?? [];
  const filledCards = clusterColors(cards.filter((c) => c.filled).map((c) => ({ hex: flatten(c.bg, page), weight: c.w * c.h })));
  if (filledCards.length > 0) card = filledCards[0].hex;
  else if (cards.length > 0) card = page;
  else card = dark ? mix(page, '#ffffff', 0.05) : luminance(page) > 0.93 && page !== '#ffffff' ? '#ffffff' : mix(page, '#ffffff', 0.6);
  if (card === page && !dark && page !== '#ffffff' && cards.length === 0) card = '#ffffff';
  // a card the text cannot be read on (for example from a half-dark page) is replaced by one made from the page colour
  if (contrast(foreground, card) < 4.5) card = dark ? mix(page, '#ffffff', 0.05) : page === '#ffffff' ? page : mix(page, '#ffffff', 0.6);

  // grey text: a quiet colour used for small text, else a blend of text and page
  const textGroups = clusterColors((data?.textColors ?? []).map((t) => ({ hex: flatten(t.color, page), weight: t.weight })));
  const totalText = textGroups.reduce((s, g) => s + g.weight, 0) || 1;
  const quiet = textGroups.find((g) => g.weight / totalText >= 0.02
    && contrast(g.hex, foreground) >= 1.25
    && hexToHsl(g.hex).s < 0.4
    && contrast(g.hex, page) >= 3.2 && contrast(g.hex, page) <= 10);
  const muted = quiet ? quiet.hex : mix(foreground, page, 0.42);

  // lines
  const borders = clusterColors((data?.borders ?? []).map((b) => ({ hex: flatten(b.color, page), weight: b.weight })));
  // a line must stand out from the card in the right direction: lighter on dark pages, darker on light ones
  const towardText = (hex) => (dark ? luminance(hex) > luminance(card) : luminance(hex) < luminance(card));
  const faint = borders.find((g) => towardText(g.hex) && contrast(g.hex, card) >= 1.04 && contrast(g.hex, card) <= 3.5);
  const strongBorder = borders.find((g) => towardText(g.hex) && contrast(g.hex, card) >= 1.4 && g.hex !== faint?.hex);
  const line = faint ? faint.hex : mix(card, foreground, 0.1);
  const lineStrong = strongBorder ? strongBorder.hex : mix(card, foreground, 0.3);

  const colors = {
    background: page, foreground, card, muted, line, lineStrong, accent, accentContrast, focus: accent, danger, dangerContrast,
  };
  for (const k of COLOR_KEYS) colors[k] = normalizeHex(colors[k]) ?? '#808080';
  return { colors, notes, accentFrom };
}

/** A light colour set that matches a dark one (for sites that are dark only). */
export function lightFromDark(dark) {
  const accentDark = normalizeHex(dark?.accent) ?? '#2563eb';
  const hsl = hexToHsl(accentDark);
  const tint = hsl.s < 0.08 ? 0 : 0.04;
  const background = mix('#f6f7f9', accentDark, tint);
  const card = '#ffffff';
  const foreground = mix('#14161a', accentDark, tint / 2);
  const darkenUntil = (hex, backdrops, min) => {
    const ok = (c) => backdrops.every((b) => contrast(c, b) >= min);
    if (ok(hex)) return hex;
    const { h, s, l } = hexToHsl(hex);
    for (let k = 1; k <= 100; k++) {
      const cand = hslToHex({ h, s, l: Math.max(0, l - k * 0.01) });
      if (ok(cand)) return cand;
    }
    return '#000000';
  };
  const accent = darkenUntil(accentDark, [background, card], 4.5);
  const out = {
    background,
    foreground,
    card,
    muted: hslToHex({ h: hsl.h, s: tint === 0 ? 0 : 0.08, l: 0.37 }),
    line: mix(card, '#000000', 0.1),
    lineStrong: mix(card, '#000000', 0.3),
    accent,
    accentContrast: readableOn(accent, '#ffffff'),
    focus: accent,
    danger: '#c0362c',
    dangerContrast: '#ffffff',
  };
  return Object.fromEntries(COLOR_KEYS.map((k) => [k, out[k]]));
}

/** Corner size and shadow from the buttons and cards. */
export function extractShape(data) {
  const buttons = (data?.buttons ?? []).filter((b) => (b.filled || b.bordered) && !b.inHeader);
  const pool = buttons.length > 0 ? buttons : (data?.buttons ?? []).filter((b) => b.filled || b.bordered);
  const cards = data?.cards ?? [];
  const pillish = pool.length > 0 && pool.filter((b) => b.radius >= Math.min(b.h / 2 - 1, 999) && b.radius >= 14).length / pool.length >= 0.5;
  const buttonRadius = median(pool.map((b) => b.radius));
  const cardRadius = median(cards.map((c) => Math.min(c.radius, 40)));
  let base;
  let sm;
  if (cardRadius !== null) {
    base = cardRadius;
    sm = pillish || buttonRadius === null ? Math.min(base, 12) : buttonRadius;
  } else if (buttonRadius !== null) {
    sm = pillish ? 12 : buttonRadius;
    base = pillish ? 16 : Math.round(buttonRadius * 1.4);
  } else {
    base = 14;
    sm = 10;
  }
  base = clamp(Math.round(base), 0, 28);
  sm = clamp(Math.round(sm), 0, 28);
  if (sm > base) sm = base;

  let shadow = 'none';
  if (cards.length > 0) {
    const withShadow = cards.filter((c) => c.shadow);
    const soft = withShadow.filter((c) => c.shadow.blur >= 6).length;
    const crisp = withShadow.filter((c) => c.shadow.blur < 6).length;
    if (soft / cards.length >= 0.4) shadow = 'soft';
    else if (crisp / cards.length >= 0.4) shadow = 'crisp';
  }
  return { radius: { base, sm }, shadow };
}

/** A colour family name that does not call dark brown "orange" or pale peach "red". */
export function softName(hex) {
  const base = colourName(hex);
  const { l, s } = hexToHsl(hex);
  if (['near-black', 'near-white', 'grey', 'dark grey'].includes(base)) return base;
  if (l < 0.22 && s > 0.1) return `very dark ${base}`;
  if (l > 0.88 && s > 0.1) return `very pale ${base}`;
  return base;
}

const cornerWords = (base) => (base <= 6 ? 'sharp corners' : base <= 12 ? 'slightly rounded corners' : base <= 18 ? 'rounded corners' : 'very round corners');
const cornerSlug = (base) => (base <= 6 ? 'sharp' : base <= 12 ? 'soft' : base <= 18 ? 'round' : 'pill');

/** Does the page show a real, different dark mode when the browser asks for dark? */
export function hasOwnDarkMode(light, dark) {
  if (!dark) return false;
  const a = luminance(pageColor(light));
  const b = luminance(pageColor(dark));
  return Math.abs(a - b) > 0.25 && b < 0.25;
}

/**
 * buildDraft({ desktop, phone, dark }) -> { tokens, notes, reasons, fonts, accentFrom, hasOwnDark, darkOnly }
 *   desktop: PageData at 1280 wide, light scheme. phone: PageData at 390 wide. dark: PageData at 1280, dark scheme.
 */
export function buildDraft({ desktop, phone = null, dark = null }) {
  if (!desktop) throw new Error('buildDraft needs what the desktop page showed.');
  const notes = [];
  const darkOnly = luminance(pageColor(desktop)) < 0.2;
  const own = !darkOnly && hasOwnDarkMode(desktop, dark);

  const fonts = mapFonts({ body: desktop.body?.fontFamily, heading: desktop.headings?.h1?.fontFamily ?? desktop.headings?.h2?.fontFamily ?? null });
  notes.push(...fonts.notes);

  const shape = extractShape(desktop);
  let light;
  let darkColors;
  let accentFrom;
  if (darkOnly) {
    const ex = extractColors(desktop, { danger: '#ff7b72', dangerContrast: NEAR_BLACK });
    darkColors = ex.colors;
    light = lightFromDark(darkColors);
    accentFrom = ex.accentFrom;
    notes.push(...ex.notes, 'The site is dark only, so the light look is made from the dark one.');
  } else {
    const ex = extractColors(desktop);
    light = ex.colors;
    accentFrom = ex.accentFrom;
    notes.push(...ex.notes);
    if (own) {
      const gen = darkFromLight(light);
      const exDark = extractColors(dark, { danger: gen.danger, dangerContrast: gen.dangerContrast });
      darkColors = exDark.colors;
      notes.push('The site has its own dark mode, so the dark look is taken from it.');
    } else {
      darkColors = darkFromLight(light);
      notes.push('The site has no dark mode of its own, so the dark look is made from the light one.');
    }
  }

  const guessed = guessLayout({ desktop, phone }, pageColor(desktop));
  const accentHex = (darkOnly ? darkColors : light).accent;
  const colour = colourName(accentHex);
  const mood = darkOnly ? 'dark' : 'light';
  const idColour = colour.replace(/[^a-z]/g, '');
  const tokens = {
    id: `site-${idColour}-${cornerSlug(shape.radius.base)}`,
    name: `${colour[0].toUpperCase()}${colour.slice(1)} accent, ${cornerWords(shape.radius.base)}, ${mood}`,
    description: `A look drawn from the style of a website: ${cornerWords(shape.radius.base)}, ${WORDS.nav[guessed.layout.nav]}, ${fonts.font.body === 'system' ? 'the device font' : fonts.font.body} text.`,
    goodFor: 'an app that should feel like a site you liked',
    defaultTheme: darkOnly ? 'dark' : 'light',
    font: fonts.font,
    radius: shape.radius,
    shadow: shape.shadow,
    type: { ...DEFAULT_TYPE, ...guessed.type },
    layout: { ...DEFAULT_LAYOUT, ...guessed.layout },
    light,
    dark: darkColors,
  };
  return { tokens, notes, reasons: guessed.reasons, fonts, accentFrom, hasOwnDark: own, darkOnly, shape };
}

/**
 * The plain summary the student reads after a capture.
 * `result` is { tokens, ... } (after validation), `extra`: { fixed: [string], warnings: [string], hasOwnDark, darkOnly, fonts, reasons, accentFrom }.
 */
export function describeDraft(tokens, extra = {}) {
  const t = tokens;
  const lines = [];
  const dflt = t.defaultTheme === 'dark' ? t.dark : t.light;
  const nameOf = (hex) => `${softName(hex)} (${hex})`;
  lines.push(`Main colours: accent ${nameOf(dflt.accent)}${extra.accentFrom ? `, taken from ${extra.accentFrom}` : ''}; page ${nameOf(dflt.background)}; text ${nameOf(dflt.foreground)}.`);
  const f = extra.fonts;
  if (f) {
    lines.push(`Fonts: ${f.body.why}${f.heading && f.heading.font !== f.body.font ? ` Headings: ${f.heading.why}` : ''}`);
  } else {
    lines.push(`Fonts: ${t.font.body === 'system' ? 'the device font' : t.font.body}${t.font.heading === 'same' ? '' : ` with ${t.font.heading} headings`}.`);
  }
  lines.push(`Corners: ${cornerWords(t.radius.base)} (${t.radius.base}px cards, ${t.radius.sm}px buttons), shadow: ${t.shadow}.`);
  const L = t.layout;
  lines.push(`Layout (a guess): ${WORDS.nav[L.nav]}; homepage: ${WORDS.home[L.home]}; ${WORDS.cards[L.cards]} cards; ${WORDS.buttons[L.buttons]} buttons; ${WORDS.density[L.density]} spacing; ${WORDS.scale[t.type.scale]} text.`);
  lines.push(extra.darkOnly ? 'Dark mode: the site is dark only; the light look was made from it.' : extra.hasOwnDark ? 'Dark mode: the site has its own, and I used it.' : 'Dark mode: the site has none, so I made one from the light colours.');
  for (const c of extra.fixed ?? []) lines.push(`Fixed: ${c}.`);
  for (const w of extra.warnings ?? []) lines.push(`Note: ${w}`);
  return lines;
}
