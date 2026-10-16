import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-design-apply-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts', 'apply-design.mjs');
const LAYOUT_SCRIPT = path.join(root, 'scripts', 'set-layout.mjs');

const { applyDesign } = await import('../scripts/apply-design.mjs');
const { loadProfile, saveProfile, defaultProfile, upsertApp } = await import('../scripts/lib/profile.mjs');
const { replaceMarkerBlock, readMarkerBlock } = await import('../scripts/design/write-files.mjs');
const { renderDesignMd } = await import('../scripts/design/design-md.mjs');
const { loadPreset, listPresetIds } = await import('../scripts/design/presets.mjs');
const { setLayout, withLayout } = await import('../scripts/set-layout.mjs');
const { deriveShape, shapeLines, renderThemeTs } = await import('../scripts/design/tokens.mjs');

let counter = 0;
const read = (...p) => readFile(path.join(...p), 'utf8');
const readJson = async (...p) => JSON.parse(await read(...p));

/**
 * template-v3 is built in parallel. If this copy of the template still lacks a v0.3 piece (shape markers,
 * LOOK/HOME_STYLE in theme.ts, the three-layout LAYOUT line, the Layout section of DESIGN.md), add it here,
 * in the temp copy only, from the calm-blue defaults. A finished v3 template passes through untouched.
 */
async function upgradeCopy(dir, { name, layout }) {
  const { tokens } = await loadPreset('calm-blue');
  const file = (rel) => path.join(dir, rel);
  let css = await readFile(file('src/app/globals.css'), 'utf8');
  if (!css.includes('shipyard:tokens:shape:start')) {
    const block = ['  /* shipyard:tokens:shape:start */', ...shapeLines(tokens), '  /* shipyard:tokens:shape:end */'].join('\n');
    css = css.replace(/(  --heading-font:[^\n]*\n)/, `$1\n${block}\n`);
    await writeFile(file('src/app/globals.css'), css);
  }
  if (!(await readFile(file('src/lib/theme.ts'), 'utf8')).includes('LOOK')) await writeFile(file('src/lib/theme.ts'), renderThemeTs(tokens));
  const constants = await readFile(file('src/lib/constants.ts'), 'utf8');
  const fixed = withLayout(constants, layout);
  if (fixed !== null && fixed !== constants) await writeFile(file('src/lib/constants.ts'), fixed);
  if (!(await readFile(file('DESIGN.md'), 'utf8')).includes('## Layout')) {
    await writeFile(file('DESIGN.md'), renderDesignMd(tokens, { appName: name, source: 'preset', date: null }));
  }
}

/** A copy of the real template with the placeholders filled in by hand (no scaffold, no git). */
async function makeApp({ slug = 'demo-app', name = 'Demo App', layout = 'bottom-nav' } = {}) {
  const dir = path.join(tmp, `app-${++counter}`);
  await cp(path.join(root, 'template'), dir, {
    recursive: true,
    filter: (src) => !/node_modules|[\\/]\.next($|[\\/])/.test(src),
  });
  async function fill(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await fill(full);
      else if (/\.(ts|tsx|json|md|css|mjs|webmanifest|svg|yml|example)$/.test(e.name) || e.name.startsWith('.env')) {
        const text = await readFile(full, 'utf8');
        if (text.includes('<APP_')) {
          await writeFile(full, text.replaceAll('<APP_SLUG>', slug).replaceAll('<APP_NAME>', name).replaceAll('<APP_SHORT_NAME>', name)
            .replaceAll('<APP_DESCRIPTION>', 'A test app').replaceAll('<APP_TAGLINE>', 'A test app').replaceAll('<APP_LAYOUT>', layout));
        }
      }
    }
  }
  await fill(dir);
  await upgradeCopy(dir, { name, layout });
  await writeFile(path.join(dir, '.shipyard-app.json'), `${JSON.stringify({ slug, name, layout, modules: [], createdAt: '2026-01-01T00:00:00.000Z', pluginVersion: '0.1.0' }, null, 2)}\n`);
  return dir;
}

