// design-directions: reading and checking the three files, the "too alike" refusal, the page it writes
// (escaping, strict CSP, copy sentences) and the whole job with a fake renderer. No browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-directions-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts', 'design-directions.mjs');

const mod = await import('../scripts/design-directions.mjs');
const { loadDirections, compareDirections, renderDirectionsHtml, makeDirections, directionSentence, directionFile, DIRECTION_VIEWS, MAX_SHARED_DIMS } = mod;
const { loadPreset } = await import('../scripts/design/presets.mjs');
const { RenderError } = await import('../scripts/design/render-previews.mjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

async function preset(id, patch = {}) {
  const t = clone((await loadPreset(id)).tokens);
  return { ...t, ...patch };
}

/** three clearly different looks, built from presets (calm-blue, clean-mono, editorial) */
async function threeLooks() {
  return [
    await preset('calm-blue', { id: 'direction-one', name: 'First look' }),
    await preset('clean-mono', { id: 'direction-two', name: 'Second look' }),
    await preset('editorial', { id: 'direction-three', name: 'Third look' }),
  ];
}

async function makeApp(name, { looks } = {}) {
  const dir = path.join(tmp, name);
  await mkdir(path.join(dir, '.shipyard', 'design'), { recursive: true });
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug: name, name: `App <${name}> & "co"` }));
  const list = looks ?? (await threeLooks());
  for (const [i, key] of ['a', 'b', 'c'].entries()) {
    if (list[i]) await writeFile(directionFile(dir, key), JSON.stringify(list[i], null, 2));
  }
  return dir;
}

/** a fake renderer: writes tiny PNGs for every item and view */
function fakeRenderer(calls = []) {
  return async ({ appDir, items, views }) => {
    calls.push({ appDir, ids: items.map((i) => i.id), views: views.map((v) => v.name) });
    const out = [];
    for (const item of items) {
      for (const view of views) {
        const png = path.join(appDir, '.shipyard', 'design', `${item.id}-${view.name}.png`);
        await writeFile(png, PNG);
        out.push({ id: item.id, view: view.name, png });
      }
    }
    return out;
  };
}

test('three different looks load, validate and come back with every field filled in', async () => {
  const dir = await makeApp('ok-app');
  const r = await loadDirections(dir);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.deepEqual(r.directions.map((d) => d.key), ['a', 'b', 'c']);
  for (const d of r.directions) assert.ok(d.tokens.layout && d.tokens.type);
});

test('missing files: the message names them and points at the guide', async () => {
  const dir = await makeApp('missing-app', { looks: [await preset('calm-blue')] });
  const r = await loadDirections(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /direction-b\.tokens\.json, direction-c\.tokens\.json/);
  assert.match(r.problems[0], /directions/);
  const none = await loadDirections(await makeApp('none-app', { looks: [] }));
  assert.match(none.problems[0], /none of them exist yet/);
});

test('broken JSON and unusable looks are reported by direction', async () => {
  const dir = await makeApp('broken-app');
  await writeFile(directionFile(dir, 'b'), '{ nope');
  const bad = await preset('calm-blue', { id: 'x', name: 'Bad font' });
  bad.font = { body: 'Comic Sans', heading: 'same' };
  await writeFile(directionFile(dir, 'c'), JSON.stringify(bad));
  const r = await loadDirections(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /direction-b\.tokens\.json is not valid JSON/.test(p)));
  assert.ok(r.problems.some((p) => /Direction C has problems/.test(p) && /Comic Sans/.test(p)));
});

