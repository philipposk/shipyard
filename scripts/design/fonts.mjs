// Fonts the design tools may use, and the helpers around them.
// The list comes from fonts.json (built from Next's own font data). "system" = the phone's or
// computer's own font: nothing to download, covers every language.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let cached;
/** { generatedFrom, fonts: { "DM Sans": { importName, category, subsets, variable, weights, wght } } } */
export function loadFontData() {
  if (!cached) cached = JSON.parse(readFileSync(path.join(here, 'fonts.json'), 'utf8'));
  return cached;
}

export const SYSTEM_FONT = 'system';
export const SYSTEM_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const SERIF_STACK = 'ui-serif, Georgia, Cambria, "Times New Roman", serif';

export const googleFontNames = () => Object.keys(loadFontData().fonts);
/** Every name a token file may use for a font. */
export const allowedFontNames = () => [SYSTEM_FONT, ...googleFontNames()];
export const isAllowedFont = (name) => typeof name === 'string' && (name === SYSTEM_FONT || Object.hasOwn(loadFontData().fonts, name));
export const getFont = (name) => (name !== SYSTEM_FONT && Object.hasOwn(loadFontData().fonts, name) ? loadFontData().fonts[name] : null);

// ---- Languages -> the letter sets (Google calls them "subsets") a font must contain ----

const LATIN_EXT_LANGUAGES = new Set([
  'de', 'fr', 'es', 'it', 'pt', 'nl', 'da', 'sv', 'no', 'nb', 'nn', 'fi', 'is', 'pl', 'cs', 'sk', 'sl', 'hr', 'hu', 'ro',
  'tr', 'lt', 'lv', 'et', 'ca', 'eu', 'gl', 'ga', 'cy', 'mt', 'sq', 'af', 'id', 'ms', 'tl', 'fil', 'sw', 'az', 'bs',
]);

const SCRIPT_SUBSETS = {
  el: ['greek'],
  ru: ['cyrillic'], uk: ['cyrillic'], bg: ['cyrillic'], sr: ['cyrillic'], mk: ['cyrillic'], be: ['cyrillic'], kk: ['cyrillic'], mn: ['cyrillic'],
  vi: ['vietnamese', 'latin-ext'],
  hi: ['devanagari'], mr: ['devanagari'], ne: ['devanagari'],
  ar: ['arabic'], fa: ['arabic'], ur: ['arabic'],
  he: ['hebrew'], iw: ['hebrew'],
  th: ['thai'],
  ja: ['japanese'], ko: ['korean'], zh: ['chinese-simplified'],
  bn: ['bengali'], ta: ['tamil'], te: ['telugu'], ka: ['georgian'], hy: ['armenian'],
};

/** Letter sets needed for the owner's languages. Always includes "latin" (names, numbers, brand words). */
export function subsetsForLanguages(languages = ['en']) {
  const list = Array.isArray(languages) && languages.length > 0 ? languages : ['en'];
  const out = new Set(['latin']);
  for (const raw of list) {
    const lang = String(raw).toLowerCase().split(/[-_]/)[0];
    if (SCRIPT_SUBSETS[lang]) for (const s of SCRIPT_SUBSETS[lang]) out.add(s);
    else if (LATIN_EXT_LANGUAGES.has(lang)) out.add('latin-ext');
    else if (lang !== 'en') out.add('latin-ext'); // unknown code: accents are the likeliest need
  }
  return [...out];
}

/** Does this font have every letter set? "system" always does. */
export function fontCovers(name, subsets) {
  if (name === SYSTEM_FONT) return true;
  const font = getFont(name);
  return Boolean(font) && subsets.every((s) => font.subsets.includes(s));
}

/** Subsets of `needed` that a font does not have. */
export function missingSubsets(name, subsets) {
  if (name === SYSTEM_FONT) return [];
  const font = getFont(name);
  if (!font) return [...subsets];
  return subsets.filter((s) => !font.subsets.includes(s));
}

/** Fonts that cover the languages, nearest first (same category as `name`). Falls back to "system". */
export function suggestCoveringFonts(name, subsets, max = 3) {
  const wantCategory = getFont(name)?.category ?? 'sans';
  const covering = googleFontNames().filter((n) => fontCovers(n, subsets));
  covering.sort((a, b) => Number(getFont(b).category === wantCategory) - Number(getFont(a).category === wantCategory));
  const picks = covering.slice(0, max);
  return picks.length > 0 ? picks : [SYSTEM_FONT];
}

const LANGUAGE_WORDS = {
  greek: 'Greek letters', cyrillic: 'Cyrillic letters (Russian, Ukrainian, Bulgarian)', 'latin-ext': 'accented letters like ł, ő or ş',
  vietnamese: 'Vietnamese letters', devanagari: 'Hindi letters', arabic: 'Arabic letters', hebrew: 'Hebrew letters', thai: 'Thai letters',
  japanese: 'Japanese characters', korean: 'Korean characters', 'chinese-simplified': 'Chinese characters',
};
export const subsetWords = (s) => LANGUAGE_WORDS[s] ?? `${s} letters`;

// ---- Heading weights ----