const snapshot = async (dir) => {
  const out = {};
  for (const rel of ['src/app/globals.css', 'src/lib/theme.ts', 'src/lib/fonts.ts', 'public/manifest.webmanifest', 'DESIGN.md', '.shipyard-app.json']) out[rel] = await read(dir, rel);
  return out;
};

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, SHIPYARD_HOME: process.env.SHIPYARD_HOME, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

before(async () => {
  await saveProfile(defaultProfile());
});
after(() => rm(tmp, { recursive: true, force: true }));

test('the template ships calm-blue exactly: applying it again changes nothing but the date', async () => {
  const dir = await makeApp();
  const before = await snapshot(dir);
  const r = await applyDesign({ appDir: dir, preset: 'calm-blue', icons: false });
  assert.equal(r.ok, true);
  const changed = r.files.filter((f) => f.status !== 'unchanged').map((f) => f.file);
  assert.deepEqual(changed, ['DESIGN.md'], `unexpected diffs: ${changed}`);
  const after = await snapshot(dir);
  assert.equal(after['src/app/globals.css'], before['src/app/globals.css']);
  assert.equal(after['src/lib/theme.ts'], before['src/lib/theme.ts']);
  assert.equal(after['src/lib/fonts.ts'], before['src/lib/fonts.ts']);
  assert.equal(after['public/manifest.webmanifest'], before['public/manifest.webmanifest']);
  assert.equal(after['DESIGN.md'].replace(/ Applied \d{4}-\d{2}-\d{2}\./, ''), before['DESIGN.md']);
});

