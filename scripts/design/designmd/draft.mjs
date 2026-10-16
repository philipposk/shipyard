// From a parsed DESIGN.md to a Shipyard token draft. Only style is taken: colours, fonts, corner size
// and layout feel. Names, logos, images and text never go into the draft.
import { contrast, hexToHsl, hslToHex, luminance, mix, colourName } from '../color.mjs';
import { darkFromLight } from '../dark-from-light.mjs';
import { DEFAULT_LAYOUT, DEFAULT_TYPE, normalizeTokens, RADIUS_MAX } from '../tokens.mjs';
import { validateTokens, autoFix } from '../validate.mjs';
import { splitFrontMatter, extractColors, sections, sectionText, px, resolveRef } from './parse.mjs';
import { mapFont } from './font-map.mjs';

const WHITE = '#ffffff';
const NEAR_BLACK = '#0b0d12';
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---- colours ----
const sat = (hex) => hexToHsl(hex).s;
const lightness = (hex) => hexToHsl(hex).l;
const readableOn = (bg) => (contrast(WHITE, bg) >= contrast(NEAR_BLACK, bg) ? WHITE : NEAR_BLACK);

/** First colour whose label matches the first pattern that matches anything. */
function pick(colors, patterns, { skip = null, ok = () => true } = {}) {
  for (const re of patterns) {
    for (const [k, v] of Object.entries(colors)) if (re.test(k) && !(skip && skip.test(k)) && ok(v, k)) return { key: k, hex: v };
  }
  return null;
}

const STATE = /(hover|press|pressed|active|deep|dark|soft|subdued|focus|disabled|bg|tint|light)/;

