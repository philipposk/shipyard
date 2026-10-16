// Checks a token file the way a careful designer would: is it complete, can people read it,
// is it the "default AI look"? Also repairs small contrast problems automatically.
import { contrast, hexToHsl, hslToHex, isHex, normalizeHex } from './color.mjs';
import { COLOR_KEYS, COLOR_WORDS, DEFAULT_LAYOUT, DEFAULT_TYPE, ENUMS, ID_RE, RADIUS_MAX, SHADOWS, THEMES, headingFont, isObject } from './tokens.mjs';
import { isAllowedFont, allowedFontNames, subsetsForLanguages, missingSubsets, suggestCoveringFonts, subsetWords, nearestHeadingWeight, SYSTEM_FONT } from './fonts.mjs';

/** [text colour, background colour, minimum ratio, what it is in plain words] */
const RULES = [
  ['foreground', 'background', 4.5, 'the main text on the page background'],
  ['foreground', 'card', 4.5, 'the main text on cards'],
  ['muted', 'background', 4.5, 'the grey text on the page background'],
  ['muted', 'card', 4.5, 'the grey text on cards'],
  ['accentContrast', 'accent', 4.5, 'the text on accent buttons'],
  ['dangerContrast', 'danger', 4.5, 'the text on error buttons'],
  ['accent', 'background', 3, 'the accent colour against the page background'],
  ['accent', 'card', 3, 'the accent colour against cards'],
  ['focus', 'background', 3, 'the keyboard focus outline'],
];

const round1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const themeWord = (theme) => (theme === 'dark' ? 'dark look' : 'light look');

/** Merge defaults a loader can fill in before validating (heading "same"). */
function look(t) {
  return {
    ...t,
    font: isObject(t?.font) ? { heading: 'same', ...t.font } : t?.font,
    type: t?.type === undefined || t?.type === null ? { ...DEFAULT_TYPE } : isObject(t.type) ? { ...DEFAULT_TYPE, ...t.type } : t.type,
    layout: t?.layout === undefined || t?.layout === null ? { ...DEFAULT_LAYOUT } : isObject(t.layout) ? { ...DEFAULT_LAYOUT, ...t.layout } : t.layout,
  };
}

const PLAIN_FIELD = {
  'type.scale': 'text size ("type.scale")',
  'type.headingWeight': 'heading boldness ("type.headingWeight")',
  'type.headingTracking': 'letter spacing in headings ("type.headingTracking")',
  'layout.nav': 'menu style ("layout.nav")',
  'layout.density': 'spacing ("layout.density")',
  'layout.maxWidth': 'page width ("layout.maxWidth")',
  'layout.home': 'homepage style ("layout.home")',
  'layout.cards': 'card style ("layout.cards")',
  'layout.buttons': 'button style ("layout.buttons")',
  'layout.header': 'top bar style ("layout.header")',
};

/**
 * validateTokens(tokens, { languages }) -> { ok, errors: string[], warnings: string[], issues: [...] }
 * `issues` has the same findings with machine-readable codes (used by autoFix and tests).
 */
