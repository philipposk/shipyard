// design-logo without a browser: checking drawings, the combined icon.svg, the file list, manifests and head tags.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-logo-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));

const logo = await import('../scripts/design/capture/logo.mjs');
const { readLogoPair } = await import('../scripts/design-logo.mjs');

const drawing = (tile) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><clipPath id="d"><circle cx="256" cy="256" r="228"/></clipPath></defs><rect width="512" height="512" fill="${tile}"/><g clip-path="url(#d)"><circle cx="256" cy="256" r="100" fill="#fff"/></g></svg>`;
const light = drawing('#f4ecdc');
const dark = drawing('#141110');

test('logoProblems accepts a square drawing and names what is wrong with others', () => {
  assert.deepEqual(logo.logoProblems(light), []);
  assert.match(logo.logoProblems('hello')[0], /not an SVG/);
  assert.match(logo.logoProblems('<svg viewBox="0 0 100 50"></svg>')[0], /square/);
  assert.match(logo.logoProblems('<svg></svg>')[0], /viewBox/);
  assert.match(logo.logoProblems('<svg viewBox="0 0 9 9"><script>x()</script></svg>')[0], /script/);
  assert.match(logo.logoProblems('<svg viewBox="0 0 9 9"><rect onclick="x()"/></svg>')[0], /script/);
  assert.match(logo.logoProblems('<svg viewBox="0 0 9 9"><image href="a.png"/></svg>')[0], /links/);
  assert.match(logo.logoProblems('<svg viewBox="0 0 9 9"><text>A</text></svg>')[0], /text/);
  assert.deepEqual(logo.logoProblems('<svg viewBox="0 0 9 9"><use href="#a"/></svg>'), []);
});

test('combinedSvg holds both drawings, follows the device, and keeps their ids apart', () => {
  const svg = logo.combinedSvg({ light, dark });
  assert.match(svg, /@media \(prefers-color-scheme: dark\)\{\.l\{display:none\}\.d\{display:inline\}\}/);
  assert.match(svg, /id="l-d"/);
  assert.match(svg, /id="d-d"/);
  assert.match(svg, /url\(#l-d\)/);
  assert.match(svg, /url\(#d-d\)/);
  assert.equal((svg.match(/<svg/g) || []).length, 3);
  assert.equal((svg.match(/<\/svg>/g) || []).length, 3);
  assert.match(svg, /#f4ecdc/);
  assert.match(svg, /#141110/);
});

test('logoJobs draws both modes: rounded and see-through, or full square for systems that cut corners', () => {
  const jobs = logo.logoJobs({ prefix: 'rhino-icon', light, dark, mono: light });
  const by = Object.fromEntries(jobs.map((j) => [j.file, j]));
  assert.equal(jobs.length, 11);
  for (const file of ['rhino-icon-32.png', 'rhino-icon-dark-32.png', 'rhino-icon-192.png', 'rhino-icon-dark-512.png']) assert.equal(by[file].transparent, true, file);
  for (const file of ['rhino-icon-apple-180.png', 'rhino-icon-dark-maskable-512.png']) assert.equal(by[file].transparent, false, file);
  assert.equal(by['rhino-icon-32.png'].size, 32);
  assert.equal(by['rhino-icon-apple-180.png'].size, 180);
  assert.match(by['rhino-icon-dark-192.png'].svg, /#141110/);
  assert.equal(logo.logoJobs({ light, dark }).some((j) => /mono/.test(j.file)), false);
});

test('logoManifests keeps the rest of the manifest and gives the dark twin its own icons and colours', () => {
  const text = JSON.stringify({ name: 'App', start_url: '/', theme_color: '#fff', icons: [{ src: '/old.svg' }] });
  const { light: l, dark: d } = logo.logoManifests(text, { prefix: 'icon', base: '/', dark, mono: true });
  const a = JSON.parse(l);
  const b = JSON.parse(d);
  assert.equal(a.name, 'App');
  assert.equal(a.theme_color, '#fff');
  assert.equal(b.theme_color, '#141110');
  assert.equal(b.background_color, '#141110');
  assert.deepEqual(a.icons.map((i) => i.src), ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/icon-mono-512.png']);
  assert.deepEqual(b.icons.map((i) => i.src), ['/icon-dark-192.png', '/icon-dark-512.png', '/icon-dark-maskable-512.png', '/icon-mono-512.png']);
  assert.deepEqual(a.icons.map((i) => i.purpose), ['any', 'any', 'maskable', 'monochrome']);
});

test('darkManifestName works with and without an extension', () => {
  assert.equal(logo.darkManifestName('/manifest.webmanifest'), '/manifest-dark.webmanifest');
  assert.equal(logo.darkManifestName('staff/manifest.json'), 'staff/manifest-dark.json');
  assert.equal(logo.darkManifestName('manifest'), 'manifest-dark');
});

test('logoHeadTags put the svg after the PNGs and swap the manifest in dark mode', () => {
  const tags = logo.logoHeadTags({ prefix: 'icon', base: '/', manifest: '/manifest.webmanifest' });
  assert.ok(tags.indexOf('icon-32.png') < tags.indexOf('icon.svg'));
  assert.match(tags, /href="\/icon-dark-32\.png" media="\(prefers-color-scheme: dark\)"/);
  assert.match(tags, /rel="apple-touch-icon" href="\/icon-dark-apple-180\.png"/);
  assert.match(tags, /href='?"?\/manifest\.webmanifest/);
  assert.match(tags, /'\/manifest-dark\.webmanifest'/);
  assert.doesNotMatch(logo.logoHeadTags({}), /manifest/);
});

test('the sheet shows both modes at the small sizes and escapes the name', () => {
  const page = logo.logoSheetPage({ light, dark, name: 'A<b>' });
  assert.match(page, /A&lt;b&gt;/);
  assert.match(page, /width="16"/);
  assert.match(page, /#f4ecdc/);
  assert.match(page, /#141110/);
});

test('readLogoPair needs both drawings, and picks up the one-colour one', async () => {
  const app = path.join(tmp, 'app');
  const dir = path.join(app, 'public', 'brand-approved');
  await mkdir(dir, { recursive: true });
  assert.equal(await readLogoPair(app), null);
  await writeFile(path.join(dir, 'logo-light.svg'), light);
  assert.equal(await readLogoPair(app), null);
  await writeFile(path.join(dir, 'logo-dark.svg'), dark);
  const pair = await readLogoPair(app);
  assert.equal(pair.dark, dark);
  assert.equal(pair.mono, null);
  await writeFile(path.join(dir, 'logo-mono.svg'), light);
  assert.equal((await readLogoPair(app)).mono, light);
});