/** Find the colour for each role by the words in its name. `guessed` lists the roles filled in by rule. */
export function findRoles(colors) {
  const guessed = [];
  const entries = Object.entries(colors);
  const neutral = entries.filter(([, v]) => sat(v) < 0.25);

  let bg = pick(colors, [/^(canvas|background|bg|page|base|paper)$/, /^(canvas|background|bg|page|paper)(-|$)/, /^surface$/], { skip: /(inverse|dark|on-)/ });
  if (!bg) {
    guessed.push('page background');
    const light = neutral.filter(([, v]) => lightness(v) > 0.9).sort((a, b) => lightness(b[1]) - lightness(a[1]))[0];
    bg = { key: light?.[0] ?? '', hex: light?.[1] ?? WHITE };
  }
  let card = pick(colors, [/^(card|surface-card|panel)$/, /^surface-(1|card)$/, /^surface$/, /^(surface|elevated)(-|$)/], {
    skip: /(inverse|dark|on-|tint)/, ok: (v) => v !== bg.hex,
  });
  if (!card) {
    card = { key: '', hex: luminance(bg.hex) < 0.18 ? mix(bg.hex, WHITE, 0.055) : bg.hex };
    guessed.push('card colour');
  }
  let fg = pick(colors, [/^(ink|text|foreground|on-surface|on-canvas|on-background|body|text-primary|ink-primary)$/, /^(ink|text)(-|$)/, /^(charcoal|on-dark)$/], {
    skip: /(mute|subtle|secondary|tertiary|inverse|disabled|link)/, ok: (v) => contrast(v, bg.hex) >= 4.5,
  });
  if (!fg) {
    guessed.push('text colour');
    const best = neutral.sort((a, b) => contrast(b[1], bg.hex) - contrast(a[1], bg.hex))[0];
    fg = { key: best?.[0] ?? '', hex: best && contrast(best[1], bg.hex) >= 4.5 ? best[1] : luminance(bg.hex) < 0.18 ? '#f1f2f4' : '#14171c' };
  }
  let muted = pick(colors, [/mute/, /subtle/, /secondary/, /slate/, /steel/, /stone/, /gr[ae]y/, /tertiary/, /caption/], {
    skip: /(inverse|on-dark|hairline|border|canvas|surface)/, ok: (v) => contrast(v, bg.hex) >= 4.5 && contrast(v, card.hex) >= 4.5 && contrast(v, fg.hex) > 1.3,
  });
  if (!muted) {
    muted = { key: '', hex: mix(fg.hex, bg.hex, 0.4) };
    guessed.push('grey text');
  }
  let line = pick(colors, [/^(hairline|border|line|divider|outline)$/, /(hairline|border|divider|line)/], { skip: /(strong|focus|input|tertiary|dark|inverse)/ });
  if (!line) {
    line = { key: '', hex: mix(card.hex, luminance(bg.hex) < 0.18 ? WHITE : '#000000', 0.1) };
    guessed.push('border colour');
  }
  let lineStrong = pick(colors, [/(hairline|border|line|divider)-strong/, /(hairline|border)-(input|tertiary)/, /^(hairline|border)-/], { skip: /(inverse|focus)/, ok: (v) => v !== line.hex });
  if (!lineStrong) {
    lineStrong = { key: '', hex: mix(line.hex, fg.hex, 0.25) };
    guessed.push('input border colour');
  }
  let accent = pick(colors, [/^(primary|accent|brand)$/, /^(primary|accent)$/, /^brand-(primary|accent)$/, /^primary(?!.*(hover|press|deep|dark|soft|subdued|disabled))/, /^(accent|brand)(?!.*(hover|press|deep|dark|soft|navy|dark))/], {
    ok: (v) => sat(v) > 0.08 || entries.every(([, x]) => sat(x) <= 0.08),
  });
  if (!accent) {
    guessed.push('accent colour');
    const best = entries.filter(([, v]) => lightness(v) > 0.2 && lightness(v) < 0.75).sort((a, b) => sat(b[1]) - sat(a[1]))[0];
    accent = { key: best?.[0] ?? '', hex: best?.[1] ?? '#2563eb' };
  }
  let accentContrast = pick(colors, [/^on-(primary|accent|brand)$/], { ok: (v) => contrast(v, accent.hex) >= 4.5 });
  if (!accentContrast) accentContrast = { key: '', hex: readableOn(accent.hex) };
  let danger = pick(colors, [/^(semantic-)?(error|danger|negative|destructive|critical)$/, /(error|danger|ruby|alert)/, /^(semantic-)?red$/], { skip: STATE });
  if (!danger) {
    danger = { key: '', hex: '#c0362c' };
    guessed.push('error colour');
  }
  return { bg, card, fg, muted, line, lineStrong, accent, accentContrast, danger, guessed, isDark: luminance(bg.hex) < 0.18 };
}

const rolesToBlock = (r) => ({
  background: r.bg.hex, foreground: r.fg.hex, card: r.card.hex, muted: r.muted.hex, line: r.line.hex, lineStrong: r.lineStrong.hex,
  accent: r.accent.hex, accentContrast: r.accentContrast.hex, focus: r.accent.hex, danger: r.danger.hex, dangerContrast: readableOn(r.danger.hex),
});

/** A light set that goes with a dark-only design (same accent hue, white cards, tinted paper page). */
export function lightFromDark(block) {
  const accentHsl = hexToHsl(block.accent);
  const tint = accentHsl.s < 0.08 ? 0 : 0.04;
  const background = mix('#f6f7f9', block.accent, tint);
  const card = WHITE;
  const foreground = mix('#14171c', block.accent, tint * 2);
  let accent = block.accent;
  for (let l = accentHsl.l; l >= 0.05 && (contrast(accent, background) < 4.5 || contrast(accent, card) < 4.5); l -= 0.01) {
    accent = hslToHex({ h: accentHsl.h, s: accentHsl.s, l });
  }
  let danger = block.danger;
  const dh = hexToHsl(danger);
  for (let l = dh.l; l >= 0.05 && contrast(danger, background) < 4.5; l -= 0.01) danger = hslToHex({ h: dh.h, s: dh.s, l });
  return {
    background, foreground, card, muted: hslToHex({ h: hexToHsl(background).h, s: 0.08, l: 0.38 }),
    line: mix(card, '#000000', 0.1), lineStrong: mix(card, '#000000', 0.3), accent, accentContrast: readableOn(accent),
    focus: accent, danger, dangerContrast: readableOn(danger),
  };
}

