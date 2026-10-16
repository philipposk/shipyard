// OPT-IN browser tests for design-from-url and design-icons. They run only when SHIPYARD_TEST_APP_DIR points
// at a Shipyard app folder where npm install has been run (it must have node_modules/playwright):
//   SHIPYARD_TEST_APP_DIR=/path/to/app node --test tests/design-capture-browser.test.mjs
// Nothing in that app is changed: the tests work in a temporary folder that borrows its node_modules.
// The "website" is a tiny local node:http server (tests/design-capture-fixtures.mjs), never a real site.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, cp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.SHIPYARD_TEST_APP_DIR;
const skip = APP ? false : 'set SHIPYARD_TEST_APP_DIR to an app folder with node_modules/playwright to run the browser tests';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-capture-browser-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));

const { startFixtureServer } = await import('./design-capture-fixtures.mjs');
const { captureUrl } = await import('../scripts/design-from-url.mjs');
const { makeIcons } = await import('../scripts/design-icons.mjs');
const { validateTokens } = await import('../scripts/design/validate.mjs');
const { isAllowedFont } = await import('../scripts/design/fonts.mjs');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function pngInfo(file) {
  const buf = await readFile(file);
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex') };
}

let server;
let appDir;

before(async () => {
  if (skip) return;
  server = await startFixtureServer();
  appDir = path.join(tmp, 'app');
  await mkdir(path.join(appDir, 'src', 'app'), { recursive: true });
  await mkdir(path.join(appDir, 'src', 'lib'), { recursive: true });
  await writeFile(path.join(appDir, '.shipyard-app.json'), JSON.stringify({ slug: 'capture-app', name: 'Capture App', description: 'A test app.' }));
  await writeFile(path.join(appDir, 'package.json'), '{"name":"capture-app","private":true}');
  await writeFile(path.join(appDir, '.gitignore'), '.shipyard/\n');
  await symlink(path.join(path.resolve(APP), 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
  for (const rel of ['src/app/globals.css', 'src/lib/theme.ts']) await cp(path.join(root, 'template', rel), path.join(appDir, rel));
  await writeFile(path.join(appDir, 'src', 'lib', 'constants.ts'), 'export const SITE_NAME = "Hearth Bakery";\nexport const SITE_TAGLINE = "Fresh bread, baked slowly.";\n');
});
after(async () => {
  await server?.close();
});

const capture = (p) => captureUrl({ url: `${server.origin}${p}`, appDir });

test('url capture: a friendly shop page (links on top, split hero, floating cards, round buttons, own dark mode)', { skip }, async () => {
  const r = await capture('/');
  assert.equal(r.ok, true, r.error);
  const t = r.tokens;
  assert.deepEqual(t.layout, { nav: 'top-nav', density: 'airy', maxWidth: 'medium', home: 'split', cards: 'elevated', buttons: 'pill', header: 'bar' });
  assert.equal(t.type.scale, 'large');
  assert.equal(t.light.accent, '#0f766e');
  assert.equal(t.light.background, '#fffaf3');
  assert.deepEqual(t.font, { body: 'DM Sans', heading: 'same' }, 'Poppins maps to the nearest free geometric font');
  assert.ok(isAllowedFont(t.font.body));
  assert.equal(t.shadow, 'soft');
  assert.ok(t.radius.base >= 16 && t.radius.sm <= t.radius.base);
  assert.equal(r.hasOwnDark, true);
  assert.notEqual(t.dark.background, t.light.background);
  assert.ok(t.dark.accent.toLowerCase() !== t.light.accent, 'dark accent comes from the site dark mode');
  assert.equal(validateTokens(t).ok, true);
  assert.deepEqual(JSON.parse(await readFile(r.draftPath, 'utf8')), t);
  const desktop = await pngInfo(r.desktopPng);
  const phone = await pngInfo(r.phonePng);
  assert.deepEqual([desktop.width, desktop.height], [1280, 800]);
  assert.deepEqual([phone.width, phone.height], [390, 844]);
  assert.ok(desktop.bytes > 3000 && phone.bytes > 3000);
  assert.notEqual(desktop.sha, phone.sha);
});

test('url capture: only the style is kept, never the page text or the host', { skip }, async () => {
  const r = await capture('/');
  const text = JSON.stringify(r.tokens);
  for (const secret of ['Hearth', 'Sourdough', 'Croissants', 'Bread worth', '127.0.0.1', 'Poppins', 'fixture']) assert.ok(!text.includes(secret), secret);
  const files = (await readdir(path.join(appDir, '.shipyard', 'design'))).sort();
  assert.deepEqual(files.filter((f) => !f.endsWith('.tmp')), ['url-desktop.png', 'url-draft.tokens.json', 'url-phone.png']);
  assert.equal(r.gitignoreWarning, null);
});

test('url capture: a dashboard page (menu column on the left, tight spacing, square buttons) gives a very different look', { skip }, async () => {
  const r = await capture('/dash');
  assert.equal(r.ok, true, r.error);
  const t = r.tokens;
  assert.equal(t.layout.nav, 'sidebar');
  assert.equal(t.layout.home, 'list');
  assert.equal(t.layout.density, 'compact');
  assert.equal(t.layout.buttons, 'sharp');
  assert.equal(t.layout.cards, 'bordered');
  assert.equal(t.type.scale, 'compact');
  assert.equal(t.font.body, 'Inter');
  assert.ok(t.radius.base <= 6);
  assert.equal(r.hasOwnDark, false);
  assert.equal(validateTokens(t).ok, true);
});

test('url capture: a reading site (serif, stack of articles, outline buttons, narrow column)', { skip }, async () => {
  const r = await capture('/blog');
  assert.equal(r.ok, true, r.error);
  const t = r.tokens;
  assert.equal(t.layout.home, 'editorial');
  assert.equal(t.layout.nav, 'top-nav');
  assert.equal(t.layout.buttons, 'outline');
  assert.equal(t.layout.maxWidth, 'narrow');
  assert.equal(t.font.body, 'Source Serif 4');
  assert.equal(t.light.accent, '#8a1c1c');
  assert.equal(validateTokens(t).ok, true);
});

test('url capture: a dark-only site defaults to dark', { skip }, async () => {
  const r = await capture('/dark');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tokens.defaultTheme, 'dark');
  assert.equal(r.tokens.font.body, 'IBM Plex Sans');
  assert.equal(r.tokens.dark.accent, '#22d3ee');
  assert.equal(validateTokens(r.tokens).ok, true);
});

test('url capture: the three drafts differ in at least 4 of the 7 look dimensions', { skip }, async () => {
  const { lookDims } = await import('../scripts/design/tokens.mjs');
  const [shop, dash, blog] = [await capture('/'), await capture('/dash'), await capture('/blog')].map((r) => lookDims(r.tokens));
  const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).length;
  assert.ok(diff(shop, dash) >= 5, `shop vs dash ${diff(shop, dash)}`);
  assert.ok(diff(shop, blog) >= 4, `shop vs blog ${diff(shop, blog)}`);
  assert.ok(diff(dash, blog) >= 4, `dash vs blog ${diff(dash, blog)}`);
});

