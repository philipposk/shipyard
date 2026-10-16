// The token file format and everything that turns tokens into app files:
// CSS lines for globals.css, src/lib/theme.ts, manifest colours, short summaries.
import { normalizeHex } from './color.mjs';
import { GENERATED_HEADER, nearestHeadingWeight } from './fonts.mjs';

export const COLOR_KEYS = [
  'background', 'foreground', 'card', 'muted', 'line', 'lineStrong',
  'accent', 'accentContrast', 'focus', 'danger', 'dangerContrast',
];
export const THEMES = ['light', 'dark'];
export const SHADOWS = ['none', 'soft', 'crisp'];
export const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
export const RADIUS_MAX = 28;

// ---- v0.3: type and layout (all optional in a token file; the defaults are the template's own look) ----
export const TYPE_SCALES = ['compact', 'comfortable', 'large'];
export const HEADING_WEIGHTS = [500, 600, 700, 800];
export const TRACKINGS = ['tight', 'normal', 'wide'];
export const NAVS = ['bottom-nav', 'sidebar', 'top-nav'];
export const DENSITIES = ['compact', 'regular', 'airy'];
export const MAX_WIDTHS = ['narrow', 'medium', 'wide'];
export const HOMES = ['focus', 'split', 'editorial', 'cards', 'list'];
export const CARD_STYLES = ['flat', 'bordered', 'elevated', 'tinted'];
export const BUTTON_STYLES = ['solid', 'pill', 'outline', 'sharp'];
export const HEADERS = ['plain', 'bar', 'centered'];

export const DEFAULT_TYPE = Object.freeze({ scale: 'comfortable', headingWeight: 700, headingTracking: 'normal' });
export const DEFAULT_LAYOUT = Object.freeze({
  nav: 'bottom-nav', density: 'regular', maxWidth: 'medium', home: 'focus', cards: 'bordered', buttons: 'solid', header: 'bar',
});

/** Allowed values for every type/layout field (used by validate and the docs). */
export const ENUMS = {
  'type.scale': TYPE_SCALES,
  'type.headingWeight': HEADING_WEIGHTS,
  'type.headingTracking': TRACKINGS,
  'layout.nav': NAVS,
  'layout.density': DENSITIES,
  'layout.maxWidth': MAX_WIDTHS,
  'layout.home': HOMES,
  'layout.cards': CARD_STYLES,
  'layout.buttons': BUTTON_STYLES,
  'layout.header': HEADERS,
};

/** One sentence per choice, for DESIGN.md and the gallery. */
export const DETAILS = {
  cards: { flat: 'no outline and no shadow; cards are separated by space', bordered: 'a thin outline', elevated: 'a soft shadow and no outline, so they float', tinted: 'filled with a pale tint of the accent colour' },
  buttons: { solid: 'filled, with the button corner size', pill: 'filled, fully rounded ends', outline: 'transparent with an accent outline for the main button', sharp: 'square corners and small capital letters' },
  header: { plain: 'no bar behind it', bar: 'on a card-coloured bar with a line underneath', centered: 'the app name in the middle, actions on the right' },
};

/** Plain words for the layout choices (DESIGN.md, summaries, the gallery). */
export const WORDS = {
  nav: { 'bottom-nav': 'tabs at the bottom', sidebar: 'a menu on the left', 'top-nav': 'links in the top bar' },
  home: { focus: 'one centred message', split: 'text beside a preview', editorial: 'a big headline and a list of entries', cards: 'a grid of cards', list: 'a title, two buttons and a list' },
  cards: { flat: 'flat', bordered: 'outlined', elevated: 'floating', tinted: 'tinted' },
  buttons: { solid: 'solid', pill: 'pill-shaped', outline: 'outlined', sharp: 'sharp capital-letter' },
  density: { compact: 'compact', regular: 'regular', airy: 'airy' },
  scale: { compact: 'compact', comfortable: 'comfortable', large: 'large' },
  header: { plain: 'plain', bar: 'a bar', centered: 'centred name' },
  maxWidth: { narrow: 'narrow', medium: 'medium', wide: 'wide' },
  tracking: { tight: 'tight', normal: 'normal', wide: 'slightly open' },
};

/** token key -> CSS variable (the 11 colours) */
export const CSS_VARS = {
  background: '--background',
  foreground: '--foreground',
  card: '--card',
  muted: '--muted',
  line: '--line',
  lineStrong: '--line-strong',
  accent: '--accent',
  accentContrast: '--accent-contrast',
  focus: '--focus',
  danger: '--danger',
  dangerContrast: '--danger-contrast',
};

/** Plain names for messages a student reads. */
export const COLOR_WORDS = {
  background: 'page background',
  foreground: 'main text',
  card: 'card background',
  muted: 'grey text',
  line: 'thin lines',
  lineStrong: 'input borders',
  accent: 'accent colour',
  accentContrast: 'text on accent buttons',
  focus: 'keyboard focus outline',
  danger: 'error colour',
  dangerContrast: 'text on error buttons',
};

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const SHADOW_CSS = {
  light: {
    none: 'none',
    soft: '0 6px 24px rgba(0, 0, 0, 0.07)',
    crisp: '0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--line)',
  },
  dark: {
    none: 'none',
    soft: '0 6px 24px rgba(0, 0, 0, 0.35)',
    crisp: '0 1px 2px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--line)',
  },
};

