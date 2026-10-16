// Maps a website's font stack to the nearest font Shipyard can use (the allowed list in fonts.json,
// or "system" for the device font). We copy the FEEL of a font (round, sharp, bookish), never the font
// files themselves: the site's fonts are not downloaded or saved.
//
// Order of the match: 1. an exact name we allow, 2. a known font and its look (table below),
// 3. the stack's generic family (serif / monospace / sans-serif), 4. a clean neutral.
import { SYSTEM_FONT, allowedFontNames } from '../fonts.mjs';

/** The looks we tell the student about. */
export const FONT_KINDS = {
  geometric: 'a round, geometric sans-serif',
  grotesk: 'a neutral grotesque sans-serif',
  humanist: 'a friendly humanist sans-serif',
  rounded: 'a soft, rounded sans-serif',
  serif: 'a classic serif',
  'display-serif': 'a high-contrast display serif',
  mono: 'a monospace (code) font',
  system: 'the device font',
};

// kind -> the allowed font that feels closest
const KIND_TO_FONT = {
  geometric: 'DM Sans',
  grotesk: 'Inter',
  humanist: 'Source Sans 3',
  rounded: 'Nunito',
  serif: 'Source Serif 4',
  'display-serif': 'Fraunces',
  mono: SYSTEM_FONT,
  system: SYSTEM_FONT,
};