test('applying a preset rewrites the marker blocks, theme, fonts, manifest, DESIGN.md and config', async () => {
  const dir = await makeApp({ name: 'Recipe Box' });
  const before = await snapshot(dir);
  const r = await applyDesign({ appDir: dir, preset: 'editorial', icons: false });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'editorial');
  assert.equal(r.icons, 'skipped');

  const css = await read(dir, 'src/app/globals.css');
  assert.match(css, /--accent: #1d3f72;/);
  assert.match(css, /--radius: 4px;/);
  assert.match(css, /--shadow: none;/);
  assert.match(css, /--accent: #8fb2e8;/, 'dark block');
  // everything outside the markers is untouched
  const strip = (text) => text.replace(/(\/\* shipyard:tokens:(light|dark|shape):start \*\/)[\s\S]*?(\/\* shipyard:tokens:\2:end \*\/)/g, '$1$3');
  assert.equal(strip(css), strip(before['src/app/globals.css']));
  assert.ok(css.includes('--accent-soft: color-mix'), 'derived colour stays outside the markers');
  // markers hold only the 11 colours (+ radius and shadow in light)
  const light = readMarkerBlock(css, 'light');
  assert.equal(Object.keys(light).length, 14);
  assert.equal(Object.keys(readMarkerBlock(css, 'dark')).length, 12);
  assert.ok(!('--radius' in readMarkerBlock(css, 'dark')));

  assert.match(await read(dir, 'src/lib/theme.ts'), /DEFAULT_THEME: "light" \| "dark" = "light";/);
  assert.match(await read(dir, 'src/lib/theme.ts'), /light: "#faf7f0", dark: "#151310"/);
  const fonts = await read(dir, 'src/lib/fonts.ts');
  assert.match(fonts, /^\/\/ Generated by Shipyard design\. Edit with \/shipyard:design, not by hand\./);
  assert.match(fonts, /Fraunces/);
  const manifest = await readJson(dir, 'public/manifest.webmanifest');
  assert.equal(manifest.theme_color, '#faf7f0');
  assert.equal(manifest.background_color, '#faf7f0');
  assert.equal(manifest.icons.length, 3, 'rest of the manifest kept');
  const md = await read(dir, 'DESIGN.md');
  assert.match(md, /^# Recipe Box design/);
  assert.match(md, /Editorial\./);
  assert.match(md, /`#1d3f72`/);
  assert.match(md, /Fraunces/);
  const config = await readJson(dir, '.shipyard-app.json');
  assert.equal(config.design.id, 'editorial');
  assert.equal(config.design.source, 'preset');
  assert.equal(config.design.name, 'Editorial');
  assert.match(config.design.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(config.slug, 'demo-app', 'other config kept');
  assert.equal((await readJson(dir, '.shipyard', 'design', 'applied.tokens.json')).id, 'editorial');
});

test('a dark-by-default look writes dark theme defaults and manifest colours', async () => {
  const dir = await makeApp();
  await applyDesign({ appDir: dir, preset: 'night-tech', icons: false });
  assert.match(await read(dir, 'src/lib/theme.ts'), /= "dark";/);
  assert.equal((await readJson(dir, 'public/manifest.webmanifest')).theme_color, '#090d12');
  assert.match(await read(dir, 'DESIGN.md'), /Dark is the default; light switches on/);
});

test('second run is idempotent (every file unchanged, same bytes apart from the time)', async () => {
  const dir = await makeApp();
  await applyDesign({ appDir: dir, preset: 'warm-friendly', icons: false, now: new Date('2026-03-01T10:00:00Z') });
  const first = await snapshot(dir);
  const r = await applyDesign({ appDir: dir, preset: 'warm-friendly', icons: false, now: new Date('2026-03-01T11:00:00Z') });
  assert.ok(r.files.every((f) => f.status === 'unchanged'), JSON.stringify(r.files));
  const second = await snapshot(dir);
  for (const k of Object.keys(first)) {
    if (k === '.shipyard-app.json') continue;
    assert.equal(second[k], first[k], k);
  }
  assert.equal((await readJson(dir, '.shipyard-app.json')).design.appliedAt, '2026-03-01T11:00:00.000Z');
});

test('every preset applies cleanly, and switching looks never leaves old values behind', async () => {
  const dir = await makeApp();
  for (const id of await listPresetIds()) {
    const r = await applyDesign({ appDir: dir, preset: id, icons: false });
    assert.equal(r.ok, true, id);
    assert.deepEqual(r.warnings, [], id);
    const { tokens } = await loadPreset(id);
    const css = await read(dir, 'src/app/globals.css');
    assert.equal(readMarkerBlock(css, 'light')['--accent'], tokens.light.accent);
    assert.equal(readMarkerBlock(css, 'dark')['--accent'], tokens.dark.accent);
  }
  const css = await read(dir, 'src/app/globals.css');
  assert.equal(css.split('shipyard:tokens:light:start').length, 2, 'markers not duplicated');
});

test('refuses with a clear message when the markers are missing, and writes nothing', async () => {
  const dir = await makeApp();
  const css = (await read(dir, 'src/app/globals.css')).replace('/* shipyard:tokens:dark:end */', '');
  await writeFile(path.join(dir, 'src/app/globals.css'), css);
  const before = await snapshot(dir);
  await assert.rejects(applyDesign({ appDir: dir, preset: 'playful', icons: false }), /shipyard:tokens:dark:end/);
  assert.deepEqual(await snapshot(dir), before);
  const c = cli([dir, '--preset', 'playful', '--no-icons']);
  assert.equal(c.code, 1);
  assert.match(c.out, /marker/);
  assert.throws(() => replaceMarkerBlock('a {}', 'light', ['  --x: 1;']), /shipyard:tokens:light:start/);
  const twice = '/* shipyard:tokens:light:start */\n/* shipyard:tokens:light:end */\n/* shipyard:tokens:light:start */\n/* shipyard:tokens:light:end */';
  assert.throws(() => replaceMarkerBlock(twice, 'light', []), /exactly one/);
});

test('replaceMarkerBlock keeps indentation and Windows line endings', () => {
  const css = ':root {\r\n  /* shipyard:tokens:light:start */\r\n  --old: 1;\r\n  /* shipyard:tokens:light:end */\r\n}\r\n';
  const out = replaceMarkerBlock(css, 'light', ['  --a: #fff;', '  --b: 2px;']);
  assert.equal(out, ':root {\r\n  /* shipyard:tokens:light:start */\r\n  --a: #fff;\r\n  --b: 2px;\r\n  /* shipyard:tokens:light:end */\r\n}\r\n');
});

test('path traversal and odd names in --preset are rejected', async () => {
  const dir = await makeApp();
  const before = await snapshot(dir);
  for (const bad of ['../../etc/passwd', '..', '../presets/calm-blue', 'calm-blue/../clean-mono', '/etc/passwd', 'C:\\x', 'calm blue', 'CALM-BLUE', '', 'a'.repeat(80), 'calm-blue\0x']) {
    await assert.rejects(applyDesign({ appDir: dir, preset: bad || '.', icons: false }), /not a look name|no look called/, JSON.stringify(bad));
  }
  const c = cli([dir, '--preset', '../../etc/passwd', '--no-icons']);
  assert.equal(c.code, 1);
  assert.match(c.out, /not a look name/);
  assert.deepEqual(await snapshot(dir), before);
  await assert.rejects(applyDesign({ appDir: dir, preset: 'no-such-look', icons: false }), /no look called "no-such-look"\. Available: calm-blue/);
});

async function brokenTokens(dir) {
  const { tokens } = await loadPreset('clean-mono');
  const t = JSON.parse(JSON.stringify(tokens));
  t.id = 'from-shot';
  t.name = 'From a screenshot';
  t.light.muted = '#b4b4bb';
  t.dark.lineStrong = '#16161a';
  const file = path.join(dir, 'draft.tokens.json');
  await writeFile(file, JSON.stringify(t));
  return file;
}

test('errors block apply; --fix repairs readability and says what it changed', async () => {
  const dir = await makeApp();
  const file = await brokenTokens(dir);
  const before = await snapshot(dir);
  const blocked = await applyDesign({ appDir: dir, tokensFile: file, source: 'screenshot', icons: false });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /grey text/);
  assert.match(blocked.error, /--fix/);
  assert.deepEqual(await snapshot(dir), before);

  const c1 = cli([dir, '--tokens', file, '--source', 'screenshot', '--no-icons']);
  assert.equal(c1.code, 1);
  assert.match(c1.out, /✗/);

  const fixed = await applyDesign({ appDir: dir, tokensFile: file, source: 'screenshot', fix: true, icons: false });
  assert.equal(fixed.ok, true);
  assert.ok(fixed.fixed.some((m) => /grey text/.test(m)), fixed.fixed.join('|'));
  const config = await readJson(dir, '.shipyard-app.json');
  assert.equal(config.design.source, 'screenshot');
  assert.equal(config.design.id, 'from-shot');
  assert.match(await read(dir, 'DESIGN.md'), /screenshots the owner chose/);
  assert.match(await read(dir, 'DESIGN.md'), /never logos, images or text/);

  const c2 = cli([dir, '--tokens', file, '--source', 'screenshot', '--fix', '--no-icons']);
  assert.equal(c2.code, 0);
  assert.match(c2.out, /Fixed: made the grey text/);
});

test('unfixable problems still fail with --fix (unknown font)', async () => {
  const dir = await makeApp();
  const { tokens } = await loadPreset('calm-blue');
  const file = path.join(dir, 'bad-font.tokens.json');
  await writeFile(file, JSON.stringify({ ...tokens, id: 'bad-font', font: { body: 'Comic Sans MS', heading: 'same' } }));
  const r = await applyDesign({ appDir: dir, tokensFile: file, fix: true, icons: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /Comic Sans MS/);
});

test('a screenshot look cannot take over the id of a ready-made look', async () => {
  const dir = await makeApp();
  const { tokens } = await loadPreset('playful');
  const file = path.join(dir, 'x.tokens.json');
  await writeFile(file, JSON.stringify({ ...tokens, name: 'My own thing', light: { ...tokens.light, accent: '#0f766e', accentContrast: '#ffffff', focus: '#0f766e' } }));
  const r = await applyDesign({ appDir: dir, tokensFile: file, source: 'url', icons: false });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'playful-custom');
  assert.ok(r.notes.some((n) => /playful-custom/.test(n)));
});

test('--dry-run changes nothing and says what would change', async () => {
  const dir = await makeApp();
  const before = await snapshot(dir);
  const r = await applyDesign({ appDir: dir, preset: 'fresh-green', dryRun: true, icons: false });
  assert.equal(r.dryRun, true);
  assert.equal(r.applied, false);
  assert.ok(r.files.find((f) => f.file === 'src/app/globals.css').status === 'changed');
  assert.ok(r.tokenChanges.light.some((c) => c.name === '--accent' && c.from === '#2563eb' && c.to === '#1b7a4b'));
  assert.deepEqual(await snapshot(dir), before);
  const c = cli([dir, '--preset', 'fresh-green', '--dry-run']);
  assert.equal(c.code, 0);
  assert.match(c.out, /Dry run/);
  assert.match(c.out, /light --accent: #2563eb -> #1b7a4b/);
  assert.deepEqual(await snapshot(dir), before);
});

test('languages: Greek app with DM Sans gets a warning and a latin+greek font list for Inter', async () => {
  const dir = await makeApp();
  const dm = await applyDesign({ appDir: dir, preset: 'warm-friendly', languages: 'en,el', icons: false });
  assert.ok(dm.warnings.some((w) => /no Greek letters/.test(w)));
  assert.match(await read(dir, 'src/lib/fonts.ts'), /subsets: \["latin"\]/);
  const inter = await applyDesign({ appDir: dir, preset: 'clean-mono', languages: 'el', icons: false });
  assert.deepEqual(inter.warnings, []);
  assert.match(await read(dir, 'src/lib/fonts.ts'), /subsets: \["latin", "greek"\]/);
  // languages also come from the profile
  const profile = await loadProfile();
  profile.owner.languages = ['ru'];
  await saveProfile(profile);
  const fromProfile = await applyDesign({ appDir: dir, preset: 'fresh-green', icons: false });
  assert.deepEqual(fromProfile.languages, ['ru']);
  profile.owner.languages = ['en'];
  await saveProfile(profile);
});

test('profile: app look is saved (with swatches) and --set-default stores the default look', async () => {
  const dir = await makeApp({ slug: 'profile-app' });
  await upsertApp({ slug: 'profile-app', name: 'Demo App', dir });
  await applyDesign({ appDir: dir, preset: 'playful', icons: false, setDefault: true });
  const p = await loadProfile();
  const app = p.apps.find((a) => a.slug === 'profile-app');
  assert.equal(app.design.id, 'playful');
  assert.equal(app.design.swatches.light.accent, '#e5570a');
  assert.equal(app.design.swatches.dark.accent, '#ff8a3d');
  assert.equal(p.defaults.design, 'playful');
  assert.equal(p.apps.length, 1, 'apps not in the profile are not added');
  // a built-in look is not copied to the saved looks folder
  await assert.rejects(stat(path.join(process.env.SHIPYARD_HOME, 'designs', 'playful.tokens.json')));
});

test('a custom look saved as default can be applied by name to the next app', async () => {
  const dir = await makeApp();
  const file = await brokenTokens(dir);
  await applyDesign({ appDir: dir, tokensFile: file, source: 'screenshot', fix: true, setDefault: true, icons: false });
  assert.equal((await loadProfile()).defaults.design, 'from-shot');
  const saved = await readJson(process.env.SHIPYARD_HOME, 'designs', 'from-shot.tokens.json');
  assert.equal(saved.id, 'from-shot');
  const next = await makeApp({ slug: 'next-app', name: 'Next App' });
  const r = await applyDesign({ appDir: next, preset: 'from-shot', icons: false });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'From a screenshot');
  assert.equal(r.source, 'preset');
});

test('cli: usage errors exit 2; json output; refuses a folder that is not an app', async () => {
  const dir = await makeApp();
  assert.equal(cli([]).code, 2);
  assert.equal(cli([dir]).code, 2);
  assert.equal(cli([dir, '--preset', 'calm-blue', '--tokens', 'x.json']).code, 2);
  assert.equal(cli([dir, '--preset', 'calm-blue', '--source', 'telepathy']).code, 2);
  assert.equal(cli([dir, '--bogus']).code, 2);
  const help = cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--preset/);
  const j = cli([dir, '--preset', 'clean-mono', '--no-icons', '--json']);
  assert.equal(j.code, 0);
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, 'clean-mono');
  assert.ok(Array.isArray(parsed.files));
  const empty = await mkdtemp(path.join(tmp, 'empty-'));
  const c = cli([empty, '--preset', 'calm-blue', '--no-icons']);
  assert.equal(c.code, 1);
  assert.match(c.out, /not made by Shipyard/);
  const missing = cli([path.join(tmp, 'nope'), '--preset', 'calm-blue']);
  assert.equal(missing.code, 1);
  const badJson = path.join(dir, 'bad.json');
  await writeFile(badJson, '{ not json');
  const b = cli([dir, '--tokens', badJson]);
  assert.equal(b.code, 1);
  assert.match(b.out, /not valid JSON/);
});