test('url capture: a missing page, an unreachable site and a bad address are explained', { skip }, async () => {
  await assert.rejects(capture('/nope'), /error \(status 404\)/);
  const closed = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  await assert.rejects(captureUrl({ url: `http://127.0.0.1:${closed}/`, appDir }), /refused the connection/);
  await assert.rejects(captureUrl({ url: 'http://127.0.0.1:9/', appDir }), /port number/);
  await assert.rejects(captureUrl({ url: 'file:///etc/passwd', appDir }), /http/);
  const bare = path.join(tmp, 'bare');
  await mkdir(bare, { recursive: true });
  await writeFile(path.join(bare, '.shipyard-app.json'), JSON.stringify({ slug: 'bare' }));
  await assert.rejects(captureUrl({ url: `${server.origin}/`, appDir: bare }), /npm install/);
});

test('icons: draws icon.svg and four PNGs of the right sizes from the app name and accent', { skip }, async () => {
  const r = await makeIcons({ appDir });
  assert.equal(r.source, 'monogram');
  assert.equal(r.text, 'HB');
  const svg = await readFile(path.join(appDir, 'public', 'icon.svg'), 'utf8');
  assert.match(svg, /fill="#2563eb"/);
  assert.match(svg, />HB<\/text>/);
  const sizes = { 'icon-192.png': [192, 192], 'icon-512.png': [512, 512], 'icon-maskable-512.png': [512, 512], 'og-image.png': [1200, 630] };
  const seen = new Set();
  for (const [file, [w, h]] of Object.entries(sizes)) {
    const info = await pngInfo(path.join(appDir, 'public', file));
    assert.deepEqual([info.width, info.height], [w, h], file);
    assert.ok(info.bytes > 800, file);
    seen.add(info.sha);
  }
  assert.equal(seen.size, 4, 'four different pictures');
  const again = await makeIcons({ appDir });
  assert.equal(again.files.find((f) => f.file === 'public/icon.svg').status, 'unchanged');
});

test('icons: an approved icon replaces the letters', { skip }, async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#c2410c"/></svg>';
  await mkdir(path.join(appDir, 'public', 'brand-approved'), { recursive: true });
  await writeFile(path.join(appDir, 'public', 'brand-approved', 'icon.svg'), svg);
  try {
    const r = await makeIcons({ appDir });
    assert.equal(r.source, 'brand-approved');
    assert.equal(await readFile(path.join(appDir, 'public', 'icon.svg'), 'utf8'), svg);
    assert.equal((await pngInfo(path.join(appDir, 'public', 'icon-512.png'))).width, 512);
  } finally {
    await rm(path.join(appDir, 'public', 'brand-approved'), { recursive: true, force: true });
  }
});