// Specific fonts: lower-case name -> [kind, allowed font to use]. Where the kind default is not the best
// match the font is named explicitly (for example Manrope for a modern geometric face).
const ENTRIES = [
  // geometric sans
  ['poppins', 'geometric'], ['montserrat', 'geometric'], ['futura', 'geometric'], ['futura pt', 'geometric'], ['avenir', 'geometric'],
  ['avenir next', 'geometric'], ['century gothic', 'geometric'], ['gotham', 'geometric'], ['gotham rounded', 'rounded'], ['proxima nova', 'humanist'],
  ['raleway', 'geometric'], ['lexend', 'geometric'], ['urbanist', 'geometric'], ['figtree', 'geometric'], ['red hat display', 'geometric'],
  ['red hat text', 'geometric'], ['circular', 'geometric'], ['circular std', 'geometric'], ['circularstd', 'geometric'], ['gt walsheim', 'geometric'],
  ['product sans', 'geometric'], ['google sans', 'geometric'], ['albert sans', 'geometric'], ['jost', 'geometric'], ['kumbh sans', 'geometric'],
  ['outfit', 'geometric', 'Manrope'], ['sora', 'geometric', 'Manrope'], ['plus jakarta sans', 'geometric', 'Manrope'], ['onest', 'geometric', 'Manrope'],
  ['be vietnam pro', 'geometric', 'Manrope'], ['general sans', 'geometric', 'Manrope'], ['satoshi', 'geometric', 'Manrope'], ['cabinet grotesk', 'geometric', 'Manrope'],
  ['mulish', 'humanist', 'Nunito'], ['quicksand', 'rounded'], ['varela round', 'rounded'], ['comfortaa', 'rounded'], ['baloo', 'rounded'],
  // grotesque / neutral sans
  ['helvetica', 'grotesk'], ['helvetica neue', 'grotesk'], ['arial', 'grotesk'], ['arimo', 'grotesk'], ['roboto', 'grotesk'], ['akzidenz grotesk', 'grotesk'],
  ['neue haas grotesk', 'grotesk'], ['neue haas grotesk display', 'grotesk'], ['aktiv grotesk', 'grotesk'], ['suisse', 'grotesk'], ['suisse intl', 'grotesk'],
  ['univers', 'grotesk'], ['geist', 'grotesk'], ['archivo', 'grotesk'], ['hanken grotesk', 'grotesk'], ['instrument sans', 'grotesk'], ['public sans', 'grotesk'],
  ['barlow', 'grotesk'], ['rubik', 'grotesk'], ['karla', 'grotesk'], ['dm mono', 'mono'], ['sf pro', 'system'], ['sf pro text', 'system'], ['sf pro display', 'system'],
  ['graphik', 'grotesk'], ['gt america', 'grotesk'], ['untitled sans', 'grotesk'], ['basier circle', 'geometric'], ['telegraf', 'grotesk'],
  ['space grotesk', 'grotesk', 'Space Grotesk'], ['bricolage grotesque', 'grotesk', 'Space Grotesk'], ['syne', 'grotesk', 'Space Grotesk'], ['unbounded', 'grotesk', 'Space Grotesk'],
  ['familjen grotesk', 'grotesk', 'Space Grotesk'], ['schibsted grotesk', 'grotesk', 'Space Grotesk'], ['darker grotesque', 'grotesk', 'Space Grotesk'],
  // humanist sans
  ['open sans', 'humanist'], ['lato', 'humanist'], ['fira sans', 'humanist'], ['ubuntu', 'humanist'], ['cabin', 'humanist'], ['calibri', 'humanist'],
  ['carlito', 'humanist'], ['trebuchet ms', 'humanist'], ['verdana', 'humanist'], ['tahoma', 'humanist'], ['pt sans', 'humanist'], ['frutiger', 'humanist'],
  ['myriad pro', 'humanist'], ['myriad', 'humanist'], ['gill sans', 'humanist'], ['optima', 'humanist'], ['hind', 'humanist'], ['oxygen', 'humanist'],
  ['cantarell', 'humanist'], ['droid sans', 'humanist'], ['segoe ui', 'system'], ['segoe ui variable', 'system'], ['sf ui', 'system'], ['tisa sans', 'humanist'],
  ['nunito sans', 'humanist', 'Nunito'], ['asap', 'humanist'], ['catamaran', 'humanist'], ['overpass', 'humanist'], ['pt sans caption', 'humanist'],
  // serif
  ['georgia', 'serif'], ['times new roman', 'serif'], ['times', 'serif'], ['liberation serif', 'serif'], ['merriweather', 'serif'], ['garamond', 'serif'],
  ['eb garamond', 'serif'], ['cormorant', 'display-serif'], ['cormorant garamond', 'display-serif'], ['baskerville', 'serif'], ['libre baskerville', 'serif'],
  ['charter', 'serif'], ['bitstream charter', 'serif'], ['tiempos', 'serif'], ['tiempos text', 'serif'], ['tiempos headline', 'display-serif'], ['gt sectra', 'display-serif'],
  ['pt serif', 'serif'], ['crimson text', 'serif'], ['crimson pro', 'serif'], ['noto serif', 'serif'], ['libre caslon text', 'serif'], ['caslon', 'serif'],
  ['palatino', 'serif'], ['palatino linotype', 'serif'], ['book antiqua', 'serif'], ['iowan old style', 'serif'], ['cambria', 'serif'], ['spectral', 'serif'],
  ['newsreader', 'serif'], ['literata', 'serif'], ['vollkorn', 'serif'], ['domine', 'serif'], ['bitter', 'serif'], ['roboto serif', 'serif'], ['source serif pro', 'serif'],
  ['playfair display', 'display-serif'], ['dm serif display', 'display-serif'], ['dm serif text', 'serif'], ['abril fatface', 'display-serif'], ['bodoni moda', 'display-serif'],
  ['didot', 'display-serif'], ['bodoni 72', 'display-serif'], ['gambetta', 'display-serif'], ['young serif', 'display-serif'], ['instrument serif', 'display-serif'],
  ['canela', 'display-serif'], ['recoleta', 'display-serif'], ['gt super', 'display-serif'], ['ogg', 'display-serif'],
  // mono
  ['courier', 'mono'], ['courier new', 'mono'], ['menlo', 'mono'], ['monaco', 'mono'], ['consolas', 'mono'], ['jetbrains mono', 'mono'], ['fira code', 'mono'],
  ['fira mono', 'mono'], ['sf mono', 'mono'], ['sfmono-regular', 'mono'], ['ibm plex mono', 'mono'], ['roboto mono', 'mono'], ['source code pro', 'mono'],
  ['space mono', 'mono'], ['liberation mono', 'mono'], ['dejavu sans mono', 'mono'], ['geist mono', 'mono'], ['commit mono', 'mono'], ['berkeley mono', 'mono'], ['ubuntu mono', 'mono'],
];