export function validateTokens(input, { languages = ['en'] } = {}) {
  const issues = [];
  const add = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra });
  const err = (code, message, extra) => add('error', code, message, extra);
  const warn = (code, message, extra) => add('warning', code, message, extra);

  if (!isObject(input)) {
    err('schema', 'The design file is not a JSON object.');
    return finish(issues);
  }
  const t = look(input);

  // ---- shape ----
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) err('schema', 'The look needs an "id": lower-case words joined by dashes, like "warm-friendly".', { path: 'id' });
  if (typeof t.name !== 'string' || t.name.trim() === '') err('schema', 'The look needs a "name" people can read, like "Warm and friendly".', { path: 'name' });
  for (const k of ['description', 'goodFor']) {
    if (t[k] !== undefined && typeof t[k] !== 'string') err('schema', `"${k}" must be text.`, { path: k });
  }
  if (t.defaultTheme !== 'light' && t.defaultTheme !== 'dark') err('schema', '"defaultTheme" must be "light" or "dark".', { path: 'defaultTheme' });
  if (!SHADOWS.includes(t.shadow)) err('schema', `"shadow" must be one of: ${SHADOWS.join(', ')}.`, { path: 'shadow' });

  // fonts
  if (!isObject(t.font)) {
    err('schema', 'The look needs a "font" with "body" and "heading".', { path: 'font' });
  } else {
    const names = allowedFontNames().join(', ');
    if (!isAllowedFont(t.font.body)) err('font', `The body font "${t.font.body}" is not one Shipyard can use. Pick one of: ${names}.`, { path: 'font.body' });
    if (t.font.heading !== 'same' && !isAllowedFont(t.font.heading)) {
      err('font', `The heading font "${t.font.heading}" is not one Shipyard can use. Use "same" or one of: ${names}.`, { path: 'font.heading' });
    }
  }

  // corners
  if (!isObject(t.radius)) {
    err('schema', 'The look needs "radius" with "base" and "sm" (corner sizes in pixels).', { path: 'radius' });
  } else {
    const { base, sm } = t.radius;
    const good = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= RADIUS_MAX;
    if (!good(base)) err('radius', `Card corners ("radius.base") must be a number from 0 to ${RADIUS_MAX} pixels.`, { path: 'radius.base' });
    if (!good(sm)) err('radius', `Button corners ("radius.sm") must be a number from 0 to ${RADIUS_MAX} pixels.`, { path: 'radius.sm' });
    if (good(base) && good(sm) && sm > base) err('radius', 'Button corners ("radius.sm") cannot be bigger than card corners ("radius.base").', { path: 'radius.sm' });
  }

  // type and layout (optional: missing ones use the template defaults)
  for (const [group, label] of [['type', 'text settings'], ['layout', 'layout settings']]) {
    if (!isObject(t[group])) {
      err('schema', `"${group}" (${label}) must be an object, or left out.`, { path: group });
      continue;
    }
    for (const [path, allowed] of Object.entries(ENUMS)) {
      if (!path.startsWith(`${group}.`)) continue;
      const v = t[group][path.slice(group.length + 1)];
      if (!allowed.includes(v)) {
        err('layout', `The ${PLAIN_FIELD[path]} must be one of: ${allowed.join(', ')}.`, { path });
      }
    }
  }
  if (isObject(t.type) && ENUMS['type.headingWeight'].includes(t.type.headingWeight) && isObject(t.font) && isAllowedFont(headingFont(t))) {
    const w = nearestHeadingWeight(headingFont(t), t.type.headingWeight);
    if (w.adjusted) {
      warn('heading-weight', `The heading font ${headingFont(t)} has no weight ${w.requested}, so ${w.weight} will be used.`, { path: 'type.headingWeight', weight: w.weight });
    }
  }
  if (isObject(t.layout)) {
    if (t.layout.home === 'editorial' && t.layout.nav === 'sidebar') {
      warn('odd-combo', 'An editorial homepage with a left sidebar is an unusual mix. Top links or bottom tabs usually suit it better.', { path: 'layout' });
    }
    if (t.layout.cards === 'bordered' && t.shadow === 'crisp') {
      warn('double-outline', 'Outlined cards with crisp shadows draw the outline twice. Pick "soft" or "none" shadows, or another card style.', { path: 'layout.cards' });
    }
    if (t.layout.cards === 'elevated' && t.shadow === 'none') {
      warn('no-shadow', 'Cards are set to float with a shadow, but the look has no shadows, so they will look flat. Pick "soft" or "crisp" shadows, or another card style.', { path: 'layout.cards' });
    }
  }

  // colours
  const usable = {};
  for (const theme of THEMES) {
    const block = t[theme];
    if (!isObject(block)) {
      err('schema', `The look needs a "${theme}" block with ${COLOR_KEYS.length} colours.`, { path: theme });
      continue;
    }
    usable[theme] = {};
    for (const k of COLOR_KEYS) {
      const v = block[k];
      if (!isHex(v)) {
        err('colour', `${theme}.${k} (${COLOR_WORDS[k]}) must be a 6-digit hex colour like #336699.`, { path: `${theme}.${k}`, theme });
      } else {
        usable[theme][k] = normalizeHex(v);
      }
    }
  }

  // ---- contrast (both themes) ----
  for (const theme of THEMES) {
    const c = usable[theme];
    if (!c) continue;
    for (const [a, b, min, words] of RULES) {
      if (!c[a] || !c[b]) continue;
      const ratio = contrast(c[a], c[b]);
      if (ratio < min) {
        err('contrast', `In the ${themeWord(theme)}, the contrast is too low for ${words} (${round1(ratio)} to 1, needs at least ${min} to 1).`, { theme, pair: [a, b], ratio, min });
      }
    }
    if (c.foreground && c.background && contrast(c.foreground, c.background) >= 4.5 && contrast(c.foreground, c.background) < 7) {
      warn('contrast-aaa', `In the ${themeWord(theme)}, the main text is readable but not crisp (${round1(contrast(c.foreground, c.background))} to 1; 7 to 1 is better).`, { theme });
    }
    if (c.line && c.card && contrast(c.line, c.card) < 1.15) {
      warn('line-invisible', `In the ${themeWord(theme)}, the thin lines are almost invisible against cards (${round1(contrast(c.line, c.card))} to 1).`, { theme });
    }
    if (c.lineStrong && c.card && contrast(c.lineStrong, c.card) < 1.5) {
      warn('input-border-faint', `In the ${themeWord(theme)}, input borders are very faint against cards (${round1(contrast(c.lineStrong, c.card))} to 1).`, { theme });
    }
    if (c.background && c.card && c.background === c.card) {
      warn('flat', `In the ${themeWord(theme)}, the page and the cards are the same colour, so cards only show by their border.`, { theme });
    }
    if (c.accent) {
      const { h, s } = hexToHsl(c.accent);
      if (h >= 255 && h <= 300 && s > 0.6) {
        warn('purple-slop', `In the ${themeWord(theme)}, the accent is a strong purple, the look most AI-made apps have. Fine if you want it; a less common colour feels more yours.`, { theme });
      }
    }
  }

  // ---- fonts and languages ----
  if (isObject(t.font)) {
    const wanted = subsetsForLanguages(languages);
    const seen = new Set();
    for (const [role, name] of [['body', t.font.body], ['heading', t.font.heading === 'same' ? null : t.font.heading]]) {
      if (!name || seen.has(name) || !isAllowedFont(name) || name === SYSTEM_FONT) continue;
      seen.add(name);
      const missing = missingSubsets(name, wanted);
      if (missing.length > 0) {
        const alternatives = suggestCoveringFonts(name, wanted).join(', ');
        warn('font-subset', `The ${role} font ${name} has no ${missing.map(subsetWords).join(' or ')}, which your app's languages need. Try: ${alternatives}.`, { path: `font.${role}`, missing });
      }
    }
  }

  return finish(issues);
}

