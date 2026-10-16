// design-icons without a browser: the monogram, the icon and share-image pages, and reading the app's
// name and colours from its files. Also the browser lookup helpers (cached Chromium discovery).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-icons-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const icons = await import('../scripts/design/capture/icons.mjs');
const { cachedChromiums, browserCacheRoots, loadPlaywright, launchChromium, BrowserError } = await import('../scripts/design/capture/browser.mjs');
const { readIconInputs } = await import('../scripts/design-icons.mjs');
const { contrast } = await import('../scripts/design/color.mjs');

// ---------- monogram ----------

test('monogramText: one letter, or two for a two-word name', () => {
  const cases = [['Hearth', 'H'], ['Hearth Bakery', 'HB'], ['recipe box', 'RB'], ['Recipe-Box', 'RB'], ['one two three', 'OT'], ['  ...x', 'X'], ['"Quoted" name', 'QN'], ['', 'A'], [undefined, 'A'], ['!!!', 'A'], ['Αθήνα Καφές', 'ΑΚ'], ['ß', 'SS'.slice(0, 2)]];
  for (const [name, want] of cases) assert.equal(icons.monogramText(name), want, String(name));
});

test('monogramSvg: accent rounded square, accent-contrast letters, system font, weight 700, no gradients or effects', () => {
  const svg = icons.monogramSvg({ name: 'Hearth Bakery', accent: '#2563EB', accentContrast: '#ffffff' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"/);
  assert.match(svg, /<rect width="512" height="512" rx="113" fill="#2563eb"\/>/);
  assert.match(svg, /font-family='system-ui, -apple-system, "Segoe UI", sans-serif'/);
  assert.match(svg, /font-weight="700"/);
  assert.match(svg, /fill="#ffffff"[^>]*>HB<\/text>/);
  assert.ok(!/gradient|filter|shadow|<image|<defs/i.test(svg));
  assert.ok(svg.indexOf('system-ui') > 0);
});

test('monogramSvg: the maskable version is full-bleed and keeps the letters inside the middle 80%', () => {
  for (const name of ['Hearth', 'Hearth Bakery']) {
    const svg = icons.monogramSvg({ name, accent: '#0f766e', accentContrast: '#ffffff', maskable: true });
    assert.ok(!/ rx=/.test(svg), 'no rounded corners');
    const fs = Number(/font-size="(\d+)"/.exec(svg)[1]);
    const letters = Array.from(icons.monogramText(name)).length;
    const width = fs * 0.75 * letters; // generous estimate of capital letter width
    assert.ok(width <= 512 * 0.8, `${name}: ${width}`);
    assert.ok(fs * 0.75 <= 512 * 0.8);
    // the corner of the text box stays inside the safe circle of radius 40%
    assert.ok(Math.hypot(width / 2, (fs * 0.72) / 2) <= 512 * 0.4, name);
  }
  const normal = icons.monogramSvg({ name: 'Hearth Bakery', accent: '#0f766e', accentContrast: '#ffffff' });
  assert.ok(Number(/font-size="(\d+)"/.exec(normal)[1]) > Number(/font-size="(\d+)"/.exec(icons.monogramSvg({ name: 'Hearth Bakery', accent: '#0f766e', accentContrast: '#ffffff', maskable: true }))[1]));
});

test('monogramSvg: escapes the name and falls back on bad colours', () => {
  const svg = icons.monogramSvg({ name: '<b onload="x">&', accent: 'red', accentContrast: 'nope' });
  assert.ok(!svg.includes('<b onload'));
  assert.match(svg, /fill="#2563eb"/);
  assert.match(svg, /fill="#ffffff"/);
});

test('iconPage and ogPage: plain pages with no gradients, names escaped', () => {
  const svg = icons.monogramSvg({ name: 'A', accent: '#2563eb', accentContrast: '#ffffff' });
  const page = icons.iconPage({ svg, size: 192 });
  assert.match(page, /width:192px;height:192px/);
  assert.ok(page.includes('<svg'));
  const withImage = icons.iconPage({ imageDataUrl: 'data:image/svg+xml;base64,AAAA', size: 512, background: '#2563eb', inset: 0.18 });
  assert.match(withImage, /background:#2563eb/);
  assert.match(withImage, /<img src="data:image\/svg\+xml;base64,AAAA"/);
  const og = icons.ogPage({ name: 'Fish & <Chips>', tagline: 'Hot "today"', background: '#f6f7f9', foreground: '#14161a', muted: '#5b6270', accent: '#2563eb', weight: 800 });
  assert.match(og, /width:1200px;height:630px/);
  assert.ok(og.includes('Fish &amp; &lt;Chips&gt;'));
  assert.ok(og.includes('Hot &quot;today&quot;'));
  assert.match(og, /font-weight:800/);
  assert.match(og, /background:#2563eb/);
  assert.ok(!/gradient|<img/i.test(og));
  assert.match(icons.ogPage({ name: 'x', tagline: '', background: '#fff', foreground: '#000', muted: '#555', accent: '#00f', weight: 123 }), /font-weight:700/);
  assert.ok(!/<p>/.test(icons.ogPage({ name: 'x', tagline: '  ', background: '#fff', foreground: '#000', muted: '#555', accent: '#00f' })));
  assert.match(icons.ogPage({ name: 'Journal', background: '#fff', foreground: '#000', muted: '#555', accent: '#00f', serif: true }), /font-family:ui-serif/);
  // long names get smaller type
  const size = (n) => Number(/h1\{margin:0;font-size:(\d+)px/.exec(icons.ogPage({ name: n, background: '#fff', foreground: '#000', muted: '#555', accent: '#00f' }))[1]);
  assert.ok(size('Hi') > size('A bakery on the corner') && size('A bakery on the corner') > size('A much longer name for an app'));
});

// ---------- reading the app ----------

test('readBrand: real names are read, placeholders and empty values count as missing', () => {
  const ts = `export const SITE_NAME = "Hearth \\"Bakery\\"";\nexport const SITE_SHORT_NAME = 'Hearth';\nexport const SITE_TAGLINE = "";\nexport const SITE_DESCRIPTION = "Fresh bread.";`;
  const b = icons.readBrand(ts);
  assert.equal(b.name, 'Hearth "Bakery"');
  assert.equal(b.shortName, 'Hearth');
  assert.equal(b.tagline, 'Fresh bread.');
  const raw = icons.readBrand(`export const SITE_NAME = "<APP_NAME>";\nexport const SITE_TAGLINE = "<APP_TAGLINE>";`);
  assert.equal(raw.name, null);
  assert.equal(raw.tagline, null);
  assert.deepEqual(icons.readBrand(''), { name: null, shortName: null, tagline: null });
});

test('readAppLook: reads the default theme colours and heading weight from the real template files', async () => {
  const globalsCss = await readFile(path.join(root, 'template', 'src', 'app', 'globals.css'), 'utf8');
  const themeTs = await readFile(path.join(root, 'template', 'src', 'lib', 'theme.ts'), 'utf8');
  const look = icons.readAppLook({ globalsCss, themeTs });
  assert.equal(look.theme, 'light');
  assert.match(look.colors.accent, /^#[0-9a-f]{6}$/);
  for (const k of ['background', 'foreground', 'muted', 'accent', 'accentContrast']) assert.match(look.colors[k], /^#[0-9a-f]{6}$/, k);
  assert.equal(look.headingWeight, 700);
  const dark = icons.readAppLook({ globalsCss, themeTs: themeTs.replace('= "light"', '= "dark"') });
  assert.equal(dark.theme, 'dark');
  assert.notEqual(dark.colors.background, look.colors.background);
});

test('headingIsSerif reads src/lib/fonts.ts', () => {
  assert.equal(icons.headingIsSerif('export const fontClassName = "";'), false);
  assert.equal(icons.headingIsSerif('import { DM_Sans, Fraunces } from "next/font/google";\nconst body = DM_Sans({ subsets: ["latin"] });\nconst heading = Fraunces({ subsets: ["latin"] });'), true);
  assert.equal(icons.headingIsSerif('const body = Source_Serif_4({ subsets: ["latin"] });'), true);
  assert.equal(icons.headingIsSerif('const body = Inter({ subsets: ["latin"] });'), false);
});

async function makeApp(name, { constants, approved } = {}) {
  const dir = path.join(tmp, name);
  await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'lib'), { recursive: true });
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug: name, name: 'Config Name', description: 'From the config.' }));
  await writeFile(path.join(dir, 'src', 'app', 'globals.css'), await readFile(path.join(root, 'template', 'src', 'app', 'globals.css'), 'utf8'));
  await writeFile(path.join(dir, 'src', 'lib', 'theme.ts'), await readFile(path.join(root, 'template', 'src', 'lib', 'theme.ts'), 'utf8'));
  await writeFile(path.join(dir, 'src', 'lib', 'constants.ts'), constants ?? 'export const SITE_NAME = "<APP_NAME>";\nexport const SITE_TAGLINE = "<APP_TAGLINE>";\n');
  if (approved) {
    await mkdir(path.join(dir, 'public', 'brand-approved'), { recursive: true });
    await writeFile(path.join(dir, 'public', 'brand-approved', 'icon.svg'), approved);
  }
  return dir;
}

test('readIconInputs: constants first, the app config when the constants were never filled in', async () => {
  const filled = await readIconInputs(await makeApp('filled', { constants: 'export const SITE_NAME = "Hearth Bakery";\nexport const SITE_TAGLINE = "Bread, daily.";\n' }));
  assert.equal(filled.name, 'Hearth Bakery');
  assert.equal(filled.tagline, 'Bread, daily.');
  assert.equal(filled.approved, null);
  assert.ok(contrast(filled.look.colors.accentContrast, filled.look.colors.accent) >= 4.5);
  const fallback = await readIconInputs(await makeApp('fallback'));
  assert.equal(fallback.name, 'Config Name');
  assert.equal(fallback.tagline, 'From the config.');
});

test('readIconInputs: an approved icon is used, but only when it really is an svg', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  assert.equal((await readIconInputs(await makeApp('approved', { approved: svg }))).approved, svg);
  assert.equal((await readIconInputs(await makeApp('not-svg', { approved: '<html>nope</html>' }))).approved, null);
});

test('readIconInputs: a missing colour block is explained, not guessed', async () => {
  const dir = await makeApp('no-colours');
  await writeFile(path.join(dir, 'src', 'app', 'globals.css'), ':root { --accent: #fff; }\n');
  await assert.rejects(readIconInputs(dir), /could not read the app's colours/);
});

test('design-icons CLI: help works and a missing folder is a usage error', () => {
  const script = path.join(root, 'scripts', 'design-icons.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /brand-approved\/icon\.svg/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  const nodeModules = spawnSync(process.execPath, [script, path.join(tmp, 'filled'), '--json'], { encoding: 'utf8' });
  assert.equal(nodeModules.status, 1);
  assert.match(JSON.parse(nodeModules.stdout).error, /npm install/);
});

// ---------- finding a browser ----------

test('browserCacheRoots: PLAYWRIGHT_BROWSERS_PATH wins, else the usual place per system', () => {
  assert.deepEqual(browserCacheRoots({ PLAYWRIGHT_BROWSERS_PATH: '/x/browsers' }, 'linux', '/home/a'), [path.resolve('/x/browsers')]);
  assert.deepEqual(browserCacheRoots({}, 'darwin', '/Users/a'), [path.join('/Users/a', 'Library', 'Caches', 'ms-playwright')]);
  assert.deepEqual(browserCacheRoots({}, 'linux', '/home/a'), [path.join('/home/a', '.cache', 'ms-playwright')]);
  assert.deepEqual(browserCacheRoots({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\Users\\a'), [path.join('C:\\L', 'ms-playwright')]);
  assert.equal(browserCacheRoots({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux', '/home/a')[0], path.join('/home/a', '.cache', 'ms-playwright'));
});

test('cachedChromiums: finds browsers already downloaded, newest first, headless shell before full Chromium', { skip: process.platform === 'win32' }, async () => {
  const root1 = path.join(tmp, 'cache');
  const exe = async (rel) => {
    const file = path.join(root1, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
  };
  await exe('chromium-1194/chrome-linux/chrome');
  await exe('chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
  await exe('chromium-1243/chrome-linux/chrome');
  await mkdir(path.join(root1, 'ffmpeg-1011'), { recursive: true });
  await mkdir(path.join(root1, 'chromium-9999'), { recursive: true }); // empty: not a browser
  const found = await cachedChromiums(root1);
  assert.deepEqual(found.map((f) => [f.revision, f.shell]), [[1243, true], [1243, false], [1194, false]]);
  assert.deepEqual(await cachedChromiums(path.join(tmp, 'nothing-here')), []);
});

test('launchChromium: falls back to a cached browser, and otherwise says which command to run', async () => {
  const calls = [];
  const fake = (works) => ({ chromium: { launch: async (opts) => { calls.push(opts); if (!opts.executablePath && works !== 'plain') throw new Error("browserType.launch: Executable doesn't exist at /x"); return { fake: true, opts }; } } });
  const exeDir = path.join(tmp, 'cache2', 'chromium-1', 'chrome-linux');
  await mkdir(exeDir, { recursive: true });
  const exe = path.join(exeDir, 'chrome');
  await writeFile(exe, '#!/bin/sh\n');
  await chmod(exe, 0o755);
  if (process.platform !== 'win32') {
    const browser = await launchChromium(fake('cached'), { roots: [path.join(tmp, 'cache2')] });
    assert.equal(browser.opts.executablePath, exe);
  }
  await assert.rejects(launchChromium(fake('cached'), { roots: [path.join(tmp, 'empty-cache')] }), (e) => e instanceof BrowserError && /npx playwright install chromium/.test(e.message) && e.code === 'no-chromium');
  await assert.rejects(launchChromium({ chromium: { launch: async () => { throw new Error('Protocol error: boom'); } } }, { roots: [] }), (e) => e.code === 'launch' && /boom/.test(e.message));
  const plain = await launchChromium(fake('plain'), { roots: [] });
  assert.equal(plain.fake, true);
});

test('loadPlaywright: explains a missing node_modules or a missing Playwright', async () => {
  const bare = path.join(tmp, 'bare-app');
  await mkdir(bare, { recursive: true });
  await assert.rejects(loadPlaywright(bare), (e) => e.code === 'no-node-modules' && /npm install/.test(e.message));
  await mkdir(path.join(bare, 'node_modules'), { recursive: true });
  await assert.rejects(loadPlaywright(bare), (e) => e.code === 'no-playwright' && /npm install/.test(e.message));
  await mkdir(path.join(bare, 'node_modules', 'playwright'), { recursive: true });
  await writeFile(path.join(bare, 'node_modules', 'playwright', 'package.json'), '{"name":"playwright","main":"index.js"}');
  await writeFile(path.join(bare, 'node_modules', 'playwright', 'index.js'), 'module.exports={chromium:{}}');
  assert.ok((await loadPlaywright(bare)).chromium);
});
