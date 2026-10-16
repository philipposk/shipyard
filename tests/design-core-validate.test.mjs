import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTokens, autoFix } from '../scripts/design/validate.mjs';
import { darkFromLight } from '../scripts/design/dark-from-light.mjs';
import { contrast, hexToHsl } from '../scripts/design/color.mjs';
import { COLOR_KEYS } from '../scripts/design/tokens.mjs';
import { allowedFontNames, subsetsForLanguages, renderFontsTs, googleFontsCssUrl, getFont } from '../scripts/design/fonts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_DIR = path.join(root, 'presets');
const preset = async (id) => JSON.parse(await readFile(path.join(PRESET_DIR, `${id}.tokens.json`), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const GOOD = () => clone({
  id: 'test-look', name: 'Test look', description: 'd', goodFor: 'g', defaultTheme: 'light',
  font: { body: 'Inter', heading: 'same' }, radius: { base: 14, sm: 10 }, shadow: 'soft',
  light: { background: '#f6f7f9', foreground: '#14161a', card: '#ffffff', muted: '#5b6270', line: '#e3e6eb', lineStrong: '#b9bfca', accent: '#2563eb', accentContrast: '#ffffff', focus: '#2563eb', danger: '#c0362c', dangerContrast: '#ffffff' },
  dark: { background: '#0e1116', foreground: '#eceff4', card: '#171b22', muted: '#9aa3b2', line: '#262c36', lineStrong: '#3a4250', accent: '#6b9bff', accentContrast: '#0a0f1a', focus: '#6b9bff', danger: '#ef6a5e', dangerContrast: '#14161a' },
});

test('a good token file passes with no errors or warnings', () => {
  const r = validateTokens(GOOD());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test('schema: each broken field is an error', () => {
  const cases = [
    ['not an object', () => 'nope', /not a JSON object/],
    ['bad id', (t) => { t.id = 'Bad Id'; }, /"id"/],
    ['missing name', (t) => { delete t.name; }, /"name"/],
    ['bad defaultTheme', (t) => { t.defaultTheme = 'sepia'; }, /defaultTheme/],
    ['bad shadow', (t) => { t.shadow = 'huge'; }, /shadow/],
    ['missing font', (t) => { delete t.font; }, /"font"/],
    ['missing radius', (t) => { delete t.radius; }, /radius/],
    ['missing dark block', (t) => { delete t.dark; }, /"dark" block/],
    ['3-digit hex', (t) => { t.light.accent = '#abc'; }, /light\.accent/],
    ['named colour', (t) => { t.dark.card = 'black'; }, /dark\.card/],
    ['missing colour key', (t) => { delete t.light.line; }, /light\.line/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const t = GOOD();
    const maybe = mutate(t);
    const r = validateTokens(typeof maybe === 'string' ? maybe : t);
    assert.equal(r.ok, false, label);
    assert.ok(r.errors.some((e) => pattern.test(e)), `${label}: ${r.errors.join(' | ')}`);
  }
});

test('fonts: only the allowed list (and "system") passes; heading may be "same"', () => {
  for (const name of allowedFontNames()) {
    const t = GOOD();
    t.font = { body: name, heading: 'same' };
    assert.equal(validateTokens(t, { languages: ['en'] }).ok, true, name);
  }
  const bad = GOOD();
  bad.font = { body: 'Comic Sans MS', heading: 'same' };
  assert.match(validateTokens(bad).errors.join('\n'), /Comic Sans MS/);
  const bad2 = GOOD();
  bad2.font = { body: 'Inter', heading: 'Papyrus' };
  assert.match(validateTokens(bad2).errors.join('\n'), /Papyrus/);
  const noHeading = GOOD();
  delete noHeading.font.heading;
  assert.equal(validateTokens(noHeading).ok, true);
  assert.equal(allowedFontNames().length, 13);
});

test('radius: range 0..28 and sm <= base', () => {
  for (const [base, sm, ok] of [[0, 0, true], [28, 28, true], [14, 10, true], [29, 10, false], [-1, 0, false], [14, 15, false], ['14', 10, false], [14, 'x', false]]) {
    const t = GOOD();
    t.radius = { base, sm };
    assert.equal(validateTokens(t).ok, ok, `${base}/${sm}`);
  }
});

test('contrast rules: each one fails below its limit and passes above, in both themes', () => {
  // [rule label, theme, key to break, bad value, message pattern]
  const cases = [
    ['text on page', 'light', 'foreground', '#aaaaaa', /main text on the page background/],
    ['text on card', 'dark', 'foreground', '#222831', /main text on cards/],
    ['grey on page', 'light', 'muted', '#b0b0b0', /grey text on the page background/],
    ['grey on card', 'dark', 'muted', '#2a3038', /grey text on cards/],
    ['on-accent', 'light', 'accentContrast', '#cfd8ff', /text on accent buttons/],
    ['on-danger', 'dark', 'dangerContrast', '#ef6a5e', /text on error buttons/],
    ['accent vs page', 'light', 'accent', '#e0e4ea', /accent colour against the page/],
    ['accent vs card', 'dark', 'accent', '#1b2029', /accent colour against cards/],
    ['focus', 'light', 'focus', '#f0f0f0', /keyboard focus/],
  ];
  for (const [label, theme, key, bad, pattern] of cases) {
    const t = GOOD();
    t[theme][key] = bad;
    const r = validateTokens(t);
    assert.equal(r.ok, false, label);
    assert.ok(r.errors.some((e) => pattern.test(e) && e.includes(theme === 'dark' ? 'dark look' : 'light look')), `${label}: ${r.errors.join(' | ')}`);
  }
});

test('contrast boundaries: 4.5 is the error line for text, 3 for accent', () => {
  const t = GOOD();
  t.light.foreground = '#767676'; // 4.1 on #f6f7f9, 4.54 on white
  t.light.card = '#ffffff';
  assert.match(validateTokens(t).errors.join('\n'), /main text on the page background/);
  const u = GOOD();
  u.light.background = '#ffffff';
  u.light.foreground = '#767676';
  const r = validateTokens(u);
  assert.equal(r.errors.some((e) => /main text/.test(e)), false);
  assert.ok(r.warnings.some((w) => /not crisp/.test(w)), 'between 4.5 and 7 is a warning');
});

test('warnings: faint lines, flat page, purple accent, missing letters', () => {
  const faint = GOOD();
  faint.light.line = '#fafafa';
  assert.ok(validateTokens(faint).warnings.some((w) => /almost invisible/.test(w)));
  const faintInput = GOOD();
  faintInput.dark.lineStrong = '#1a1f27';
  assert.ok(validateTokens(faintInput).warnings.some((w) => /input borders are very faint/.test(w)));
  const flat = GOOD();
  flat.light.background = '#ffffff';
  assert.ok(validateTokens(flat).warnings.some((w) => /same colour/.test(w)));
  const purple = GOOD();
  purple.light.accent = '#7c3aed';
  purple.light.focus = '#7c3aed';
  const pr = validateTokens(purple);
  assert.equal(pr.ok, true);
  assert.ok(pr.warnings.some((w) => /strong purple/.test(w)), pr.warnings.join('|'));
  const softPurple = GOOD();
  softPurple.light.accent = '#6b6490'; // dull purple, low saturation: no warning
  softPurple.light.focus = '#6b6490';
  assert.ok(!validateTokens(softPurple).warnings.some((w) => /purple/.test(w)));
  // letters: DM Sans has no Greek
  const dm = GOOD();
  dm.font = { body: 'DM Sans', heading: 'same' };
  const w = validateTokens(dm, { languages: ['en', 'el'] }).warnings.join('\n');
  assert.match(w, /DM Sans has no Greek letters/);
  assert.match(w, /Try: /);
  assert.equal(validateTokens(dm, { languages: ['en'] }).warnings.length, 0);
  const sys = GOOD();
  sys.font = { body: 'system', heading: 'same' };
  assert.equal(validateTokens(sys, { languages: ['el', 'ru', 'ja'] }).warnings.length, 0);
});

test('autoFix: makes failing tokens pass and only moves lightness', () => {
  const broken = GOOD();
  broken.light.muted = '#a9b0bd';
  broken.light.focus = '#cfd9f7';
  broken.light.accentContrast = '#d6e0ff';
  broken.light.accent = '#9db8f5';
  broken.dark.muted = '#3a4250';
  broken.dark.dangerContrast = '#ef6a5e';
  broken.dark.lineStrong = '#191d24';
  assert.equal(validateTokens(broken).ok, false);

  const { tokens, changes } = autoFix(broken);
  const after = validateTokens(tokens);
  assert.deepEqual(after.errors, []);
  assert.ok(changes.length >= 5);
  assert.ok(changes.every((c) => /\((light|dark) look\)$/.test(c)), changes.join('\n'));

  // only the allowed keys moved, and for each one only the lightness did
  const movable = new Set(['muted', 'focus', 'lineStrong', 'accent', 'accentContrast', 'dangerContrast']);
  for (const theme of ['light', 'dark']) {
    for (const k of COLOR_KEYS) {
      if (tokens[theme][k] === broken[theme][k]) continue;
      assert.ok(movable.has(k), `${theme}.${k} should not move`);
      const a = hexToHsl(broken[theme][k]);
      const b = hexToHsl(tokens[theme][k]);
      if (a.s > 0.15 && a.l > 0.1 && a.l < 0.9) assert.ok(Math.abs(a.h - b.h) < 6, `${theme}.${k} hue moved ${a.h} -> ${b.h}`);
    }
  }
  assert.deepEqual({ ...tokens, light: 0, dark: 0 }, { ...broken, light: 0, dark: 0 });
  // the input was not changed in place
  assert.equal(broken.light.muted, '#a9b0bd');
});

test('autoFix: small steps (a nearly-passing grey moves only a little) and nothing to fix = no changes', () => {
  const t = GOOD();
  t.light.muted = '#737a88'; // just under 4.5
  const { tokens, changes } = autoFix(t);
  assert.equal(changes.length, 1);
  assert.ok(Math.abs(hexToHsl(tokens.light.muted).l - hexToHsl(t.light.muted).l) <= 0.05);
  assert.equal(autoFix(GOOD()).changes.length, 0);
});

test('autoFix: repairs corners and white-on-yellow style accent text; cannot invent missing colours', () => {
  const t = GOOD();
  t.radius = { base: 40, sm: 50 };
  t.light.accent = '#f5c518';
  t.light.accentContrast = '#ffffff';
  const { tokens, changes } = autoFix(t);
  assert.deepEqual(tokens.radius, { base: 28, sm: 28 });
  assert.ok(changes.some((c) => /corners/.test(c)));
  assert.equal(validateTokens(tokens).ok, true, validateTokens(tokens).errors.join('|'));
  const incomplete = GOOD();
  delete incomplete.dark.card;
  assert.equal(validateTokens(autoFix(incomplete).tokens).ok, false);
});

test('all 8 presets exist, pass with zero errors, and show no purple warning', async () => {
  const files = (await readdir(PRESET_DIR)).filter((f) => f.endsWith('.tokens.json')).sort();
  assert.deepEqual(files.map((f) => f.replace('.tokens.json', '')), [
    'calm-blue', 'clean-mono', 'editorial', 'fresh-green', 'night-tech', 'playful', 'soft-pastel', 'warm-friendly',
  ]);
  const accents = new Set();
  for (const f of files) {
    const t = JSON.parse(await readFile(path.join(PRESET_DIR, f), 'utf8'));
    assert.equal(`${t.id}.tokens.json`, f);
    const r = validateTokens(t, { languages: ['en'] });
    assert.deepEqual(r.errors, [], `${t.id} errors`);
    assert.ok(!r.warnings.some((w) => /purple/.test(w)), `${t.id} purple`);
    assert.deepEqual(r.warnings, [], `${t.id} warnings`);
    accents.add(t.light.accent);
    for (const k of ['name', 'description', 'goodFor']) assert.ok(t[k].length > 5, `${t.id}.${k}`);
    // names describe a style, never a brand
    assert.ok(!/google|apple|stripe|notion|linear|vercel|spotify|airbnb|figma/i.test(JSON.stringify(t)), t.id);
    assert.ok(!t.description.includes('—'), 'no em dash');
  }
  assert.equal(accents.size, 8, 'every preset has its own accent');
});

test('presets match the spec: fonts, radius, shadow, default theme', async () => {
  const p = Object.fromEntries(await Promise.all(['calm-blue', 'clean-mono', 'warm-friendly', 'editorial', 'fresh-green', 'playful', 'night-tech', 'soft-pastel'].map(async (id) => [id, await preset(id)])));
  assert.deepEqual(p['calm-blue'].font, { body: 'system', heading: 'same' });
  assert.deepEqual(p['calm-blue'].radius, { base: 14, sm: 10 });
  assert.equal(p['calm-blue'].light.accent, '#2563eb');
  assert.equal(p['clean-mono'].font.body, 'Inter');
  assert.equal(p['clean-mono'].shadow, 'crisp');
  assert.deepEqual(p['clean-mono'].radius, { base: 8, sm: 6 });
  assert.deepEqual(p['warm-friendly'].radius, { base: 18, sm: 12 });
  assert.ok(['DM Sans', 'Nunito'].includes(p['warm-friendly'].font.body));
  assert.equal(p.editorial.shadow, 'none');
  assert.deepEqual(p.editorial.radius, { base: 4, sm: 2 });
  assert.equal(p.editorial.font.heading, 'Fraunces');
  assert.equal(p['fresh-green'].font.body, 'Manrope');
  assert.equal(p.playful.font.heading, 'Space Grotesk');
  assert.deepEqual(p.playful.radius, { base: 22, sm: 14 });
  assert.equal(p['night-tech'].defaultTheme, 'dark');
  assert.equal(p['night-tech'].font.body, 'IBM Plex Sans');
  assert.equal(p['night-tech'].shadow, 'none', 'bordered cards plus crisp shadows draw a doubled outline');
  assert.equal(p['soft-pastel'].font.body, 'Nunito');
  assert.deepEqual(p['soft-pastel'].radius, { base: 24, sm: 16 });
  for (const t of Object.values(p)) if (t.id !== 'night-tech') assert.equal(t.defaultTheme, 'light');
  // calm-blue dark equals the template's dark look
  assert.equal(p['calm-blue'].dark.background, '#0e1116');
});

test('darkFromLight passes validation for every preset light theme and for odd accents', async () => {
  const lights = [];
  for (const f of (await readdir(PRESET_DIR)).filter((n) => n.endsWith('.tokens.json'))) {
    lights.push([f, (await preset(f.replace('.tokens.json', ''))).light]);
  }
  for (const accent of ['#ff0000', '#00ff00', '#ffff00', '#000000', '#ffffff', '#808080', '#7c3aed', '#0b7285']) {
    lights.push([accent, { ...GOOD().light, accent, focus: accent }]);
  }
  for (const [label, light] of lights) {
    const dark = darkFromLight(light);
    assert.deepEqual(Object.keys(dark), COLOR_KEYS);
    const t = { ...GOOD(), light, dark };
    // the light side of the odd accents may itself fail; only judge the dark side
    const r = validateTokens(t);
    const darkErrors = r.issues.filter((i) => i.level === 'error' && i.theme === 'dark');
    assert.deepEqual(darkErrors, [], `${label}: ${darkErrors.map((e) => e.message).join('|')}`);
    // dark page is dark, text is light
    assert.ok(hexToHsl(dark.background).l < 0.12, label);
    assert.ok(hexToHsl(dark.foreground).l > 0.85, label);
    assert.ok(contrast(dark.accent, dark.background) >= 3, label);
  }
  const fullPreset = await preset('warm-friendly');
  const r = validateTokens({ ...fullPreset, dark: darkFromLight(fullPreset) });
  assert.equal(r.ok, true);
  assert.throws(() => darkFromLight({ accent: 'blue' }), /hex accent/);
});

test('fonts.json comes from Next and the language map picks letter sets', () => {
  assert.equal(allowedFontNames()[0], 'system');
  for (const name of ['Inter', 'DM Sans', 'Manrope', 'Nunito', 'Space Grotesk', 'IBM Plex Sans', 'Source Sans 3', 'Work Sans', 'Noto Sans', 'Fraunces', 'Source Serif 4', 'Lora']) {
    const f = getFont(name);
    assert.ok(f, name);
    assert.match(f.importName, /^[A-Z][A-Za-z0-9_]+$/);
    assert.ok(f.subsets.includes('latin'));
    assert.ok(['sans', 'serif'].includes(f.category));
  }
  assert.equal(getFont('DM Sans').importName, 'DM_Sans');
  assert.equal(getFont('Source Serif 4').importName, 'Source_Serif_4');
  assert.deepEqual(subsetsForLanguages(['en']), ['latin']);
  assert.deepEqual(subsetsForLanguages(), ['latin']);
  assert.deepEqual(subsetsForLanguages(['en', 'de']), ['latin', 'latin-ext']);
  assert.deepEqual(subsetsForLanguages(['el']), ['latin', 'greek']);
  assert.deepEqual(subsetsForLanguages(['ru', 'uk']).sort(), ['cyrillic', 'latin']);
  assert.deepEqual(subsetsForLanguages(['vi']).sort(), ['latin', 'latin-ext', 'vietnamese']);
});

test('renderFontsTs: default, one font, two fonts, languages', () => {
  const header = '// Generated by Shipyard design. Edit with /shipyard:design, not by hand.';
  assert.equal(renderFontsTs({ body: 'system', heading: 'same' }), `${header}\nexport const fontClassName = "";\n`);
  const one = renderFontsTs({ body: 'DM Sans', heading: 'same' });
  assert.match(one, /import \{ DM_Sans \} from "next\/font\/google";/);
  assert.match(one, /const body = DM_Sans\(\{ subsets: \["latin"\], variable: "--font-body", display: "swap" \}\);/);
  assert.ok(!one.includes('heading'));
  assert.match(one, /export const fontClassName = \[body\.variable\]\.filter\(Boolean\)\.join\(" "\);/);
  const two = renderFontsTs({ body: 'Source Sans 3', heading: 'Fraunces' });
  assert.match(two, /import \{ Fraunces, Source_Sans_3 \} from "next\/font\/google";/);
  assert.match(two, /const heading = Fraunces\(.*"--font-heading"/);
  assert.match(two, /\[body\.variable, heading\.variable\]/);
  const sameName = renderFontsTs({ body: 'Inter', heading: 'Inter' });
  assert.ok(!sameName.includes('heading'));
  const headingOnly = renderFontsTs({ body: 'system', heading: 'Lora' });
  assert.ok(!headingOnly.includes('const body'));
  assert.match(headingOnly, /\[heading\.variable\]/);
  const greek = renderFontsTs({ body: 'Inter', languages: ['en', 'el'] });
  assert.match(greek, /subsets: \["latin", "greek"\]/);
  // a font without Greek still loads (latin only) instead of breaking the build
  assert.match(renderFontsTs({ body: 'DM Sans', languages: ['el'] }), /subsets: \["latin"\]/);
  assert.match(renderFontsTs({ body: 'Inter', languages: ['pl'] }), /subsets: \["latin", "latin-ext"\]/);
});

test('googleFontsCssUrl names only real fonts and is one address', () => {
  const url = googleFontsCssUrl(['DM Sans', 'Fraunces', 'DM Sans', 'system', 'Nope']);
  assert.match(url, /^https:\/\/fonts\.googleapis\.com\/css2\?/);
  assert.match(url, /family=DM\+Sans:wght@400\.\.700/);
  assert.match(url, /family=Fraunces/);
  assert.ok(!url.includes('Nope'));
  assert.equal(googleFontsCssUrl(['system']), null);
});
