import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTokens, autoFix } from '../scripts/design/validate.mjs';
import {
  normalizeTokens, withDefaults, deriveShape, shapeNumbers, shapeLines, renderThemeTs, lookDims, sharedDims, summarize,
  DEFAULT_TYPE, DEFAULT_LAYOUT, ENUMS, resolveHeadingWeight,
} from '../scripts/design/tokens.mjs';
import { renderFontsTs, nearestHeadingWeight, staticWeights, googleFontCssUrl, googleFontsCssUrl, getFont } from '../scripts/design/fonts.mjs';
import { toPreview, previewJson } from '../scripts/design/preview.mjs';
import { renderDesignMd } from '../scripts/design/design-md.mjs';
import { withLayout, readLayout, LAYOUTS } from '../scripts/design/layout-file.mjs';
import { darkFromLight } from '../scripts/design/dark-from-light.mjs';
import { listPresets } from '../scripts/design/presets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = (v) => JSON.parse(JSON.stringify(v));
const presets = await listPresets();
const byId = Object.fromEntries(presets.map((p) => [p.id, p]));
const GOOD = () => clone(byId['calm-blue']);

test('schema: files without type/layout stay valid and get the template defaults', () => {
  const t = GOOD();
  delete t.type;
  delete t.layout;
  assert.equal(validateTokens(t).ok, true);
  assert.deepEqual(withDefaults(t).type, DEFAULT_TYPE);
  assert.deepEqual(withDefaults(t).layout, DEFAULT_LAYOUT);
  const n = normalizeTokens(t);
  assert.deepEqual(n.type, DEFAULT_TYPE);
  assert.deepEqual(n.layout, DEFAULT_LAYOUT);
  // partial blocks keep what was given and fill the rest; unknown keys are dropped
  const partial = normalizeTokens({ ...t, layout: { nav: 'sidebar', sparkle: true }, type: { scale: 'large' } });
  assert.deepEqual(partial.layout, { ...DEFAULT_LAYOUT, nav: 'sidebar' });
  assert.deepEqual(partial.type, { ...DEFAULT_TYPE, scale: 'large' });
  // validateTokens fills in defaults itself, so a raw partial block is fine too
  assert.equal(validateTokens({ ...t, layout: { nav: 'top-nav' } }).ok, true);
});

test('schema: every enum rejects a bad value and accepts each allowed one', () => {
  for (const [field, allowed] of Object.entries(ENUMS)) {
    const [group, key] = field.split('.');
    for (const value of allowed) {
      const t = GOOD();
      t[group][key] = value;
      // 800 is not in every font; that is a warning, never an error
      assert.equal(validateTokens(t).ok, true, `${field}=${value}`);
    }
    for (const bad of ['nope', 42, null, '', 650]) {
      if (allowed.includes(bad)) continue;
      const t = GOOD();
      t[group][key] = bad;
      const r = validateTokens(t);
      // null falls back to the default in the loader's eyes only for missing keys; a present null is an error
      assert.equal(r.ok, false, `${field}=${JSON.stringify(bad)}`);
      assert.ok(r.errors.some((e) => e.includes(`"${field}"`)), r.errors.join('|'));
    }
  }
  const notObject = GOOD();
  notObject.type = 'big';
  assert.match(validateTokens(notObject).errors.join(' '), /"type"/);
  const list = GOOD();
  list.layout = ['sidebar'];
  assert.match(validateTokens(list).errors.join(' '), /"layout"/);
});

test('validation: odd combinations and weights the font lacks are warnings, not errors', () => {
  const odd = GOOD();
  odd.layout.home = 'editorial';
  odd.layout.nav = 'sidebar';
  const r = validateTokens(odd);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /editorial homepage with a left sidebar/.test(w)));
  const weight = GOOD();
  weight.font = { body: 'Inter', heading: 'Space Grotesk' };
  weight.type.headingWeight = 800;
  const w = validateTokens(weight);
  assert.equal(w.ok, true);
  assert.ok(w.warnings.some((m) => /Space Grotesk has no weight 800, so 700 will be used/.test(m)), w.warnings.join('|'));
  const flat = GOOD();
  flat.shadow = 'none';
  flat.layout.cards = 'elevated';
  assert.ok(validateTokens(flat).warnings.some((m) => /will look flat/.test(m)));
  // autoFix keeps type and layout as they were
  const fixed = autoFix({ ...weight, light: { ...weight.light, muted: '#c0c0c0' } });
  assert.deepEqual(fixed.tokens.layout, weight.layout);
  assert.deepEqual(fixed.tokens.type, weight.type);
});

