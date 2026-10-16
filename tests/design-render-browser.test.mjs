// OPT-IN browser tests for the preview renderer, design-directions and the gallery's --real hook.
// They run only when SHIPYARD_TEST_APP_DIR points at a scaffolded Shipyard app where npm install has been run:
//   SHIPYARD_TEST_APP_DIR=/path/to/app node --test tests/design-render-browser.test.mjs
// They start that app's own `next dev` on a free local port and stop it again, and write into the app's
// ignored folders (.shipyard/ and .next/). Use a scratch app, not one you are working on.
// The tests check that the screenshots are real, different pages: PNG files of the right size, all different,
// and the server is gone afterwards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const APP = process.env.SHIPYARD_TEST_APP_DIR;
const skip = APP ? false : 'set SHIPYARD_TEST_APP_DIR to a scaffolded app (npm install done) to run the browser tests';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-render-browser-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));

const { renderPreviews, portIsOpen, RenderError } = await import('../scripts/design/render-previews.mjs');
const { makeDirections, directionFile } = await import('../scripts/design-directions.mjs');
const { renderRealShots, renderGalleryHtml } = await import('../scripts/design-gallery.mjs');
const { loadPreset } = await import('../scripts/design/presets.mjs');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function pngInfo(file) {
  const buf = await readFile(file);
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex') };
}

const VIEWS = [
  { name: 'phone-light', width: 390, height: 800, theme: 'light' },
  { name: 'phone-dark', width: 390, height: 800, theme: 'dark' },
  { name: 'desktop-light', width: 1280, height: 800, theme: 'light' },
];

test('renderPreviews: two ready-made looks, three views each, real different pages, server stopped afterwards', { skip }, async () => {
  const items = [];
  for (const id of ['calm-blue', 'editorial']) items.push({ id, tokens: (await loadPreset(id)).tokens });
  let server = null;
  const messages = [];
  const out = await renderPreviews({ appDir: APP, items, views: VIEWS, onServerStart: (s) => { server = s; }, onProgress: (m) => messages.push(m) });
  assert.equal(out.length, 6);
  assert.deepEqual(out.map((o) => `${o.id}/${o.view}`), ['calm-blue/phone-light', 'calm-blue/phone-dark', 'calm-blue/desktop-light', 'editorial/phone-light', 'editorial/phone-dark', 'editorial/desktop-light']);
  const seen = new Set();
  for (const o of out) {
    assert.ok(path.isAbsolute(o.png));
    assert.ok(o.png.includes(path.join('.shipyard', 'design', 'previews')));
    const info = await pngInfo(o.png);
    const phone = o.view.startsWith('phone');
    assert.deepEqual([info.width, info.height], phone ? [780, 1600] : [1280, 800], `${o.id} ${o.view}`);
    assert.ok(info.bytes > 15_000, `${o.id} ${o.view} is not blank (${info.bytes} bytes)`);
    seen.add(info.sha);
  }
  assert.equal(seen.size, 6, 'every screenshot is different (two looks, light and dark, phone and desktop)');
  assert.ok(messages.some((m) => /Starting your app/.test(m)));
  assert.ok(server && server.port > 0);
  assert.equal(await portIsOpen(server.port), false, 'the dev server is gone');
});

test('renderPreviews: a run that fails still stops the server', { skip }, async () => {
  const tokens = (await loadPreset('calm-blue')).tokens;
  let server = null;
  await assert.rejects(
    renderPreviews({ appDir: APP, items: [{ id: 'calm-blue', tokens }], views: VIEWS.slice(0, 1), timeoutMs: 1, onServerStart: (s) => { server = s; } }),
    (err) => err instanceof RenderError && /too long/.test(err.message),
  );
  assert.ok(server);
  assert.equal(await portIsOpen(server.port), false);
});