export const shadowCss = (shadow, theme) => SHADOW_CSS[theme]?.[shadow] ?? SHADOW_CSS.light.soft;

/** The font name used for headings ("same" resolves to the body font). */
export const headingFont = (t) => (t.font?.heading === 'same' || !t.font?.heading ? t.font?.body : t.font.heading);

/**
 * Tidy up a token file without judging it: lower-case hex, expand #abc, trim strings.
 * Returns a new object. Unknown keys are dropped so they can never reach a generated file.
 */
export function normalizeTokens(t) {
  if (!isObject(t)) return t;
  const str = (v) => (typeof v === 'string' ? v.trim() : v);
  const colors = (block) => {
    if (!isObject(block)) return block;
    const out = {};
    for (const k of COLOR_KEYS) if (k in block) out[k] = normalizeHex(block[k]) ?? block[k];
    return out;
  };
  // type / layout: keep only known keys, fill the ones that are missing with the template defaults.
  // A value that is the wrong kind of thing is kept as it is so validateTokens can say so.
  const fill = (block, defaults) => {
    if (block === undefined || block === null) return { ...defaults };
    if (!isObject(block)) return block;
    const o = {};
    for (const k of Object.keys(defaults)) o[k] = typeof block[k] === 'string' ? block[k].trim() : (block[k] ?? defaults[k]);
    return o;
  };
  const out = {
    id: str(t.id),
    name: str(t.name),
    description: str(t.description),
    goodFor: str(t.goodFor),
    defaultTheme: t.defaultTheme,
    font: isObject(t.font) ? { body: str(t.font.body), heading: str(t.font.heading ?? 'same') } : t.font,
    radius: isObject(t.radius) ? { base: t.radius.base, sm: t.radius.sm } : t.radius,
    shadow: t.shadow,
    type: fill(t.type, DEFAULT_TYPE),
    layout: fill(t.layout, DEFAULT_LAYOUT),
    light: colors(t.light),
    dark: colors(t.dark),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** CSS lines (two-space indent) that go between the shipyard:tokens markers. */
export function tokenLines(t, theme) {
  const block = t[theme];
  const lines = COLOR_KEYS.map((k) => `  ${CSS_VARS[k]}: ${block[k]};`);
  if (theme === 'light') {
    lines.push(`  --radius: ${t.radius.base}px;`);
    lines.push(`  --radius-sm: ${t.radius.sm}px;`);
  }
  lines.push(`  --shadow: ${shadowCss(t.shadow, theme)};`);
  return lines;
}

/**
 * The token file with type and layout filled in (missing or unknown values become the template defaults).
 * Pure and forgiving: validateTokens is the place that complains.
 */
export function withDefaults(t) {
  const pick = (block, defaults, allowed) => {
    const out = {};
    for (const k of Object.keys(defaults)) {
      const v = isObject(block) ? block[k] : undefined;
      out[k] = allowed[k].includes(v) ? v : defaults[k];
    }
    return out;
  };
  return {
    ...t,
    type: pick(t?.type, DEFAULT_TYPE, { scale: TYPE_SCALES, headingWeight: HEADING_WEIGHTS, headingTracking: TRACKINGS }),
    layout: pick(t?.layout, DEFAULT_LAYOUT, {
      nav: NAVS, density: DENSITIES, maxWidth: MAX_WIDTHS, home: HOMES, cards: CARD_STYLES, buttons: BUTTON_STYLES, header: HEADERS,
    }),
  };
}

/** The heading weight that will really be used: the requested one, or the nearest the heading font has. */
export function resolveHeadingWeight(t) {
  const d = withDefaults(t);
  return nearestHeadingWeight(headingFont(d), d.type.headingWeight);
}

// ---- derived shape values (type scale, spacing, widths) ----
const SCALES = { compact: { base: 15, ratio: 1.2 }, comfortable: { base: 16, ratio: 1.25 }, large: { base: 17, ratio: 1.333 } };
const SPACING = { compact: { space: 4, pad: 12, gap: 8 }, regular: { space: 6, pad: 16, gap: 12 }, airy: { space: 8, pad: 24, gap: 20 } };
const CONTENT_MAX = { narrow: 640, medium: 960, wide: 1200 };
const TRACKING = { tight: '-0.02em', normal: '0em', wide: '0.01em' };
const half = (n) => Math.round(n * 2) / 2;
const px = (n) => `${n}px`;

/** Type sizes in pixels for a scale: { base, h1, h2, h3 } (rounded to half pixels). */
export function typeSizes(scale) {
  const { base, ratio } = SCALES[scale] ?? SCALES.comfortable;
  return { base, h1: half(base * ratio ** 3), h2: half(base * ratio ** 2), h3: half(base * ratio) };
}

/** Phones are narrow, so the first heading never grows past 6% of the screen width (390px phone: 23.4px, but never below h2). */
export const phoneH1 = (sizes, phoneWidth = 390) => Math.min(sizes.h1, Math.max(sizes.h2, half((phoneWidth * 6) / 100)));

/**
 * deriveShape(tokens) -> { "--font-size-base": "16px", ... } in the order written between the shape markers.
 * Heading weight is the one the heading font really has.
 */
export function deriveShape(input) {
  const t = withDefaults(input);
  const sizes = typeSizes(t.type.scale);
  const sp = SPACING[t.layout.density];
  return {
    '--font-size-base': px(sizes.base),
    '--h1-size': `clamp(${px(sizes.h2)}, 6vw, ${px(sizes.h1)})`,
    '--h2-size': px(sizes.h2),
    '--h3-size': px(sizes.h3),
    '--heading-weight': String(resolveHeadingWeight(t).weight),
    '--heading-tracking': TRACKING[t.type.headingTracking],
    '--space': px(sp.space),
    '--pad-card': px(sp.pad),
    '--gap': px(sp.gap),
    '--content-max': px(CONTENT_MAX[t.layout.maxWidth]),
  };
}

/** The shape values as plain numbers (pixels, except weight and tracking in em), for previews that scale them. */
export function shapeNumbers(input) {
  const t = withDefaults(input);
  const sizes = typeSizes(t.type.scale);
  const sp = SPACING[t.layout.density];
  return {
    base: sizes.base, h1: sizes.h1, h2: sizes.h2, h3: sizes.h3, h1Phone: phoneH1(sizes),
    weight: resolveHeadingWeight(t).weight,
    tracking: Number.parseFloat(TRACKING[t.type.headingTracking]),
    space: sp.space, pad: sp.pad, gap: sp.gap, max: CONTENT_MAX[t.layout.maxWidth],
  };
}

/** CSS lines (two-space indent) that go between the shipyard:tokens:shape markers. */
export const shapeLines = (t) => Object.entries(deriveShape(t)).map(([name, value]) => `  ${name}: ${value};`);

/** Text of src/lib/theme.ts */
export function renderThemeTs(input) {
  const t = withDefaults(input);
  const { density, cards, buttons, header } = t.layout;
  return `${GENERATED_HEADER}
export const DEFAULT_THEME: "light" | "dark" = "${t.defaultTheme === 'dark' ? 'dark' : 'light'}";
export const THEME_COLORS = { light: "${t.light.background}", dark: "${t.dark.background}" } as const;
export const LOOK = { density: "${density}", cards: "${cards}", buttons: "${buttons}", header: "${header}" } as const;
export const HOME_STYLE: "focus" | "split" | "editorial" | "cards" | "list" = "${t.layout.home}";
`;
}

/**
 * The seven things that make two looks feel different (besides colour): menu, homepage, cards,
 * buttons, spacing, type size and font. Used to check that ready-made looks and the 3 directions
 * really differ.
 */
export function lookDims(input) {
  const t = withDefaults(input);
  return {
    nav: t.layout.nav,
    home: t.layout.home,
    cards: t.layout.cards,
    buttons: t.layout.buttons,
    density: t.layout.density,
    scale: t.type.scale,
    font: `${t.font?.body}/${headingFont(t)}`,
  };
}

// Homepages that draw no card, so a different card style cannot be seen on them.
const HOMES_WITHOUT_CARDS = new Set(['editorial']);

/**
 * Names of the dimensions two looks share, e.g. ["nav", "density"]. A difference nobody can see does not count:
 * when either look has a homepage without cards, "cards" counts as shared.
 */
export function sharedDims(a, b) {
  const x = lookDims(a);
  const y = lookDims(b);
  const cardsHidden = HOMES_WITHOUT_CARDS.has(x.home) || HOMES_WITHOUT_CARDS.has(y.home);
  return Object.keys(x).filter((k) => x[k] === y[k] || (k === 'cards' && cardsHidden));
}

/** The colour the browser bar and install splash should use: the default theme's page background. */
export const manifestColor = (t) => (t.defaultTheme === 'dark' ? t.dark.background : t.light.background);

/** One-line plain-English summary of a token file. */
export function summarize(input) {
  const t = withDefaults(input);
  const corners = t.radius.base <= 6 ? 'sharp corners' : t.radius.base <= 12 ? 'slightly rounded corners' : t.radius.base <= 18 ? 'rounded corners' : 'very round corners';
  const fonts = t.font.body === 'system' ? 'the device font' : t.font.body;
  const head = headingFont(t);
  const headWords = head === t.font.body ? '' : ` with ${head === 'system' ? 'the device font' : head} headings`;
  const L = t.layout;
  const layout = `${WORDS.nav[L.nav]}, ${WORDS.home[L.home]} on the homepage, ${WORDS.cards[L.cards]} cards, ${WORDS.buttons[L.buttons]} buttons, ${WORDS.density[L.density]} spacing, ${WORDS.scale[t.type.scale]} text`;
  return `${t.name}: ${t.defaultTheme} by default, accent ${t[t.defaultTheme === 'dark' ? 'dark' : 'light'].accent}, ${fonts}${headWords}, ${corners}; ${layout}.`;
}