// ---- type ----
function typographyInfo(data) {
  const typo = data?.typography && typeof data.typography === 'object' ? data.typography : {};
  const rows = Object.entries(typo).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => ({
    key: k.toLowerCase(), family: v.fontFamily, size: px(v.fontSize), weight: Number(v.fontWeight) || null, spacing: px(v.letterSpacing),
  }));
  const headingRows = rows.filter((r) => /(display|hero|heading|headline|title|^h[1-3])/.test(r.key) && r.size).sort((a, b) => b.size - a.size);
  const body = rows.find((r) => r.key === 'body') ?? rows.find((r) => r.key === 'body-md') ?? rows.find((r) => r.key.startsWith('body') && r.size) ?? null;
  return { rows, heading: headingRows[0] ?? null, body };
}

const snapWeight = (w) => (w == null ? DEFAULT_TYPE.headingWeight : [500, 600, 700, 800].reduce((b, c) => (Math.abs(c - w) < Math.abs(b - w) ? c : b), 500));

// ---- the rest of the look, from the words in the file ----
function resolvePx(data, value) {
  const v = resolveRef(data, value);
  return px(v);
}

function radiusInfo(data) {
  const rounded = data?.rounded && typeof data.rounded === 'object' ? data.rounded : {};
  const comps = data?.components && typeof data.components === 'object' ? data.components : {};
  const vals = Object.values(rounded).map(px).filter((n) => n !== null && n > 0 && n < 999).sort((a, b) => a - b);
  const compRadius = (re) => {
    for (const [k, v] of Object.entries(comps)) {
      if (!re.test(k) || !v || typeof v !== 'object' || v.rounded === undefined) continue;
      const n = resolvePx(data, v.rounded);
      if (n !== null) return n;
    }
    return null;
  };
  const cardR = compRadius(/card/i);
  const buttonR = compRadius(/^button-primary|^button/i);
  const pill = buttonR !== null && buttonR >= 999;
  let base = cardR !== null && cardR < 999 ? cardR : vals.length ? vals[Math.floor((vals.length - 1) * 0.7)] : null;
  let sm = buttonR !== null && buttonR < 999 ? buttonR : vals.length ? vals[Math.floor((vals.length - 1) * 0.4)] : null;
  const guessed = base === null || sm === null;
  base = clamp(Math.round(base ?? 14), 0, RADIUS_MAX);
  sm = clamp(Math.round(sm ?? Math.min(base, 10)), 0, RADIUS_MAX);
  if (sm > base) sm = base;
  return { base, sm, pill, sharp: buttonR !== null && buttonR <= 2, guessed };
}