test('icons: without the app\'s Playwright the result says they will update later', async () => {
  const dir = await makeApp();
  const r = await applyDesign({ appDir: dir, preset: 'calm-blue' });
  assert.equal(r.icons, 'later');
  const c = cli([dir, '--preset', 'calm-blue']);
  assert.match(c.out, /Icons will update after npm install/);
});

test('renderDesignMd has the required sections and no em dashes', async () => {
  for (const id of await listPresetIds()) {
    const { tokens } = await loadPreset(id);
    const md = renderDesignMd(tokens, { appName: 'X', source: 'preset', date: '2026-01-01' });
    for (const h of ['## Look', '## Colours', '## Type', '## Layout', '## Corners and depth', '## Rules', '## Source']) assert.ok(md.includes(h), `${id} ${h}`);
    assert.ok(!md.includes('\u2014'), id);
    assert.equal(md.split('\n').filter((l) => l.startsWith('| ') && l.includes('`--')).length, 11);
  }
  const { tokens } = await loadPreset('calm-blue');
  assert.match(renderDesignMd(tokens, { source: 'design-md' }), /awesome-design-md/);
});

test('set-layout: rewrites only the LAYOUT line, config and profile', async () => {
  const dir = await makeApp({ slug: 'layout-app', layout: 'bottom-nav' });
  await upsertApp({ slug: 'layout-app', name: 'Demo App', layout: 'bottom-nav' });
  const before = await read(dir, 'src/lib/constants.ts');
  const r = await setLayout(dir, 'sidebar');
  assert.deepEqual([r.ok, r.layout, r.previous, r.changed], [true, 'sidebar', 'bottom-nav', true]);
  const after = await read(dir, 'src/lib/constants.ts');
  assert.match(after, /^export const LAYOUT = "sidebar" as "bottom-nav" \| "sidebar" \| "top-nav";$/m);
  assert.equal(after.replace('"sidebar" as', '"bottom-nav" as'), before);
  assert.equal((await readJson(dir, '.shipyard-app.json')).layout, 'sidebar');
  assert.equal((await loadProfile()).apps.find((a) => a.slug === 'layout-app').layout, 'sidebar');
  const again = await setLayout(dir, 'sidebar');
  assert.equal(again.changed, false);
  await setLayout(dir, 'bottom-nav');
  assert.equal(await read(dir, 'src/lib/constants.ts'), before);
  await assert.rejects(setLayout(dir, 'tabs'), /"bottom-nav", "sidebar" or "top-nav"/);
  const top = await setLayout(dir, 'top-nav');
  assert.deepEqual([top.layout, top.previous], ['top-nav', 'bottom-nav']);
  assert.match(await read(dir, 'src/lib/constants.ts'), /^export const LAYOUT = "top-nav" as "bottom-nav" \| "sidebar" \| "top-nav";$/m);
  await setLayout(dir, 'bottom-nav');
});