test('small readability problems are repaired, and the repaired look is what gets saved', async () => {
  const faint = await preset('calm-blue', { id: 'faint', name: 'Faint grey' });
  faint.light.muted = '#cccccc'; // far too light on the page
  const looks = [faint, await preset('clean-mono', { id: 'two', name: 'Two' }), await preset('editorial', { id: 'three', name: 'Three' })];
  const dir = await makeApp('fix-app', { looks });
  const r = await loadDirections(dir);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.ok(r.fixed.some((f) => /Direction A: made the grey text/.test(f)), r.fixed.join('|'));
  const saved = [];
  await makeDirections({ appDir: dir, renderer: async (o) => { saved.push(o); return fakeRenderer()(o); } });
  const onDisk = JSON.parse(await readFile(directionFile(dir, 'a'), 'utf8'));
  assert.notEqual(onDisk.light.muted, '#cccccc');
});

test('two directions that are too alike are refused, in plain words', async () => {
  const a = await preset('calm-blue', { id: 'a1', name: 'One' });
  const b = clone(a);
  b.id = 'b1';
  b.name = 'Two';
  b.light.accent = '#b45309';
  b.light.accentContrast = '#ffffff';
  const dir = await makeApp('alike-app', { looks: [a, b, await preset('editorial', { id: 'c1', name: 'Three' })] });
  const r = await loadDirections(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /Directions A and B are too alike/);
  assert.match(r.problems[0], /menu style/);
  assert.match(r.problems[0], /Make them more different/);
  const cmp = compareDirections(r.directions.length ? r.directions : []);
  assert.equal(Array.isArray(cmp.tooAlike), true);
});

test('sharing exactly 4 of the 7 dimensions is allowed, 5 is not', async () => {
  const base = await preset('calm-blue');
  const mk = (id, changes) => {
    const t = clone(base);
    t.id = id;
    t.name = id;
    t.layout = { ...t.layout, ...changes.layout };
    t.font = changes.font ?? t.font;
    t.type = { ...t.type, ...(changes.type ?? {}) };
    return t;
  };
  const a = mk('base-look', {});
  // changes menu, homepage and spacing: 3 changed, 4 shared
  const four = mk('four-shared', { layout: { nav: 'sidebar', home: 'list', density: 'compact' } });
  // changes only menu and homepage: 5 shared
  const five = mk('five-shared', { layout: { nav: 'top-nav', home: 'split' } });
  assert.equal(compareDirections([{ key: 'a', tokens: a }, { key: 'b', tokens: four }]).tooAlike.length, 0);
  const hit = compareDirections([{ key: 'a', tokens: a }, { key: 'b', tokens: five }]).tooAlike;
  assert.equal(hit.length, 1);
  assert.equal(hit[0].shared.length, 5);
  assert.equal(MAX_SHARED_DIMS, 4);
});

test('almost the same main colour on a similar page is a warning, not a refusal', async () => {
  const looks = await threeLooks();
  looks[1].light.background = looks[0].light.background;
  looks[1].light.accent = looks[0].light.accent;
  looks[1].light.accentContrast = looks[0].light.accentContrast;
  const dir = await makeApp('colour-app', { looks });
  const r = await loadDirections(dir);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /Directions A and B use almost the same main colour/.test(w)), r.warnings.join('|'));
});

test('directionSentence', () => {
  assert.equal(directionSentence('b', 'Fake Planner'), 'Shipyard: use direction B for Fake Planner');
  assert.equal(directionSentence('a', ''), 'Shipyard: use direction A');
});

async function pageFor(appName = 'My <App> & "Co"') {
  const looks = await threeLooks();
  const shots = Object.fromEntries(DIRECTION_VIEWS.map((v) => [v.name, `data:image/png;base64,${PNG.toString('base64')}`]));
  looks[0].name = 'First <look> & "name"';
  return renderDirectionsHtml({
    appName,
    directions: looks.map((t, i) => ({ key: 'abc'[i], tokens: clone(t), shots })),
    notes: ['Direction A: made the grey text a bit darker so it is readable.', 'a <script>alert(1)</script> note'],
  });
}

