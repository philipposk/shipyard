import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-design-gallery-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts', 'design-gallery.mjs');

const { renderGalleryHtml, writeGallery, renderRealShots, REAL_VIEWS } = await import('../scripts/design-gallery.mjs');
const { renderReplica, replicaCss, lookVarsCss, lookFacts } = await import('../scripts/design/replica.mjs');
const { listPresets } = await import('../scripts/design/presets.mjs');
const { renderSettingsHtml } = await import('../scripts/settings-page.mjs');
const { defaultProfile } = await import('../scripts/lib/profile.mjs');

after(() => rm(tmp, { recursive: true, force: true }));
const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

test('gallery: one card per preset with a phone and a computer picture, light and dark, and a copy button', async () => {
  const looks = await listPresets();
  assert.equal(looks.length, 8);
  const html = renderGalleryHtml({ looks });
  assert.equal((html.match(/<article class="look /g) ?? []).length, 8);
  assert.equal((html.match(/class="rep rep-phone"/g) ?? []).length, 8);
  assert.equal((html.match(/class="rep rep-desktop"/g) ?? []).length, 8);
  for (const t of looks) {
    assert.ok(html.includes(`data-copy="Shipyard: use the ${t.name} look"`), t.name);
    assert.ok(html.includes(`.lk-${t.id}[data-view="light"]{`) && html.includes(`.lk-${t.id}[data-view="dark"]{`), t.id);
    assert.ok(html.includes(t.light.accent) && html.includes(t.dark.accent), t.id);
    assert.ok(html.includes(t.goodFor), t.id);
    // the card starts in the look's own default theme
    assert.ok(html.includes(`<article class="look lk-${t.id}" data-view="${t.defaultTheme}"`), t.id);
  }
  assert.equal((html.match(/data-view-btn="dark"/g) ?? []).length, 8);
  assert.match(html, /data-all-view="dark"/);
  assert.match(html, /Pick a look</);
  assert.match(html, /Questions and answers/, 'sample homepages use the template\'s own neutral words');
  assert.doesNotMatch(html, /Good morning/);
});

test('gallery pictures show each look\'s own menu, homepage, cards, buttons, header and type size', async () => {
  const looks = Object.fromEntries((await listPresets()).map((t) => [t.id, t]));
  const phone = (id) => renderReplica(looks[id], { appName: 'Cookbook', kind: 'phone' });
  const desk = (id) => renderReplica(looks[id], { appName: 'Cookbook', kind: 'desktop' });
  // menu: sidebar and top links only on the computer picture; phones always have the tab bar
  assert.ok(desk('clean-mono').includes('class="sb-side"') && !desk('clean-mono').includes('class="tabbar"'));
  assert.ok(desk('editorial').includes('class="hdr-links"') && !desk('editorial').includes('class="tabbar"'));
  assert.ok(desk('warm-friendly').includes('class="tabbar"') && !desk('warm-friendly').includes('class="hdr-links"'));
  for (const id of Object.keys(looks)) assert.ok(phone(id).includes('class="tabbar"'), id);
  // homepage pattern
  const homes = { 'calm-blue': 'home-focus', 'clean-mono': 'home-cards', editorial: 'home-editorial', 'fresh-green': 'home-split', playful: 'home-list' };
  for (const [id, cls] of Object.entries(homes)) assert.ok(phone(id).includes(`page ${cls}`) && desk(id).includes(`page ${cls}`), id);
  // the look's variants are attributes on the picture, the same ones the template reads
  assert.match(phone('warm-friendly'), /data-density="airy" data-cards="elevated" data-buttons="pill" data-header="centered" data-shadow="soft"/);
  assert.match(phone('night-tech'), /data-density="compact" data-cards="bordered" data-buttons="outline" data-header="plain" data-shadow="none"/);
  // type size and weight reach the CSS as numbers
  assert.match(lookVarsCss(looks['clean-mono']), /--basen:15;--h1n:26;/);
  assert.match(lookVarsCss(looks.playful), /--basen:17;--h1n:40\.5;/);
  assert.match(lookVarsCss(looks.editorial), /--hw:600;--ht:-0\.02em;/);
  assert.match(lookVarsCss(looks.editorial), /--maxn:640/);
  assert.match(lookVarsCss(looks['night-tech']), /--maxn:1200/);
  // shared rules cover every variant the template has
  const css = replicaCss();
  for (const rule of ['data-cards="flat"', 'data-cards="bordered"', 'data-cards="elevated"', 'data-cards="tinted"', 'data-buttons="pill"', 'data-buttons="outline"', 'data-buttons="sharp"', 'data-header="plain"', 'data-header="bar"', 'data-header="centered"']) {
    assert.ok(css.includes(rule), rule);
  }
  // names and facts are escaped / plain words
  assert.match(renderReplica(looks['calm-blue'], { appName: '<b>x</b>', kind: 'phone' }), /&lt;b&gt;x&lt;\/b&gt;/);
  const facts = Object.fromEntries(lookFacts(looks['clean-mono']));
  assert.deepEqual(facts, { Menu: 'a menu on the left', Homepage: 'a grid of cards', Cards: 'flat', Buttons: 'sharp capital-letter', Spacing: 'compact', Text: 'compact, Inter' });
});

test('gallery: with an app name the sentence and title name it, and the current look is marked', async () => {
  const looks = await listPresets();
  const html = renderGalleryHtml({ looks, appName: 'Recipe Box', current: 'editorial' });
  assert.match(html, /data-copy="Shipyard: use the Warm and friendly look for Recipe Box"/);
  assert.match(html, /<h1>Pick a look for Recipe Box<\/h1>/);
  assert.equal((html.match(/class="pill">In use</g) ?? []).length, 1);
});

test('gallery: escapes every value (app name, look text) and never emits a style attribute', async () => {
  const [calm] = await listPresets();
  const evil = { ...calm, id: 'evil-look', name: 'Evil <img src=x onerror=alert(1)> "quoted"', description: '<script>alert(1)</script>', goodFor: "a'b & <b>" };
  const html = renderGalleryHtml({ looks: [evil], appName: '"><script>alert(2)</script>' });
  assert.ok(!html.includes('<script>alert'), 'no injected script');
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /Evil &lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot;/);
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.ok(!/ style="/.test(html), 'a policy without unsafe-inline would block it');
  assert.equal((html.match(/<script>/g) ?? []).length, 1, 'only the page script');
});

test('gallery: looks with bad ids, colours or fonts are left out instead of reaching the page', async () => {
  const [calm] = await listPresets();
  const badId = { ...calm, id: 'x"}</style><script>' };
  const badColour = { ...calm, id: 'bad-colour', light: { ...calm.light, accent: 'red;}</style>' } };
  const badFont = { ...calm, id: 'bad-font', font: { body: 'Evil", x', heading: 'same' } };
  const html = renderGalleryHtml({ looks: [calm, badId, badColour, badFont] });
  assert.equal((html.match(/<article class="look /g) ?? []).length, 1);
  assert.ok(!html.includes('bad-colour') && !html.includes('bad-font') && !html.includes('</style><script>'));
});

test('gallery: policy hashes match, one external host (Google Fonts), nothing else fetched', async () => {
  const html = renderGalleryHtml({ looks: await listPresets() });
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1].replace(/&#39;/g, "'");
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(csp.includes(`style-src ${sha(style)} https://fonts.googleapis.com`));
  assert.ok(csp.includes(`script-src ${sha(script)}`));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
  const body = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  const urls = [...body.matchAll(/https?:\/\/[^"'\s)<]+/g)].map((m) => new URL(m[0].replace(/&amp;/g, '&')).host);
  assert.deepEqual([...new Set(urls)], ['fonts.googleapis.com']);
  assert.match(html, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=/);
  for (const bad of ['<img', 'fetch(', 'XMLHttpRequest', '<iframe', '<form', '@import']) assert.ok(!html.includes(bad), bad);
  // fonts the presets use are all asked for in the one address
  for (const f of ['Inter', 'DM+Sans', 'Manrope', 'Nunito', 'Space+Grotesk', 'IBM+Plex+Sans', 'Source+Sans+3', 'Fraunces']) assert.ok(html.includes(`family=${f}:`), f);
  // all-system looks load nothing external
  const sys = renderGalleryHtml({ looks: [(await listPresets())[0]] });
  assert.ok(!sys.includes('fonts.googleapis.com'));
});

test('gallery: readable at 375px, light and dark page, no em dash, no gradients', async () => {
  const html = renderGalleryHtml({ looks: await listPresets() });
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /\.looks\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html, /\.btn\{[^}]*min-height:44px/);
  assert.match(html, /\.seg button\{[^}]*min-height:44px/);
  assert.match(html, /container-type:inline-size/);
  assert.ok(!html.includes('—'));
  assert.ok(!/gradient/.test(html));
});

test('gallery: saved looks appear in their own group and cannot shadow a built-in look', async () => {
  const looks = await listPresets();
  const mine = { ...looks[0], id: 'my-look', name: 'My look' };
  const dupe = { ...looks[1], name: 'Fake clean mono' };
  const html = renderGalleryHtml({ looks, saved: [mine, dupe] });
  assert.match(html, /Looks you saved/);
  assert.match(html, /data-copy="Shipyard: use the My look look"/);
  assert.ok(!html.includes('Fake clean mono'));
  assert.equal((html.match(/<article class="look /g) ?? []).length, 9);
});

test('gallery script: writes the file privately, honours --no-open and --app, exit codes', async () => {
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env: process.env });
  const r = run('--no-open', '--json');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.opened, false);
  assert.equal(out.path, path.join(process.env.SHIPYARD_HOME, 'design-gallery.html'));
  assert.match(await readFile(out.path, 'utf8'), /Pick a look/);
  if (process.platform !== 'win32') assert.equal((await stat(out.path)).mode & 0o777, 0o600);

  const appDir = path.join(tmp, 'app');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(appDir);
  await writeFile(path.join(appDir, '.shipyard-app.json'), JSON.stringify({ slug: 'my-app', name: 'My <App>', design: { id: 'playful' } }));
  const withApp = run('--app', appDir, '--no-open');
  assert.equal(withApp.status, 0);
  const html = await readFile(out.path, 'utf8');
  assert.match(html, /Pick a look for My &lt;App&gt;/);
  assert.match(html, /look for My &lt;App&gt;"/);
  assert.equal((html.match(/class="pill">In use</g) ?? []).length, 1);

  assert.equal(run('--app', path.join(tmp, 'missing'), '--no-open').status, 1);
  assert.equal(run('--bogus').status, 2);
  assert.equal(run('stray').status, 2);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--app/);
  const notApp = path.join(tmp, 'notapp');
  await mkdir(notApp);
  assert.equal(run('--app', notApp, '--no-open').status, 1);
  const w = await writeGallery({});
  assert.equal(w.path, out.path);
});

test('settings page shows each app\'s look with swatches, the default look and a change sentence', async () => {
  const profile = defaultProfile();
  profile.defaults.design = 'warm-friendly';
  profile.apps = [
    {
      slug: 'a', name: 'Alpha', layout: 'sidebar', modules: [], status: 'live', lastVerify: null,
      design: { id: 'editorial', name: 'Editorial', source: 'preset', swatches: { light: { background: '#faf7f0', accent: '#1d3f72' }, dark: { background: '#151310', accent: '#8fb2e8' } } },
    },
    { slug: 'b', name: 'Beta', layout: 'bottom-nav', modules: [], status: 'scaffolded', lastVerify: null },
    { slug: 'c', name: 'Gamma', modules: [], design: { id: 'x', name: '<b>Evil</b>', swatches: { light: { background: 'red;"onload="x', accent: '#123456' } } } },
  ];
  const looks = {
    'warm-friendly': { name: 'Warm and friendly', swatches: { light: { background: '#fbf4ea', accent: '#c24a24' }, dark: { background: '#1b1612', accent: '#f08a63' } } },
  };
  const html = renderSettingsHtml({ profile, keys: [], now: new Date(2026, 9, 16, 14, 3), looks });
  assert.match(html, /Warm and friendly/);
  assert.match(html, /fill="#c24a24"/);
  assert.match(html, /fill="#f08a63"/);
  assert.match(html, /Editorial/);
  assert.match(html, /fill="#1d3f72"/);
  assert.match(html, /fill="#8fb2e8"/);
  assert.match(html, /data-copy="Shipyard: change Alpha&#39;s look"/);
  assert.match(html, /data-copy="Shipyard: change Beta&#39;s look"/);
  assert.match(html, /Not chosen yet/);
  assert.ok(!html.includes('<b>Evil</b>'));
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
  assert.ok(!html.includes('onload="x'), 'a bad colour never reaches an attribute');
  assert.ok(!/ style="/.test(html));
  assert.ok(!/https?:\/\//.test(html), 'still no web addresses');
  // policy still matches
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1].replace(/&#39;/g, "'");
  assert.ok(csp.includes(`style-src ${sha(/<style>([\s\S]*?)<\/style>/.exec(html)[1])}`));
  // without a looks map the raw saved value is shown
  const plain = renderSettingsHtml({ profile, keys: [], now: new Date(), looks: {} });
  assert.match(plain, /warm-friendly/);
});

test('gallery --real: uses real screenshots when the renderer returns them, falls back with a plain message when it cannot', async () => {
  const looks = await listPresets();
  const shots = Object.fromEntries(looks.map((t) => [t.id, Object.fromEntries(REAL_VIEWS.map((v) => [v.name, `/tmp/shots/${t.id}-${v.name}.png`]))]));
  const html = renderGalleryHtml({ looks, appName: 'Recipe Box', shots });
  assert.equal((html.match(/<img class="on-light"/g) ?? []).length, 16, 'phone + computer per look');
  assert.equal((html.match(/<img class="on-dark"/g) ?? []).length, 16);
  assert.ok(html.includes('src="file:///tmp/shots/calm-blue-phone-light.png"'));
  assert.ok(!html.includes('class="rep rep-phone"'));
  assert.match(html, /real screenshots of your app/);
  assert.match(html, /Your app on a phone/);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /img-src file:/);
  assert.ok(!/ style="/.test(html));
  assert.ok(!renderGalleryHtml({ looks }).includes('img-src'), 'no image rule without screenshots');
  // a look without screenshots keeps its drawn picture
  const partial = renderGalleryHtml({ looks, shots: { 'calm-blue': shots['calm-blue'] } });
  assert.equal((partial.match(/class="rep rep-phone"/g) ?? []).length, 7);

  // the hook: what it asks the renderer for, and what it does with the answer
  let asked;
  const ok = await renderRealShots({
    appDir: '/x/app', looks: looks.slice(0, 2),
    importRenderer: async () => ({
      renderPreviews: async (args) => {
        asked = args;
        return args.items.flatMap((i) => args.views.map((v) => ({ id: i.id, view: v.name, png: `/p/${i.id}-${v.name}.png` })));
      },
    }),
  });
  assert.equal(ok.message, null);
  assert.equal(asked.appDir, '/x/app');
  assert.deepEqual(asked.items.map((i) => i.id), ['calm-blue', 'clean-mono']);
  assert.ok(asked.items[0].tokens.layout);
  assert.deepEqual(asked.views.map((v) => [v.name, v.width, v.height, v.theme]), [
    ['phone-light', 390, 800, 'light'], ['phone-dark', 390, 800, 'dark'], ['desktop-light', 1280, 800, 'light'], ['desktop-dark', 1280, 800, 'dark'],
  ]);
  assert.equal(ok.shots['calm-blue']['desktop-dark'], '/p/calm-blue-desktop-dark.png');

  const missing = await renderRealShots({ appDir: '/x', looks, importRenderer: async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); } });
  assert.deepEqual(missing.shots, {});
  assert.match(missing.message, /render-previews\.mjs\) is not installed/);
  const broken = await renderRealShots({ appDir: '/x', looks, importRenderer: async () => ({ renderPreviews: async () => { throw new Error('Run npm install in your app.\nmore'); } }) });
  assert.match(broken.message, /I could not take screenshots of your app \(Run npm install in your app\.\)/);
  const empty = await renderRealShots({ appDir: '/x', looks, importRenderer: async () => ({ renderPreviews: async () => [] }) });
  assert.match(empty.message, /No screenshots came back/);
  const wrong = await renderRealShots({ appDir: '/x', looks, importRenderer: async () => ({}) });
  assert.match(wrong.message, /not the expected one/);
});

test('gallery script: --real needs --app (exit 2); with a missing renderer it still writes the page and says why', async () => {
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env: process.env });
  assert.equal(run('--real', '--no-open').status, 2);
  assert.match(run('--help').stdout, /--real/);
  const appDir = path.join(tmp, 'real-app');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(appDir);
  await writeFile(path.join(appDir, '.shipyard-app.json'), JSON.stringify({ slug: 'real-app', name: 'Real App' }));
  const r = run('--app', appDir, '--real', '--no-open', '--json');
  // render-previews.mjs may or may not exist yet; either way the page is written
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(await readFile(path.join(process.env.SHIPYARD_HOME, 'design-gallery.html'), 'utf8'), /Pick a look for Real App/);
});