test('set-layout: friendly errors and cli exit codes', async () => {
  const dir = await makeApp();
  await writeFile(path.join(dir, 'src/lib/constants.ts'), 'export const LAYOUT = pick();\n');
  await assert.rejects(setLayout(dir, 'sidebar'), /could not find the line "export const LAYOUT/);
  assert.equal(withLayout('nothing here', 'sidebar'), null);
  assert.equal(withLayout('export const LAYOUT = "sidebar"', 'bottom-nav'), 'export const LAYOUT = "bottom-nav" as "bottom-nav" | "sidebar" | "top-nav";');
  assert.equal(withLayout('export const LAYOUT: Layout = "sidebar";', 'top-nav'), 'export const LAYOUT: Layout = "top-nav";');
  assert.equal(withLayout('export const LAYOUT = "sidebar";', 'floating'), null);
  const run = (...a) => spawnSync(process.execPath, [LAYOUT_SCRIPT, ...a], { encoding: 'utf8', env: process.env });
  assert.equal(run().status, 2);
  assert.equal(run(dir).status, 2);
  assert.equal(run(dir, 'tabs').status, 2);
  assert.equal(run('--help').status, 0);
  const good = await makeApp();
  const ok = run(good, 'sidebar', '--json');
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).layout, 'sidebar');
  assert.equal(run(good, 'top-nav').status, 0);
  assert.equal(run(path.join(tmp, 'nope'), 'sidebar').status, 1);
});