const TABLE = new Map(ENTRIES.map(([name, kind, font]) => [name, { kind, font: font ?? KIND_TO_FONT[kind] }]));

// Generic keywords and the device fonts they stand for
const GENERIC = new Map([
  ['system-ui', 'system'], ['-apple-system', 'system'], ['blinkmacsystemfont', 'system'], ['ui-sans-serif', 'system'], ['sans-serif', 'system'],
  ['ui-serif', 'serif'], ['serif', 'serif'], ['ui-monospace', 'mono'], ['monospace', 'mono'], ['ui-rounded', 'rounded'],
  ['cursive', 'system'], ['fantasy', 'system'], ['emoji', null], ['math', null], ['fangsong', null], ['inherit', null], ['initial', null], ['unset', null],
]);

// Words that tell us a custom or unknown font's feel
const HINTS = [
  [/\bmono(space)?\b|\bcode\b|\bconsolas\b|\bcourier\b/, 'mono'],
  [/serif/, null], // handled below ("sans serif" must not count)
  [/grotesk|grotesque|neue|haas|swiss/, 'grotesk'],
  [/rounded|round\b/, 'rounded'],
  [/geometric|gothic|futura|avenir/, 'geometric'],
  [/humanist/, 'humanist'],
  [/garamond|baskerville|didot|bodoni|caslon|times|georgia|roman|antiqua|slab/, 'serif'],
];

/** "Inter Variable", "Inter var", "inter-variable" -> "inter" */
const clean = (name) => name.toLowerCase().replace(/\s+/g, ' ').replace(/[-_ ](variable|var|vf|text|display|pro|std)(\s|$)/g, '$2').replace(/\s*variable$/, '').trim();

// Font names come from other people's websites: only plain names are ever repeated in a message.
const SAFE_NAME = /^[A-Za-z0-9 ._-]{1,40}$/;
const shown = (name) => (SAFE_NAME.test(name) ? name : 'that font');
const siteFontOf = (name) => (SAFE_NAME.test(name) ? name : 'an unknown font');