function layoutHints(data, body) {
  const secs = sections(body);
  const desc = `${data?.description ?? ''}\n${sectionText(secs, /overview|theme|atmosphere|philosophy/i)}`;
  const depth = sectionText(secs, /depth|elevation|shadow/i);
  const layoutText = sectionText(secs, /layout|spacing|grid/i);
  const navText = `${sectionText(secs, /navigation|\bnav\b|header/i)}\n${Object.keys(data?.components ?? {}).filter((k) => /nav|header/i.test(k)).join(' ')}`;
  const comps = data?.components && typeof data.components === 'object' ? data.components : {};
  const colorKeys = Object.keys(data?.colors ?? {});

  const noShadow = /\b(no|without|zero)\s+(drop\s+)?shadows?\b|shadow-?less|\bflat\b/i.test(depth);
  const hasShadow = /shadow/i.test(depth) && !noShadow;
  const hasBorder = /hairline|1px|border|outline/i.test(depth);
  const tinted = colorKeys.filter((k) => /tint/i.test(k)).length >= 3;
  const cards = tinted ? 'tinted' : hasBorder ? 'bordered' : hasShadow ? 'elevated' : depth ? 'flat' : DEFAULT_LAYOUT.cards;
  const shadow = hasShadow ? (/blur|soft|ambient|diffuse|rgba/i.test(depth) ? 'soft' : 'crisp') : hasBorder ? 'crisp' : depth ? 'none' : 'soft';

  const nav = /sidebar|left rail|side rail|side nav|left-hand/i.test(navText) ? 'sidebar'
    : /top nav|top bar|topbar|navbar|nav bar|horizontal|sticky|masthead|header/i.test(navText) ? 'top-nav' : DEFAULT_LAYOUT.nav;
  const home = /editorial|magazine|journal|article|publication|essay/i.test(desc) ? 'editorial'
    : /card grid|bento|grid of cards|feature cards/i.test(desc) ? 'cards'
      : /split|two-column|two column|side-by-side/i.test(desc) ? 'split'
        : /dashboard|app shell|data-dense|dense/i.test(desc) ? 'list' : DEFAULT_LAYOUT.home;
  const header = /(centered|centred)\s+(logo|wordmark|brand)|(logo|wordmark|brand)\s+(is\s+)?(centered|centred)/i.test(navText) ? 'centered'
    : /transparent\s+(nav|header)|no (bar|border)|frameless/i.test(navText) ? 'plain' : DEFAULT_LAYOUT.header;

  let padding = null;
  for (const [k, v] of Object.entries(comps)) if (/card/i.test(k) && v?.padding) padding = padding ?? px(String(v.padding).split(/\s+/)[0]);
  const words = `${desc}\n${layoutText}`;
  const density = padding !== null ? (padding >= 28 ? 'airy' : padding <= 14 ? 'compact' : 'regular')
    : /generous|airy|spacious|breathing room/i.test(words) ? 'airy' : /\bdense\b|\bcompact\b|\btight\b/i.test(words) ? 'compact' : DEFAULT_LAYOUT.density;

  let widest = null;
  for (const line of layoutText.split('\n')) {
    if (!/max-?width|container|content width/i.test(line)) continue;
    for (const m of line.matchAll(/(\d{3,4})\s*px/g)) {
      const n = Number(m[1]);
      if (n >= 600 && n <= 1600) widest = Math.max(widest ?? 0, n);
    }
  }
  const maxWidth = widest === null ? DEFAULT_LAYOUT.maxWidth : widest <= 720 ? 'narrow' : widest >= 1100 ? 'wide' : 'medium';
  return { cards, shadow, nav, home, header, density, maxWidth };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * draftFromDesignMd(text, { languages }) ->
 *   { tokens, summary: string[], changes: string[], warnings: string[], errors: string[], guessed: string[], fonts: [...] }
 * `tokens` has been through validateTokens + autoFix. The id and name are neutral on purpose (never the brand).
 */
export function draftFromDesignMd(text, { languages = ['en'] } = {}) {
  const { data, body } = splitFrontMatter(text);
  const { colors, fromText } = extractColors(data, body);
  if (Object.keys(colors).length < 2) {
    return { tokens: null, errors: ['I could not find colours in this file. A DESIGN.md should list colours with hex codes like #533afd.'], summary: [], changes: [], warnings: [], guessed: [], fonts: [] };
  }
  const roles = findRoles(colors);
  const found = rolesToBlock(roles);
  let light;
  let dark;
  if (roles.isDark) {
    dark = found;
    dark.card = roles.card.key ? dark.card : mix(dark.background, WHITE, 0.055);
    light = lightFromDark(dark);
  } else {
    light = found;
    dark = darkFromLight(light);
  }

  const typo = typographyInfo(data);
  const bodyFont = mapFont(typo.body?.family ?? typo.rows[0]?.family ?? (fromText ? fontFromText(body) : ''));
  const headFont = mapFont(typo.heading?.family ?? typo.body?.family ?? '');
  const bodySize = typo.body?.size ?? null;
  const scale = bodySize === null ? DEFAULT_TYPE.scale : bodySize <= 15 ? 'compact' : bodySize >= 17 ? 'large' : 'comfortable';
  const ratio = typo.heading?.spacing != null && typo.heading?.size ? typo.heading.spacing / typo.heading.size : 0;
  const headingTracking = ratio <= -0.015 ? 'tight' : ratio >= 0.005 ? 'wide' : DEFAULT_TYPE.headingTracking;

  const rad = radiusInfo(data);
  const hints = layoutHints(data, body);
  const buttons = rad.pill ? 'pill' : rad.sharp ? 'sharp' : 'solid';

  const colour = colourName(roles.accent.hex);
  const themeWord = roles.isDark ? 'dark' : 'light';
  const bodyName = bodyFont.name;
  const t = normalizeTokens({
    id: slug(`imported-${colour}-${themeWord}`),
    name: `${cap(colour)} accent, ${themeWord} look`,
    description: `A style drawn from a DESIGN.md file: ${themeWord} by default, ${scale} text, ${buttons} buttons, ${hints.cards} cards.`,
    goodFor: 'any app that should feel like the file it was drawn from',
    defaultTheme: roles.isDark ? 'dark' : 'light',
    font: { body: bodyName, heading: headFont.name === bodyName ? 'same' : headFont.name },
    radius: { base: rad.base, sm: rad.sm },
    shadow: hints.shadow,
    type: { scale, headingWeight: snapWeight(typo.heading?.weight), headingTracking },
    layout: {
      nav: hints.nav, density: hints.density, maxWidth: hints.maxWidth, home: hints.home, cards: hints.cards, buttons, header: hints.header,
    },
    light,
    dark,
  });

  const fixed = autoFix(t);
  const check = validateTokens(fixed.tokens, { languages });
  const guessed = [...roles.guessed];
  if (rad.guessed) guessed.push('corner size');
  if (!typo.body) guessed.push('fonts');
  if (!roles.isDark) guessed.push('dark colours (made from the light ones)');
  else guessed.push('light colours (made from the dark ones)');

  const fonts = [bodyFont, headFont].filter((f, i, a) => f.from && a.findIndex((x) => x.from === f.from) === i)
    .map((f) => `${/^[A-Za-z0-9 ._-]{1,40}$/.test(f.from) ? f.from : 'an unknown font'} -> ${f.name}${f.exact ? '' : ' (nearest free font)'}`);
  const a = fixed.tokens;
  const main = roles.isDark ? a.dark : a.light;
  const summary = [
    `Main colours: ${colourName(main.accent)} accent ${main.accent}, ${roles.isDark ? 'dark' : 'light'} page ${main.background}, text ${main.foreground}.`,
    `Fonts: ${fonts.length ? fonts.join('; ') : 'the device font'}.`,
    `Corners: ${rad.base}px on cards, ${rad.sm}px on buttons${rad.pill ? ' (the original buttons are pill shaped)' : ''}.`,
    `Layout: ${a.layout.nav} menu, ${a.layout.home} homepage, ${a.layout.cards} cards, ${a.layout.buttons} buttons, ${a.layout.density} spacing, ${a.type.scale} text, ${a.layout.maxWidth} page width.`,
  ];
  return { tokens: a, summary, changes: fixed.changes, warnings: check.warnings, errors: check.errors, guessed, fonts };
}

function fontFromText(body) {
  for (const line of String(body).split('\n')) {
    const m = line.match(/(?:font[- ]?family|typeface|font)\W+([A-Z][A-Za-z0-9 ,'"-]{2,60})/);
    if (m) return m[1];
  }
  return '';
}