// three looks drafted for a neighbourhood bakery app: different menu, homepage, type, spacing, cards, buttons and colours
const DIRECTIONS = {
  a: {
    id: 'warm-counter', name: 'Warm counter', description: 'Cream paper, brick-red accent and a big serif headline.', goodFor: 'a neighbourhood bakery',
    defaultTheme: 'light', font: { body: 'DM Sans', heading: 'Fraunces' }, radius: { base: 20, sm: 14 }, shadow: 'soft',
    type: { scale: 'large', headingWeight: 700, headingTracking: 'tight' },
    layout: { nav: 'top-nav', density: 'airy', maxWidth: 'medium', home: 'split', cards: 'elevated', buttons: 'pill', header: 'bar' },
    light: { background: '#fbf4ea', foreground: '#2a1d15', card: '#ffffff', muted: '#6f5c4d', line: '#eadfce', lineStrong: '#a8957f', accent: '#b23a1e', accentContrast: '#ffffff', focus: '#b23a1e', danger: '#b42318', dangerContrast: '#ffffff' },
    dark: { background: '#17110d', foreground: '#f6ece0', card: '#231a14', muted: '#b9a898', line: '#3a2d24', lineStrong: '#6a5644', accent: '#ee8a6a', accentContrast: '#2a1208', focus: '#ee8a6a', danger: '#ff8a80', dangerContrast: '#2a0a08' },
  },
  b: {
    id: 'market-stall', name: 'Market stall', description: 'Sage green and tinted cards in a phone-first layout.', goodFor: 'ordering from a phone',
    defaultTheme: 'light', font: { body: 'Nunito', heading: 'same' }, radius: { base: 12, sm: 8 }, shadow: 'none',
    type: { scale: 'comfortable', headingWeight: 800, headingTracking: 'normal' },
    layout: { nav: 'bottom-nav', density: 'regular', maxWidth: 'medium', home: 'cards', cards: 'tinted', buttons: 'solid', header: 'plain' },
    light: { background: '#f2f6ee', foreground: '#16241a', card: '#ffffff', muted: '#566a5a', line: '#dbe5d6', lineStrong: '#8ea592', accent: '#2f6f3e', accentContrast: '#ffffff', focus: '#2f6f3e', danger: '#b3261e', dangerContrast: '#ffffff' },
    dark: { background: '#0f1a13', foreground: '#e9f3ea', card: '#172319', muted: '#a3b9a7', line: '#28382c', lineStrong: '#4b6650', accent: '#7fcf8e', accentContrast: '#0c2412', focus: '#7fcf8e', danger: '#ff8c84', dangerContrast: '#2a0a08' },
  },
  c: {
    id: 'chalkboard-menu', name: 'Chalkboard menu', description: 'Charcoal board, butter-yellow accent and a plain list.', goodFor: "showing today's bake",
    defaultTheme: 'dark', font: { body: 'Source Sans 3', heading: 'Space Grotesk' }, radius: { base: 4, sm: 2 }, shadow: 'none',
    type: { scale: 'compact', headingWeight: 600, headingTracking: 'normal' },
    layout: { nav: 'top-nav', density: 'compact', maxWidth: 'narrow', home: 'editorial', cards: 'flat', buttons: 'sharp', header: 'plain' },
    light: { background: '#f4f1e8', foreground: '#1a1c1e', card: '#ffffff', muted: '#5c5f58', line: '#ddd9cc', lineStrong: '#9a9786', accent: '#7a5a00', accentContrast: '#ffffff', focus: '#7a5a00', danger: '#b3261e', dangerContrast: '#ffffff' },
    dark: { background: '#14171a', foreground: '#f1efe6', card: '#1b1f23', muted: '#a7aaa0', line: '#2c3136', lineStrong: '#555b62', accent: '#e9c46a', accentContrast: '#1c1708', focus: '#e9c46a', danger: '#ff8f87', dangerContrast: '#2a0a08' },
  },
};

test('design-directions: three drafted looks become three different real pages in one self-contained page', { skip }, async () => {
  for (const [key, tokens] of Object.entries(DIRECTIONS)) {
    await writeFile(directionFile(APP, key), `${JSON.stringify(tokens, null, 2)}\n`);
  }
  let server = null;
  const r = await makeDirections({ appDir: APP, renderer: (o) => renderPreviews({ ...o, onServerStart: (s) => { server = s; } }) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.directions.map((d) => d.name), ['Warm counter', 'Market stall', 'Chalkboard menu']);
  assert.equal(await portIsOpen(server.port), false);
  const html = await readFile(r.page, 'utf8');
  const images = html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
  assert.equal(images.length, 12, 'three directions, four pictures each');
  assert.equal(new Set(images.map((i) => createHash('sha256').update(i).digest('hex'))).size, 12, 'all different');
  for (const key of ['A', 'B', 'C']) assert.ok(html.includes(`>Use direction ${key}</button>`));
  assert.match(html, /Shipyard: use direction B for /);
});

test('the gallery --real hook: real screenshots of the app come back and end up in the page', { skip }, async () => {
  const looks = [(await loadPreset('calm-blue')).tokens, (await loadPreset('night-tech')).tokens];
  const { shots, message } = await renderRealShots({ appDir: APP, looks });
  assert.equal(message, null);
  assert.deepEqual(Object.keys(shots).sort(), ['calm-blue', 'night-tech']);
  for (const id of Object.keys(shots)) {
    assert.deepEqual(Object.keys(shots[id]).sort(), ['desktop-dark', 'desktop-light', 'phone-dark', 'phone-light']);
    for (const png of Object.values(shots[id])) assert.ok((await pngInfo(png)).bytes > 15_000);
  }
  assert.notEqual((await pngInfo(shots['calm-blue']['phone-light'])).sha, (await pngInfo(shots['night-tech']['phone-light'])).sha);
  const html = renderGalleryHtml({ looks, appName: 'Scratch', shots });
  assert.match(html, /These are real screenshots of your app/);
  assert.equal((html.match(/<img class="on-light"/g) ?? []).length, 4);
});