/** Split a CSS font-family value into plain names ("Inter", "system-ui", ...). */
export function parseFontStack(stack) {
  const names = [];
  let cur = '';
  let quote = null;
  for (const ch of String(stack ?? '').slice(0, 200)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      names.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  names.push(cur);
  return names.map((n) => n.trim()).filter(Boolean).slice(0, 12);
}

function exactAllowed(name) {
  const lower = name.toLowerCase();
  const key = clean(name);
  for (const allowed of allowedFontNames()) {
    if (allowed === SYSTEM_FONT) continue;
    const a = allowed.toLowerCase();
    if (lower === a || key === a || key === clean(a)) return allowed;
  }
  // older and renamed names
  const renamed = { 'source sans pro': 'Source Sans 3', 'source sans': 'Source Sans 3', 'source serif': 'Source Serif 4', 'inter tight': 'Inter', 'ibm plex': 'IBM Plex Sans', 'noto sans display': 'Noto Sans' };
  return renamed[key] ?? null;
}

/**
 * mapFontStack("'Poppins', Helvetica, sans-serif") ->
 *   { font: "DM Sans", match: "similar", kind: "geometric", siteFont: "Poppins", why: "..." }
 * match: "exact" (we have that font), "similar" (a known font, nearest feel), "generic" (only the generic
 * family told us), "guess" (unknown font, neutral pick), "device" (the site uses the device font).
 */
export function mapFontStack(stack) {
  const names = parseFontStack(stack);
  let generic = null;
  let firstNamed = null;
  for (const raw of names) {
    const key = clean(raw);
    if (GENERIC.has(key) || GENERIC.has(raw.toLowerCase())) {
      const g = GENERIC.get(key) ?? GENERIC.get(raw.toLowerCase());
      if (g && !generic) generic = g;
      continue;
    }
    if (!firstNamed) firstNamed = raw;
    const exact = exactAllowed(raw);
    if (exact) return { font: exact, match: 'exact', kind: null, siteFont: siteFontOf(raw), why: `${shown(raw)} is available, so it is used as it is.` };
    const known = TABLE.get(key) ?? TABLE.get(raw.toLowerCase());
    if (known) {
      if (known.kind === 'system') return { font: SYSTEM_FONT, match: 'device', kind: 'system', siteFont: siteFontOf(raw), why: `${shown(raw)} is a device font, so the device font is used.` };
      return { font: known.font, match: 'similar', kind: known.kind, siteFont: siteFontOf(raw), why: `${shown(raw)} looks like ${FONT_KINDS[known.kind]}; ${known.font === SYSTEM_FONT ? 'the device font' : known.font} is the nearest free font.` };
    }
  }
  // names we do not know: judge by the words in them, then by the generic family
  if (firstNamed) {
    const lower = firstNamed.toLowerCase();
    for (const [re, kind] of HINTS) {
      if (!re.test(lower)) continue;
      const k = kind ?? (/sans/.test(lower) ? 'grotesk' : 'serif');
      return { font: KIND_TO_FONT[k], match: 'guess', kind: k, siteFont: siteFontOf(firstNamed), why: `I do not know ${shown(firstNamed)}, but its name suggests ${FONT_KINDS[k]}; ${KIND_TO_FONT[k] === SYSTEM_FONT ? 'the device font' : KIND_TO_FONT[k]} is the nearest free font.` };
    }
    if (generic === 'serif') return { font: KIND_TO_FONT.serif, match: 'generic', kind: 'serif', siteFont: siteFontOf(firstNamed), why: `I do not know ${shown(firstNamed)}; the site says it is a serif, so ${KIND_TO_FONT.serif} is used.` };
    if (generic === 'mono') return { font: SYSTEM_FONT, match: 'generic', kind: 'mono', siteFont: siteFontOf(firstNamed), why: `I do not know ${shown(firstNamed)}; it is a code font, so the device font is used.` };
    if (generic === 'rounded') return { font: KIND_TO_FONT.rounded, match: 'generic', kind: 'rounded', siteFont: siteFontOf(firstNamed), why: `I do not know ${shown(firstNamed)}; it is a rounded font, so ${KIND_TO_FONT.rounded} is used.` };
    return { font: KIND_TO_FONT.grotesk, match: 'guess', kind: 'grotesk', siteFont: siteFontOf(firstNamed), why: `I do not know ${shown(firstNamed)}, so ${KIND_TO_FONT.grotesk} is used as a clean, neutral stand-in.` };
  }
  if (generic === 'serif') return { font: KIND_TO_FONT.serif, match: 'generic', kind: 'serif', siteFont: null, why: `The site uses the device serif font, so ${KIND_TO_FONT.serif} is used.` };
  return { font: SYSTEM_FONT, match: 'device', kind: 'system', siteFont: null, why: 'The site uses the device font, so the device font is used.' };
}

/**
 * Body and heading fonts for a token file.
 * `body` and `heading` are CSS font-family values. -> { font: { body, heading }, notes: [string] }
 */
export function mapFonts({ body, heading }) {
  const b = mapFontStack(body);
  const h = heading ? mapFontStack(heading) : b;
  const notes = [b.why];
  if (heading && h.font !== b.font) notes.push(`Headings: ${h.why}`);
  return { font: { body: b.font, heading: h.font === b.font ? 'same' : h.font }, body: b, heading: h, notes };
}