test('deriveShape: type scale, spacing, width and tracking follow the spec', () => {
  const shape = (type, layout) => deriveShape({ type, layout, font: { body: 'system', heading: 'same' } });
  const comfy = shape({ scale: 'comfortable', headingWeight: 700, headingTracking: 'normal' }, { density: 'regular', maxWidth: 'medium' });
  assert.deepEqual(Object.keys(comfy), ['--font-size-base', '--h1-size', '--h2-size', '--h3-size', '--heading-weight', '--heading-tracking', '--space', '--pad-card', '--gap', '--content-max']);
  assert.deepEqual(comfy, {
    '--font-size-base': '16px', '--h1-size': 'clamp(25px, 6vw, 31.5px)', '--h2-size': '25px', '--h3-size': '20px',
    '--heading-weight': '700', '--heading-tracking': '0em', '--space': '6px', '--pad-card': '16px', '--gap': '12px', '--content-max': '960px',
  });
  const compact = shape({ scale: 'compact', headingWeight: 600, headingTracking: 'tight' }, { density: 'compact', maxWidth: 'narrow' });
  assert.equal(compact['--font-size-base'], '15px');
  assert.equal(compact['--h3-size'], '18px');
  assert.equal(compact['--h2-size'], '21.5px');
  assert.equal(compact['--h1-size'], 'clamp(21.5px, 6vw, 26px)');
  assert.deepEqual([compact['--space'], compact['--pad-card'], compact['--gap'], compact['--content-max'], compact['--heading-tracking']], ['4px', '12px', '8px', '640px', '-0.02em']);
  const large = shape({ scale: 'large', headingWeight: 800, headingTracking: 'wide' }, { density: 'airy', maxWidth: 'wide' });
  assert.equal(large['--font-size-base'], '17px');
  assert.equal(large['--h3-size'], '22.5px');
  assert.equal(large['--h2-size'], '30px');
  assert.equal(large['--h1-size'], 'clamp(30px, 6vw, 40.5px)');
  assert.deepEqual([large['--space'], large['--pad-card'], large['--gap'], large['--content-max'], large['--heading-tracking']], ['8px', '24px', '20px', '1200px', '0.01em']);
  // every size is a multiple of half a pixel
  for (const v of [comfy, compact, large]) for (const k of ['--h2-size', '--h3-size']) assert.equal((Number.parseFloat(v[k]) * 2) % 1, 0);
  // defaults when nothing is given, and the lines written between the markers
  assert.deepEqual(deriveShape({ font: { body: 'system', heading: 'same' } }), comfy);
  assert.deepEqual(shapeLines(byId['calm-blue'])[0], '  --font-size-base: 16px;');
  assert.equal(shapeLines(byId['calm-blue']).length, 10);
  const n = shapeNumbers(byId.playful);
  assert.deepEqual([n.base, n.h1, n.weight, n.space], [17, 40.5, 700, 6]);
  assert.equal(n.h1Phone, 30);
});

test('heading weight: the nearest weight the font has is used', () => {
  assert.deepEqual(nearestHeadingWeight('Space Grotesk', 800), { weight: 700, requested: 800, adjusted: true });
  assert.deepEqual(nearestHeadingWeight('Lora', 800), { weight: 700, requested: 800, adjusted: true });
  assert.deepEqual(nearestHeadingWeight('Inter', 800), { weight: 800, requested: 800, adjusted: false });
  assert.equal(nearestHeadingWeight('system', 500).weight, 500);
  const t = { ...byId.playful, type: { ...byId.playful.type, headingWeight: 800 } };
  assert.equal(resolveHeadingWeight(t).weight, 700);
  assert.equal(deriveShape(t)['--heading-weight'], '700');
});

test('fonts.ts: fixed-weight fonts also load the heading weight; variable fonts need no list', () => {
  const fake = { weights: [400, 500, 700, 900] };
  assert.deepEqual(staticWeights(fake), [400, 500, 700]);
  assert.deepEqual(staticWeights(fake, [900]), [400, 500, 700, 900]);
  assert.ok(!renderFontsTs({ body: 'Inter', heading: 'same', headingWeight: 800 }).includes('weight:'));
  assert.match(renderFontsTs({ body: 'Source Sans 3', heading: 'Fraunces', headingWeight: 600 }), /export const fontClassName/);
});