// ---------------------------------------------------------------------------------------------
// v0.3: shape block, LOOK, HOME_STYLE, LAYOUT, Layout section

test('v0.3: a look writes the shape block, LOOK, HOME_STYLE, LAYOUT and the Layout section', async () => {
  const dir = await makeApp({ name: 'Recipe Box' });
  const r = await applyDesign({ appDir: dir, preset: 'warm-friendly', icons: false });
  assert.equal(r.ok, true);
  const { tokens } = await loadPreset('warm-friendly');
  const css = await read(dir, 'src/app/globals.css');
  const shape = readMarkerBlock(css, 'shape');
  assert.deepEqual(shape, deriveShape(tokens));
  assert.equal(shape['--font-size-base'], '17px');
  assert.equal(shape['--pad-card'], '24px');
  assert.equal(shape['--content-max'], '960px');
  assert.ok(css.indexOf('shipyard:tokens:shape:start') < css.indexOf('shipyard:tokens:light:start') || css.indexOf('shipyard:tokens:shape:start') > css.indexOf('shipyard:tokens:light:end'), 'shape block sits outside the colour block');
  const theme = await read(dir, 'src/lib/theme.ts');
  assert.match(theme, /export const LOOK = \{ density: "airy", cards: "elevated", buttons: "pill", header: "centered" \} as const;/);
  assert.match(theme, /export const HOME_STYLE: "focus" \| "split" \| "editorial" \| "cards" \| "list" = "cards";/);
  assert.match(await read(dir, 'src/lib/constants.ts'), /^export const LAYOUT = "bottom-nav" as/m);
  const md = await read(dir, 'DESIGN.md');
  assert.match(md, /## Layout/);
  assert.match(md, /Menu: tabs at the bottom/);
  assert.match(md, /Homepage: a grid of cards/);
  assert.match(md, /Cards: a soft shadow/);
  assert.match(md, /Buttons: filled, fully rounded ends/);
  assert.match(md, /body 17px/);
  assert.ok(!md.includes('\u2014'));
  assert.equal(r.layout.home, 'cards');
  assert.ok(r.tokenChanges.shape.some((c) => c.name === '--font-size-base' && c.to === '17px'));
});

test('v0.3: every preset sets the menu style in constants.ts, the app config and the profile', async () => {
  const dir = await makeApp({ slug: 'menu-app' });
  await upsertApp({ slug: 'menu-app', name: 'Demo App', dir });
  for (const id of await listPresetIds()) {
    const { tokens } = await loadPreset(id);
    await applyDesign({ appDir: dir, preset: id, icons: false });
    assert.match(await read(dir, 'src/lib/constants.ts'), new RegExp(`^export const LAYOUT = "${tokens.layout.nav}" as`, 'm'), id);
    assert.equal((await readJson(dir, '.shipyard-app.json')).layout, tokens.layout.nav, id);
    assert.match(await read(dir, 'src/lib/theme.ts'), new RegExp(`HOME_STYLE: [^=]+= "${tokens.layout.home}"`), id);
    assert.equal(readMarkerBlock(await read(dir, 'src/app/globals.css'), 'shape')['--heading-weight'], String(tokens.type.headingWeight), id);
  }
  const last = (await loadPreset((await listPresetIds()).at(-1))).tokens;
  assert.equal((await loadProfile()).apps.find((a) => a.slug === 'menu-app').layout, last.layout.nav);
});

test('v0.3: --keep-layout leaves the menu style alone', async () => {
  const dir = await makeApp({ layout: 'sidebar' });
  const r = await applyDesign({ appDir: dir, preset: 'editorial', icons: false, keepLayout: true });
  assert.equal(r.layout.nav, 'sidebar');
  assert.match(await read(dir, 'src/lib/constants.ts'), /^export const LAYOUT = "sidebar" as/m);
  assert.equal((await readJson(dir, '.shipyard-app.json')).layout, 'sidebar');
  assert.match(await read(dir, 'DESIGN.md'), /Menu: a menu on the left/);
  const c = cli([dir, '--preset', 'editorial', '--keep-layout', '--no-icons', '--json']);
  assert.equal(c.code, 0);
  assert.equal(JSON.parse(c.out).layout.nav, 'sidebar');
  assert.match(cli(['--help']).out, /--keep-layout/);
});

test('v0.3: an older app without shape markers still gets colours, with a note; half a pair is refused', async () => {
  const dir = await makeApp();
  const css = await read(dir, 'src/app/globals.css');
  const old = css.replace(/[ \t]*\/\* shipyard:tokens:shape:(start|end) \*\/\n/g, '');
  await writeFile(path.join(dir, 'src/app/globals.css'), old);
  const r = await applyDesign({ appDir: dir, preset: 'fresh-green', icons: false });
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => /older template/.test(n)), r.notes.join('|'));
  assert.match(await read(dir, 'src/app/globals.css'), /--accent: #1b7a4b;/);
  const half = css.replace(/[ \t]*\/\* shipyard:tokens:shape:end \*\/\n/, '');
  await writeFile(path.join(dir, 'src/app/globals.css'), half);
  const before = await snapshot(dir);
  await assert.rejects(applyDesign({ appDir: dir, preset: 'playful', icons: false }), /shipyard:tokens:shape:end/);
  assert.deepEqual(await snapshot(dir), before);
});