test('the page: three directions, copy sentences, light and dark pictures, everything escaped', async () => {
  const html = await pageFor();
  assert.equal((html.match(/<article class="dir"/g) ?? []).length, 3);
  assert.equal((html.match(/class="on-light"/g) ?? []).length, 6, 'a phone and a computer picture per direction');
  assert.equal((html.match(/class="on-dark"/g) ?? []).length, 6);
  for (const k of ['A', 'B', 'C']) {
    assert.ok(html.includes(`data-copy="Shipyard: use direction ${k} for My &lt;App&gt; &amp; &quot;Co&quot;"`), k);
    assert.ok(html.includes(`>Use direction ${k}</button>`), k);
  }
  assert.ok(!html.includes('<script>alert(1)'), 'notes are escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('First &lt;look&gt; &amp; &quot;name&quot;'));
  assert.ok(!html.includes('My <App>'));
  assert.match(html, /data-all-view="dark"/);
});

test('the page: strict content policy that matches the real style and script, no inline styles, no outside requests', async () => {
  const html = await pageFor();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)[1].replace(/&#39;/g, "'");
  assert.ok(csp.includes(`style-src ${sha(style)}`));
  assert.ok(csp.includes(`script-src ${sha(script)}`));
  assert.ok(csp.includes("default-src 'none'") && csp.includes('img-src data:'));
  assert.ok(!/ style="/.test(html), 'no inline style attributes');
  assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), 'the page makes no outside requests');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /prefers-color-scheme:dark/);
});

test('makeDirections: renders the 3 looks in 4 views, writes one self-contained page into the home folder', async () => {
  const dir = await makeApp('full-app');
  const calls = [];
  const r = await makeDirections({ appDir: dir, renderer: fakeRenderer(calls) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(calls[0].ids, ['direction-a', 'direction-b', 'direction-c']);
  assert.deepEqual(calls[0].views, ['phone-light', 'phone-dark', 'desktop-light', 'desktop-dark']);
  assert.equal(r.page, path.join(process.env.SHIPYARD_HOME, 'directions-full-app.html'));
  const html = await readFile(r.page, 'utf8');
  assert.match(html, /data:image\/png;base64,/);
  assert.ok(html.includes('Shipyard: use direction C for App &lt;full-app&gt; &amp; &quot;co&quot;'));
  assert.deepEqual(r.directions.map((d) => d.name), ['First look', 'Second look', 'Third look']);
  if (process.platform !== 'win32') assert.equal((await stat(r.page)).mode & 0o077, 0, 'private file');
});

test('makeDirections: a refused set never starts the renderer', async () => {
  const dir = await makeApp('refused-app', { looks: [await preset('calm-blue')] });
  let called = false;
  const r = await makeDirections({ appDir: dir, renderer: async () => { called = true; return []; } });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('makeDirections: a renderer failure becomes a plain message, not a crash', async () => {
  const dir = await makeApp('render-fail-app');
  const r = await makeDirections({ appDir: dir, renderer: async () => { throw new RenderError('Your app is already running. Stop it first.'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /already running/);
});

test('makeDirections: a missing screenshot means no page is written', async () => {
  const dir = await makeApp('partial-app');
  const partial = async (o) => (await fakeRenderer()(o)).filter((r) => !(r.id === 'direction-b' && r.view === 'phone-dark'));
  const r = await makeDirections({ appDir: dir, renderer: partial });
  assert.equal(r.ok, false);
  assert.match(r.error, /phone-dark.*direction B/);
});

test('CLI: --help works, no folder is a usage error, missing files exit 1 with --json', async () => {
  const env = { ...process.env, SHIPYARD_HOME: process.env.SHIPYARD_HOME };
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /direction-a\.tokens\.json/);
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
  assert.equal(usage.status, 2);
  const dir = await makeApp('cli-app', { looks: [] });
  const out = spawnSync(process.execPath, [SCRIPT, dir, '--json', '--no-open'], { encoding: 'utf8', env });
  assert.equal(out.status, 1);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /three design files/);
});