test('google font addresses: the heading weight widens the range, the device font loads nothing', () => {
  assert.equal(googleFontCssUrl('system'), null);
  assert.equal(googleFontCssUrl('Fraunces', { headingWeight: 800 }), 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..800&display=swap');
  assert.equal(googleFontCssUrl('Space Grotesk', { headingWeight: 800 }), 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400..700&display=swap');
  assert.match(googleFontsCssUrl(['Inter'], { maxWeight: 800 }), /Inter:wght@400\.\.800/);
  assert.match(googleFontsCssUrl(['Inter']), /Inter:wght@400\.\.700/);
  assert.ok(getFont('Lora'));
});

test('toPreview: the shape the app preview page reads', () => {
  const p = toPreview(byId.editorial);
  assert.deepEqual(Object.keys(p), ['id', 'name', 'defaultTheme', 'theme', 'shape', 'look', 'home', 'layout', 'fonts']);
  assert.equal(p.id, 'editorial');
  assert.equal(p.layout, 'top-nav');
  assert.equal(p.home, 'editorial');
  assert.deepEqual(p.look, { density: 'airy', cards: 'flat', buttons: 'outline', header: 'plain' });
  assert.deepEqual(p.shape, deriveShape(byId.editorial));
  for (const theme of ['light', 'dark']) {
    const vars = p.theme[theme];
    for (const name of ['--background', '--foreground', '--card', '--muted', '--line', '--line-strong', '--accent', '--accent-contrast', '--focus', '--danger', '--danger-contrast', '--radius', '--radius-sm', '--shadow', '--accent-soft']) {
      assert.ok(name in vars, `${theme} ${name}`);
    }
    assert.match(vars['--accent-soft'], /^color-mix\(in srgb, #[0-9a-f]{6} (?:9|7)%, #[0-9a-f]{6}\)$/, 'a plain value, not var()');
    assert.match(vars['--accent-soft'], theme === 'dark' ? / 7%, / : / 9%, /, 'dark mode tints less');
    assert.ok(!Object.values(vars).some((v) => v.includes('var(--accent') || v.includes('var(--card')));
  }
  assert.equal(p.theme.light['--accent'], byId.editorial.light.accent);
  assert.equal(p.theme.dark['--accent'], byId.editorial.dark.accent);
  assert.equal(p.theme.light['--radius'], '4px');
  assert.equal(p.theme.light['--shadow'], 'none');
  assert.match(p.fonts.heading.family, /^"Fraunces", ui-serif/);
  assert.match(p.fonts.body.family, /^"Source Sans 3"/);
  assert.equal(p.fonts.heading.cssUrl, 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap');
  assert.match(p.fonts.body.cssUrl, /^https:\/\/fonts\.googleapis\.com\/css2\?family=Source\+Sans\+3:wght@/);
  // device font: no address; same heading font: one address for both
  const sys = toPreview(byId['calm-blue']);
  assert.equal(sys.fonts.body.cssUrl, null);
  assert.equal(sys.fonts.heading.cssUrl, null);
  assert.match(sys.fonts.body.family, /^ui-sans-serif/);
  const one = toPreview(byId['fresh-green']);
  assert.deepEqual(one.fonts.heading, one.fonts.body);
  assert.match(one.fonts.body.cssUrl, /Manrope:wght@400\.\.800/, 'heading weight 800 is loaded for the shared font');
  assert.equal(toPreview(byId['night-tech']).defaultTheme, 'dark');
  // JSON round trip, and a token file without type/layout still previews
  assert.deepEqual(JSON.parse(previewJson(byId.playful)), toPreview(byId.playful));
  const bare = clone(byId['clean-mono']);
  delete bare.type;
  delete bare.layout;
  assert.equal(toPreview(bare).layout, 'bottom-nav');
});

test('LAYOUT line: the three layouts, the old two-layout cast, annotations', () => {
  assert.deepEqual(LAYOUTS, ['bottom-nav', 'sidebar', 'top-nav']);
  const old = 'a\nexport const LAYOUT = "bottom-nav" as "bottom-nav" | "sidebar";\nb\n';
  assert.equal(withLayout(old, 'top-nav'), 'a\nexport const LAYOUT = "top-nav" as "bottom-nav" | "sidebar" | "top-nav";\nb\n');
  assert.equal(readLayout(old), 'bottom-nav');
  assert.equal(readLayout('nothing'), null);
  assert.equal(withLayout('export const LAYOUT = "top-nav" as X;', 'sidebar'), 'export const LAYOUT = "sidebar" as "bottom-nav" | "sidebar" | "top-nav";');
  assert.equal(withLayout(old, 'floating'), null);
});

test('theme.ts has LOOK and HOME_STYLE for every preset', () => {
  for (const t of presets) {
    const text = renderThemeTs(t);
    assert.match(text, /^\/\/ Generated by Shipyard design\. Edit with \/shipyard:design, not by hand\./);
    assert.match(text, new RegExp(`LOOK = \\{ density: "${t.layout.density}", cards: "${t.layout.cards}", buttons: "${t.layout.buttons}", header: "${t.layout.header}" \\} as const;`));
    assert.match(text, new RegExp(`HOME_STYLE: "focus" \\| "split" \\| "editorial" \\| "cards" \\| "list" = "${t.layout.home}";`));
  }
});

test('DESIGN.md Layout section is plain words and mentions every choice', () => {
  const md = renderDesignMd(byId['clean-mono'], { appName: 'X' });
  assert.match(md, /## Layout/);
  for (const w of ['a menu on the left', 'a grid of cards', 'no outline and no shadow', 'square corners and small capital letters', 'no bar behind it', 'compact', 'Page width: wide, up to 1200px', 'body 15px']) {
    assert.ok(md.includes(w), w);
  }
  assert.ok(!md.includes('—'));
});

test('the 8 ready-made looks: valid, no warnings, both themes, all new fields set', async () => {
  const files = (await readdir(path.join(root, 'presets'))).filter((f) => f.endsWith('.tokens.json'));
  assert.equal(files.length, 8);
  for (const t of presets) {
    const r = validateTokens(t, { languages: ['en'] });
    assert.deepEqual(r.errors, [], t.id);
    assert.deepEqual(r.warnings, [], t.id);
    for (const [group, key] of Object.keys(ENUMS).map((f) => f.split('.'))) assert.ok(ENUMS[`${group}.${key}`].includes(t[group][key]), `${t.id} ${group}.${key}`);
    assert.ok(t.description.length > 20 && !t.description.includes('—'));
    assert.equal(summarize(t).includes('undefined'), false);
  }
});

test('the 8 looks really differ: any two share at most 4 of the 7 layout/type dimensions', () => {
  assert.equal(presets.length, 8);
  for (let i = 0; i < presets.length; i++) {
    for (let j = i + 1; j < presets.length; j++) {
      const shared = sharedDims(presets[i], presets[j]);
      assert.ok(shared.length <= 4, `${presets[i].id} and ${presets[j].id} share ${shared.length}: ${shared.join(', ')}`);
    }
  }
  assert.deepEqual(Object.keys(lookDims(presets[0])), ['nav', 'home', 'cards', 'buttons', 'density', 'scale', 'font']);
  // all three menus, all five homepages, all four card styles and all four button styles are in use
  for (const [key, values] of [['nav', 3], ['home', 5], ['cards', 4], ['buttons', 4]]) {
    assert.equal(new Set(presets.map((p) => lookDims(p)[key])).size, values, key);
  }
});

test('v0.3 spec fixes: calm-blue is the template default; night-tech is dark; editorial is narrow', () => {
  assert.deepEqual(lookDims(byId['calm-blue']), { nav: 'bottom-nav', home: 'focus', cards: 'bordered', buttons: 'solid', density: 'regular', scale: 'comfortable', font: 'system/system' });
  assert.equal(byId['night-tech'].defaultTheme, 'dark');
  assert.equal(byId.editorial.layout.maxWidth, 'narrow');
  assert.equal(byId['clean-mono'].layout.header, 'plain');
  assert.equal(byId['warm-friendly'].layout.header, 'centered');
  assert.equal(byId['soft-pastel'].layout.header, 'centered');
  assert.equal(byId.playful.font.heading, 'Space Grotesk');
  assert.ok(byId.playful.type.headingWeight >= 700);
});

test('darkFromLight still passes for the reworked presets (type/layout do not affect colour rules)', () => {
  for (const t of presets) {
    const r = validateTokens({ ...t, dark: darkFromLight(t) });
    assert.deepEqual(r.issues.filter((i) => i.level === 'error' && i.theme === 'dark'), [], t.id);
  }
});