test('v0.3: a token file without type/layout gets the template defaults; bad values block apply', async () => {
  const dir = await makeApp();
  const { tokens } = await loadPreset('clean-mono');
  const plain = { ...tokens, id: 'plain-look', type: undefined, layout: undefined };
  const file = path.join(dir, 'plain.tokens.json');
  await writeFile(file, JSON.stringify(plain));
  const r = await applyDesign({ appDir: dir, tokensFile: file, icons: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.layout, { nav: 'bottom-nav', density: 'regular', maxWidth: 'medium', home: 'focus', cards: 'bordered', buttons: 'solid', header: 'bar' });
  assert.deepEqual((await readJson(dir, '.shipyard', 'design', 'applied.tokens.json')).type, { scale: 'comfortable', headingWeight: 700, headingTracking: 'normal' });
  const bad = path.join(dir, 'bad.tokens.json');
  await writeFile(bad, JSON.stringify({ ...tokens, id: 'bad-look', layout: { nav: 'floating' } }));
  const blocked = await applyDesign({ appDir: dir, tokensFile: bad, fix: true, icons: false });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /menu style \("layout\.nav"\) must be one of: bottom-nav, sidebar, top-nav/);
});

test('v0.3: calm-blue is the template default exactly (every v0.3 file already matches)', async () => {
  const { tokens } = await loadPreset('calm-blue');
  assert.deepEqual(tokens.layout, { nav: 'bottom-nav', density: 'regular', maxWidth: 'medium', home: 'focus', cards: 'bordered', buttons: 'solid', header: 'bar' });
  assert.deepEqual(tokens.type, { scale: 'comfortable', headingWeight: 700, headingTracking: 'normal' });
  assert.equal(renderThemeTs(tokens).includes('LOOK = { density: "regular", cards: "bordered", buttons: "solid", header: "bar" }'), true);
});

test('every ready-made look leaves the app\'s own design tests green (dark default, own fonts, any layout)', async () => {
  for (const id of await listPresetIds()) {
    const dir = await makeApp({ slug: `t-${id}`.slice(0, 38), name: 'Test App' });
    await applyDesign({ appDir: dir, preset: id, icons: false });
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.mjs'), '--test-name-pattern', 'design|CSS markers'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `${id}: ${r.stdout.slice(-1500)}${r.stderr.slice(-500)}`);
  }
});