/** The weights a heading may ask for. */
export const HEADING_WEIGHT_CHOICES = [500, 600, 700, 800];

/** Weights this font has (the device font can show any of them, bolder ones may be faked by the system). */
export function availableWeights(name) {
  if (name === SYSTEM_FONT) return [...HEADING_WEIGHT_CHOICES];
  return [...(getFont(name)?.weights ?? [])];
}

/**
 * The heading weight to use: `wanted` if the font has it, else the nearest one it has (ties go lighter).
 * -> { weight, requested, adjusted }
 */
export function nearestHeadingWeight(name, wanted = 700) {
  const have = availableWeights(name);
  const choices = HEADING_WEIGHT_CHOICES.filter((w) => have.includes(w));
  if (choices.length === 0 || choices.includes(wanted)) return { weight: wanted, requested: wanted, adjusted: false };
  const weight = choices.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), choices[0]);
  return { weight, requested: wanted, adjusted: true };
}

/** Fixed-weight fonts load the weights the app uses (400 to 700) plus the heading weight. */
export function staticWeights(font, extra = []) {
  const wanted = new Set([400, 500, 600, 700, ...extra]);
  return font.weights.filter((w) => wanted.has(w));
}

// ---- What the app's src/lib/fonts.ts contains ----

export const GENERATED_HEADER = '// Generated by Shipyard design. Edit with /shipyard:design, not by hand.';

/** The letter sets to load: what the languages need, limited to what the font has (latin as the floor). */
export function loadableSubsets(name, wanted) {
  const font = getFont(name);
  if (!font) return [];
  const have = wanted.filter((s) => font.subsets.includes(s));
  return have.length > 0 ? have : ['latin'];
}

/** Text of src/lib/fonts.ts for the chosen fonts. */
export function renderFontsTs({ body = SYSTEM_FONT, heading = 'same', languages = ['en'], headingWeight = null } = {}) {
  const headingName = heading === 'same' || heading === body ? null : heading;
  const wanted = subsetsForLanguages(languages);
  const parts = [];
  const imports = [];
  const vars = [];
  const add = (key, name, cssVar, extraWeights = []) => {
    const font = getFont(name);
    if (!font) return;
    imports.push(font.importName);
    const subs = loadableSubsets(name, wanted).map((s) => `"${s}"`).join(', ');
    // Variable fonts need no weight list. Fixed-weight fonts load the weights the app uses.
    const weights = font.variable
      ? ''
      : `, weight: [${staticWeights(font, extraWeights).map((w) => `"${w}"`).join(', ')}]`;
    parts.push(`const ${key} = ${font.importName}({ subsets: [${subs}]${weights}, variable: "${cssVar}", display: "swap" });`);
    vars.push(key);
  };
  const headingExtra = headingWeight ? [nearestHeadingWeight(headingName ?? body, headingWeight).weight] : [];
  add('body', body, '--font-body', headingName ? [] : headingExtra);
  if (headingName) add('heading', headingName, '--font-heading', headingExtra);

  if (parts.length === 0) return `${GENERATED_HEADER}\nexport const fontClassName = "";\n`;
  const importLine = `import { ${[...new Set(imports)].sort().join(', ')} } from "next/font/google";`;
  const joined = vars.map((v) => `${v}.variable`).join(', ');
  return `${GENERATED_HEADER}\n${importLine}\n\n${parts.join('\n')}\n\nexport const fontClassName = [${joined}].filter(Boolean).join(" ");\n`;
}

/** CSS family stack for previews (gallery): the real name first, then a sensible fallback. */
export function cssFamily(name) {
  if (name === SYSTEM_FONT || !getFont(name)) return SYSTEM_STACK;
  const f = getFont(name);
  return `"${name}", ${f.category === 'serif' ? SERIF_STACK : SYSTEM_STACK}`;
}

/** The weight list text for one family in a Google Fonts css2 address. */
function weightSpec(font, maxWeight, extra = []) {
  if (font.variable) {
    const lo = Math.max(font.wght?.[0] ?? 400, 400);
    const hi = Math.min(font.wght?.[1] ?? 700, Math.max(700, maxWeight, ...extra));
    return `${Math.min(lo, hi)}..${hi}`;
  }
  return staticWeights(font, extra).join(';');
}

/**
 * One fonts.googleapis.com address that loads several fonts (used by the look gallery).
 * `maxWeight` raises the top of the weight range for variable fonts (headings may be 800).
 */
export function googleFontsCssUrl(names, { maxWeight = 700 } = {}) {
  const families = [...new Set(names)].filter((n) => getFont(n)).sort().map((n) => {
    return `family=${encodeURIComponent(n).replace(/%20/g, '+')}:wght@${weightSpec(getFont(n), maxWeight)}`;
  });
  return families.length === 0 ? null : `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}

/** The address for one font with the weights a role needs (null for the device font). */
export function googleFontCssUrl(name, { headingWeight = null } = {}) {
  const font = getFont(name);
  if (!font) return null;
  const extra = headingWeight ? [nearestHeadingWeight(name, headingWeight).weight] : [];
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:wght@${weightSpec(font, 700, extra)}&display=swap`;
}