function finish(issues) {
  const errors = issues.filter((i) => i.level === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.level === 'warning').map((i) => i.message);
  return { ok: errors.length === 0, errors, warnings, issues };
}

// ---------------------------------------------------------------------------------------------
// autoFix: only lightness moves (hue and saturation stay), in small steps, then reports in words.

const STEP = 0.01;

/**
 * Walk the lightness of `hex` up and down until `passes(candidate)` is true.
 * Returns the passing colour with the smallest move (ties go darker), or null.
 */
function nudge(hex, passes) {
  if (passes(hex)) return hex;
  const { h, s, l } = hexToHsl(hex);
  let best = null;
  for (const dir of [-1, 1]) {
    for (let k = 1; k <= 100; k++) {
      const nl = l + dir * k * STEP;
      if (nl < 0 || nl > 1) break;
      const cand = hslToHex({ h, s, l: nl });
      if (passes(cand)) {
        if (!best || k < best.k) best = { hex: cand, k };
        break;
      }
    }
  }
  return best?.hex ?? null;
}

/** Like nudge, but only in the direction that moves away from `backdrops` (for text on a background). */
function nudgeAway(hex, backdrops, passes) {
  if (passes(hex)) return hex;
  const { h, s, l } = hexToHsl(hex);
  const avgLum = backdrops.reduce((n, b) => n + hexToHsl(b).l, 0) / backdrops.length;
  const dir = avgLum > 0.5 ? -1 : 1;
  for (let k = 1; k <= 100; k++) {
    const nl = l + dir * k * STEP;
    if (nl < 0 || nl > 1) break;
    const cand = hslToHex({ h, s, l: nl });
    if (passes(cand)) return cand;
  }
  return nudge(hex, passes);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * autoFix(tokens) -> { tokens, changes[] }
 * Repairs contrast problems (and out-of-range corners) in small steps. Never touches
 * fonts, names or the colours it was not asked to move.
 */
export function autoFix(input) {
  const tokens = clone(isObject(input) ? input : {});
  const changes = [];
  if (!isObject(tokens.light) || !isObject(tokens.dark)) return { tokens, changes };

  for (const theme of THEMES) {
    const c = tokens[theme];
    for (const k of COLOR_KEYS) {
      const n = normalizeHex(c[k]);
      if (n) c[k] = n;
    }
    if (!COLOR_KEYS.every((k) => isHex(c[k]))) continue; // cannot repair missing/broken colours
    const who = themeWord(theme);
    const set = (key, value, message) => {
      if (value && value !== c[key]) {
        c[key] = value;
        changes.push(`${message} (${who})`);
      }
    };

    // grey text readable on page and cards
    set('muted', nudgeAway(c.muted, [c.background, c.card], (x) => contrast(x, c.background) >= 4.5 && contrast(x, c.card) >= 4.5),
      `made the grey text a bit ${hexToHsl(c.background).l > 0.5 ? 'darker' : 'lighter'} so it is readable`);
    // focus outline visible
    set('focus', nudgeAway(c.focus, [c.background], (x) => contrast(x, c.background) >= 3),
      'made the keyboard focus outline stronger so it is easy to see');
    // input borders not faint
    set('lineStrong', nudgeAway(c.lineStrong, [c.card], (x) => contrast(x, c.card) >= 1.5),
      'made the input borders a little stronger so fields are easy to find');
    // accent visible against page and cards (accent moves last)
    set('accent', nudgeAway(c.accent, [c.background, c.card], (x) => contrast(x, c.background) >= 3 && contrast(x, c.card) >= 3),
      `made the accent colour a bit ${hexToHsl(c.background).l > 0.5 ? 'darker' : 'lighter'} so buttons and links stand out`);
    // text on accent / error buttons (after the accent settled)
    set('accentContrast', nudge(c.accentContrast, (x) => contrast(x, c.accent) >= 4.5), 'changed the text colour on accent buttons so it is readable');
    set('dangerContrast', nudge(c.dangerContrast, (x) => contrast(x, c.danger) >= 4.5), 'changed the text colour on error buttons so it is readable');
  }

  // corners
  if (isObject(tokens.radius)) {
    const r = tokens.radius;
    const fixNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(RADIUS_MAX, Math.max(0, Math.round(n))) : n);
    const base = fixNum(r.base);
    const sm = fixNum(r.sm);
    if (base !== r.base) {
      changes.push(`brought the card corners into range (${base} pixels)`);
      r.base = base;
    }
    if (sm !== r.sm) {
      changes.push(`brought the button corners into range (${sm} pixels)`);
      r.sm = sm;
    }
    if (typeof r.base === 'number' && typeof r.sm === 'number' && r.sm > r.base) {
      changes.push(`made the button corners no bigger than the card corners (${r.base} pixels)`);
      r.sm = r.base;
    }
  }
  return { tokens, changes };
}
