import { privateWordsRegex } from './private-words.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-designmd-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { parseYaml, splitFrontMatter, px, resolveRef, extractColors, sections, stripHeader } = await import('../scripts/design/designmd/parse.mjs');
const { mapFont } = await import('../scripts/design/designmd/font-map.mjs');
const { draftFromDesignMd, findRoles } = await import('../scripts/design/designmd/draft.mjs');
const fetchMod = await import('../scripts/design/designmd/fetch.mjs');
const { importDesignMd, main, headerFor } = await import('../scripts/design-from-designmd.mjs');
const { validateTokens } = await import('../scripts/design/validate.mjs');
const { allowedFontNames } = await import('../scripts/design/fonts.mjs');

// ---- fixtures (invented, not from any real brand) ----
const LIGHT = `---
version: alpha
name: Acmeco-design-analysis
description: >
  A calm Acmeco style with generous whitespace.
colors:
  primary: "#0b6e4f"
  primary-hover: "#095a41"
  on-primary: "#ffffff"
  canvas: "#fbfaf7"
  surface: "#ffffff"
  ink: "#1b1f1d"
  ink-muted: "#5a625e"
  hairline: "#e6e3dc"
  hairline-strong: "#b9b5aa"
  semantic-error: "#b42318"
typography:
  display-xl:
    fontFamily: "Acme Display, Georgia, serif"
    fontSize: 56px
    fontWeight: 600
    letterSpacing: -1.4px
  body:
    fontFamily: "Acme Sans, system-ui, sans-serif"
    fontSize: 17px
    fontWeight: 400
rounded:
  sm: 4px
  md: 8px
  lg: 20px
  pill: 9999px
components:
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: 32px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
---

## Overview
An editorial feel for readers.

## Depth & Elevation
Cards sit on a hairline 1px border. No shadows.

## Layout
Container max-width 720px.

## Navigation
A sticky top nav with links.
`;

const DARK = `---
name: Nightco
colors:
  primary: "#7c8cff"
  on-primary: "#0a0a12"
  canvas: "#0a0a0c"
  surface-1: "#131316"
  ink: "#f2f3f5"
  ink-subtle: "#9aa0ab"
  hairline: "#26272c"
typography:
  body:
    fontFamily: Inter
    fontSize: 14px
---
## Depth
Soft shadow with blur on raised panels.
## Navigation
A fixed left sidebar.
`;

const TEXT_ONLY = `# Plain design notes

| Role | Value |
|---|---|
| Background | #ffffff |
| Card | #f4f5f7 |
| Text | #111827 |
| Muted text | #4b5563 |
| Border | #d1d5db |
| Primary | #d9480f |
`;

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- parse ----
test('parse: front matter, nested maps, folded text, quotes, references', () => {
  const { data, body, hasFrontMatter } = splitFrontMatter(LIGHT);
  assert.equal(hasFrontMatter, true);
  assert.equal(data.colors.primary, '#0b6e4f');
  assert.equal(data.typography['display-xl'].fontFamily, 'Acme Display, Georgia, serif');
  assert.match(data.description, /generous whitespace/);
  assert.equal(resolveRef(data, '{rounded.lg}'), '20px');
  assert.equal(resolveRef(data, '{rounded.nope}'), undefined);
  assert.match(body, /## Overview/);
  assert.equal(parseYaml('a:\n  b: 1\n  c:\n    d: "x y"\n').a.c.d, 'x y');
});

test('parse: px, header strip, files without front matter', () => {
  assert.equal(px('12px'), 12);
  assert.equal(px('1.5rem'), 24);
  assert.equal(px('9999px'), 9999);
  assert.equal(px('big'), null);
  const saved = `${headerFor({ source: 'x', github: true })}\n${DARK}`;
  assert.equal(stripHeader(saved).trimStart().startsWith('---'), true);
  assert.equal(splitFrontMatter(saved).data.colors.canvas, '#0a0a0c');
  assert.equal(splitFrontMatter('# hello').hasFrontMatter, false);
  assert.deepEqual(sections('## A\none\n### B\ntwo\n').map((s) => s.title), ['A', 'B']);
});

test('parse: colours from front matter, or from table and list lines', () => {
  assert.equal(extractColors(splitFrontMatter(LIGHT).data, '').colors.ink, '#1b1f1d');
  const t = extractColors({}, TEXT_ONLY);
  assert.equal(t.fromText, true);
  assert.equal(t.colors.background, '#ffffff');
  assert.equal(t.colors['muted-text'], '#4b5563');
  const list = extractColors({}, '- **Primary** (`#533AFD`) main\n- Page background: #FFF\n');
  assert.equal(list.colors.primary, '#533afd');
  assert.equal(list.colors['page-background'], '#ffffff');
});

// ---- fonts ----
test('fonts: exact names, hints and generic fallbacks all land on allowed fonts', () => {
  const allowed = allowedFontNames();
  assert.deepEqual(mapFont('Inter'), { name: 'Inter', exact: true, from: 'Inter' });
  assert.equal(mapFont('"DM Sans Variable", sans-serif').name, 'DM Sans');
  assert.equal(mapFont("sohne-var, 'SF Pro Display', system-ui").name, 'Inter');
  assert.equal(mapFont('Circular Std, Helvetica').name, 'DM Sans');
  assert.equal(mapFont('Tiempos Headline, Georgia, serif').name, 'Fraunces');
  assert.equal(mapFont('Acme Display, Georgia, serif').name, 'Source Serif 4');
  assert.equal(mapFont('Weird Brand, serif').name, 'Source Serif 4');
  assert.equal(mapFont('Weird Brand, sans-serif').name, 'Inter');
  assert.equal(mapFont('SF Mono, monospace').name, 'IBM Plex Sans');
  assert.equal(mapFont('system-ui, -apple-system').name, 'system');
  assert.equal(mapFont('').name, 'system');
  for (const s of ['Acme', 'Quicksand', 'Playfair Display', 'Open Sans', 'Geist']) assert.ok(allowed.includes(mapFont(s).name), s);
});

// ---- draft ----
test('draft: light-native file gives a valid, brand-free draft with layout hints', () => {
  const r = draftFromDesignMd(LIGHT);
  assert.deepEqual(r.errors, []);
  const t = r.tokens;
  assert.equal(validateTokens(t).ok, true);
  assert.equal(t.defaultTheme, 'light');
  assert.equal(t.light.accent, '#0b6e4f');
  assert.equal(t.light.background, '#fbfaf7');
  assert.equal(t.light.danger, '#b42318');
  assert.equal(t.font.body, 'Inter');
  assert.equal(t.font.heading, 'Source Serif 4');
  assert.equal(t.type.scale, 'large');
  assert.equal(t.type.headingTracking, 'tight');
  assert.equal(t.type.headingWeight, 600);
  assert.equal(t.radius.base, 20);
  assert.equal(t.layout.buttons, 'pill');
  assert.equal(t.layout.nav, 'top-nav');
  assert.equal(t.layout.home, 'editorial');
  assert.equal(t.layout.cards, 'bordered');
  assert.equal(t.layout.density, 'airy');
  assert.equal(t.layout.maxWidth, 'narrow');
  assert.equal(t.shadow, 'crisp');
  assert.match(t.id, /^[a-z][a-z0-9-]{1,40}$/);
  assert.ok(!/acme/i.test(JSON.stringify(t)), 'brand name leaked into the draft');
  assert.ok(r.guessed.some((g) => /dark colours/.test(g)));
});

test('draft: dark-native file becomes a dark default and gets a light set', () => {
  const r = draftFromDesignMd(DARK);
  assert.deepEqual(r.errors, []);
  assert.equal(r.tokens.defaultTheme, 'dark');
  assert.equal(r.tokens.dark.background, '#0a0a0c');
  assert.equal(r.tokens.dark.card, '#131316');
  assert.equal(r.tokens.font.body, 'Inter');
  assert.equal(r.tokens.layout.nav, 'sidebar');
  assert.equal(r.tokens.shadow, 'soft');
  assert.equal(r.tokens.layout.cards, 'elevated');
  assert.equal(validateTokens(r.tokens).ok, true);
  assert.ok(r.guessed.some((g) => /light colours/.test(g)));
  assert.ok(!/nightco/i.test(JSON.stringify(r.tokens)));
});

test('draft: a file with only a table of colours still works, and says what it guessed', () => {
  const r = draftFromDesignMd(TEXT_ONLY);
  assert.deepEqual(r.errors, []);
  assert.equal(r.tokens.light.accent, '#d9480f');
  assert.equal(r.tokens.font.body, 'system');
  assert.ok(r.guessed.includes('fonts'));
  assert.equal(validateTokens(r.tokens).ok, true);
});

test('draft: poor colours are repaired by autoFix and reported', () => {
  const bad = LIGHT.replace('"#5a625e"', '"#c9c9c9"');
  const r = draftFromDesignMd(bad);
  assert.equal(validateTokens(r.tokens).ok, true);
  assert.ok(r.tokens.light.muted !== '#c9c9c9');
});

test('draft: too little to go on is a plain error, not a crash', () => {
  const r = draftFromDesignMd('# Just words\nNothing here.');
  assert.equal(r.tokens, null);
  assert.match(r.errors[0], /could not find colours/);
});

test('draft: findRoles never picks hover or pressed shades as the accent', () => {
  const roles = findRoles({ 'primary-hover': '#111111', primary: '#2255cc', canvas: '#ffffff', ink: '#101010' });
  assert.equal(roles.accent.hex, '#2255cc');
});

// ---- fetch (fake fetch only) ----
const res = (body, { status = 200, url, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300, status, url, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => body,
});
const fake = (routes, calls = []) => async (url, opts) => {
  calls.push({ url, opts });
  for (const [re, handler] of routes) if (re.test(url)) return typeof handler === 'function' ? handler(url) : handler;
  return res('not found', { status: 404 });
};

test('fetch: --list uses the GitHub folder listing and keeps only folders with safe names', async () => {
  const calls = [];
  const f = fake([[/api\.github\.com/, res(JSON.stringify([
    { name: 'stripe', type: 'dir' }, { name: 'linear.app', type: 'dir' }, { name: 'README.md', type: 'file' }, { name: '../evil', type: 'dir' },
  ]))]], calls);
  const r = await fetchMod.listNames({ fetchImpl: f });
  assert.deepEqual(r.names, ['linear.app', 'stripe']);
  assert.equal(r.source, 'api');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].opts.signal, 'a timeout signal is used');
});

test('fetch: --list falls back to the README when the API is rate limited', async () => {
  const readme = '- [**One**](https://getdesign.md/one/design-md) - x\n- [**Two**](https://getdesign.md/two.app/design-md) - y\n- [other](https://example.com/z/design-md)';
  const f = fake([[/api\.github\.com/, res('{}', { status: 403 })], [/README\.md/, res(readme)]]);
  const r = await fetchMod.listNames({ fetchImpl: f });
  assert.deepEqual(r, { names: ['one', 'two.app'], source: 'readme' });
});

test('fetch: --list says so plainly when GitHub cannot be reached', async () => {
  await assert.rejects(fetchMod.listNames({ fetchImpl: async () => { throw new Error('offline'); } }), /could not reach GitHub/);
});

test('fetch: download by name uses the raw GitHub address, rejects odd names, reports 404', async () => {
  const calls = [];
  const f = fake([[/design-md\/good\/DESIGN\.md$/, res('hello')]], calls);
  const r = await fetchMod.downloadByName('Good', { fetchImpl: f });
  assert.equal(r.url, 'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/good/DESIGN.md');
  assert.equal(r.text, 'hello');
  for (const bad of ['../x', 'a/b', '', 'a b', '.hidden', 'x'.repeat(80), 'a..b']) {
    await assert.rejects(fetchMod.downloadByName(bad, { fetchImpl: f }), /not a name/, bad);
  }
  await assert.rejects(fetchMod.downloadByName('missing', { fetchImpl: f }), /no design called/);
  assert.equal(calls.length, 2);
});

test('fetch: files over 200 KB are refused, by header and by size', async () => {
  const big = 'a'.repeat(fetchMod.MAX_BYTES + 1);
  await assert.rejects(fetchMod.downloadByName('x', { fetchImpl: fake([[/./, res('a', { headers: { 'content-length': String(big.length) } })]]) }), /too big/);
  await assert.rejects(fetchMod.downloadByName('x', { fetchImpl: fake([[/./, res(big)]]) }), /too big/);
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(150 * 1024)); c.enqueue(new Uint8Array(150 * 1024)); c.close(); } });
  await assert.rejects(fetchMod.downloadByName('x', { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) }), /too big/);
});

test('fetch: a timeout becomes a plain message', async () => {
  const err = Object.assign(new Error('t'), { name: 'TimeoutError' });
  await assert.rejects(fetchMod.downloadByName('x', { fetchImpl: async () => { throw err; } }), /did not answer in 10 seconds/);
});

test('fetch: --url accepts only https GitHub file links and rewrites blob links', () => {
  const ok = (u) => fetchMod.safeRawUrl(u).url;
  assert.equal(ok('https://raw.githubusercontent.com/o/r/main/DESIGN.md'), 'https://raw.githubusercontent.com/o/r/main/DESIGN.md');
  assert.equal(ok('https://github.com/o/r/blob/main/a/DESIGN.md'), 'https://raw.githubusercontent.com/o/r/main/a/DESIGN.md');
  assert.equal(ok('https://getdesign.md/stripe/design-md'), 'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/stripe/DESIGN.md');
  for (const bad of [
    'http://raw.githubusercontent.com/o/r/main/DESIGN.md', 'https://example.com/DESIGN.md', 'https://github.com/o/r', 'ftp://x/y', 'nonsense',
    'https://user:pw@raw.githubusercontent.com/o/r/main/D.md', 'https://raw.githubusercontent.com:8443/o/r/main/D.md', 'https://evil.com/raw.githubusercontent.com/x',
    'https://raw.githubusercontent.com.evil.com/x', 'https://getdesign.md/other',
  ]) assert.throws(() => fetchMod.safeRawUrl(bad), fetchMod.DesignMdError, bad);
});

test('fetch: a redirect to another host is refused', async () => {
  const f = async () => res('x', { url: 'https://evil.example/x' });
  await assert.rejects(fetchMod.downloadByUrl('https://raw.githubusercontent.com/o/r/main/D.md', { fetchImpl: f }), /somewhere else/);
});

test('fetch: suggestions for a misspelt name', () => {
  assert.deepEqual(fetchMod.suggestNames('strip', ['stripe', 'notion', 'strap']), ['stripe']);
  assert.deepEqual(fetchMod.suggestNames('zzz', ['a']), []);
});

// ---- end to end into a temp app ----
async function makeApp(extra = {}) {
  const dir = await mkdtemp(path.join(tmp, 'app-'));
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug: 'demo', name: 'Demo', layout: 'bottom-nav', ...extra }));
  return dir;
}

test('import --name: saves the file with a header and the draft, from a fake GitHub', async () => {
  const app = await makeApp();
  const f = fake([[/design-md\/acme\/DESIGN\.md$/, res(LIGHT)]]);
  const r = await importDesignMd({ appDir: app, name: 'acme', fetchImpl: f });
  assert.equal(r.ok, true);
  const saved = await readFile(path.join(app, 'design-input', 'acme.DESIGN.md'), 'utf8');
  assert.match(saved, /^<!-- Imported by Shipyard\./);
  assert.match(saved, /Source: https:\/\/raw\.githubusercontent\.com\/VoltAgent\/awesome-design-md/);
  assert.match(saved, /MIT licence, VoltAgent\/awesome-design-md/);
  assert.match(saved, /Style reference only, no brand assets|Style reference only: no brand assets/);
  const draft = JSON.parse(await readFile(path.join(app, '.shipyard', 'design', 'designmd-draft.tokens.json'), 'utf8'));
  assert.equal(draft.id, r.tokensId);
  assert.equal(validateTokens(draft).ok, true);
  assert.equal(r.summary.length, 4);
  // a second run gives the same files (header is not stacked)
  await importDesignMd({ appDir: app, name: 'acme', fetchImpl: f });
  const again = await readFile(path.join(app, 'design-input', 'acme.DESIGN.md'), 'utf8');
  assert.equal(again, saved);
  assert.equal((again.match(/Imported by Shipyard/g) ?? []).length, 1);
});

test('import --name: a typo offers close names', async () => {
  const app = await makeApp();
  const f = fake([[/api\.github\.com/, res(JSON.stringify([{ name: 'acme', type: 'dir' }, { name: 'zeta', type: 'dir' }]))]]);
  await assert.rejects(importDesignMd({ appDir: app, name: 'acm', fetchImpl: f }), /Did you mean: acme/);
});

test('import --file: copies into design-input with no MIT claim; same-folder file is not copied onto itself', async () => {
  const app = await makeApp();
  const src = path.join(tmp, 'my-style.DESIGN.md');
  await writeFile(src, DARK);
  const r = await importDesignMd({ appDir: app, file: src });
  assert.equal(r.ok, true);
  const saved = await readFile(path.join(app, 'design-input', 'my-style.DESIGN.md'), 'utf8');
  assert.ok(!/MIT licence/.test(saved));
  assert.match(saved, /Source: .*my-style\.DESIGN\.md/);
  const inside = path.join(app, 'design-input', 'own.DESIGN.md');
  await writeFile(inside, TEXT_ONLY);
  const r2 = await importDesignMd({ appDir: app, file: inside });
  assert.equal(r2.saved, inside);
  assert.equal(await readFile(inside, 'utf8'), TEXT_ONLY);
  await assert.rejects(importDesignMd({ appDir: app, file: path.join(tmp, 'nope.md') }), /cannot find the file/);
});

test('import: a file with no colours fails with a plain message and writes no draft', async () => {
  const app = await makeApp();
  const f = fake([[/DESIGN\.md$/, res('# Nothing')]]);
  await assert.rejects(importDesignMd({ appDir: app, url: 'https://raw.githubusercontent.com/o/r/main/DESIGN.md', fetchImpl: f }), /could not find colours/);
  await assert.rejects(readFile(path.join(app, '.shipyard', 'design', 'designmd-draft.tokens.json')));
});

test('import: needs a Shipyard app folder', async () => {
  const dir = await mkdtemp(path.join(tmp, 'plain-'));
  await assert.rejects(importDesignMd({ appDir: dir, name: 'x', fetchImpl: fake([]) }), /not made by Shipyard/);
});

// ---- CLI ----
const run = (args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'design-from-designmd.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'home') } });

test('cli: --help works, and wrong options exit 2 without touching the network', async () => {
  const h = run(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--list/);
  assert.equal(run([]).status, 2);
  assert.equal(run(['--list', '--name', 'x']).status, 2);
  const app = await makeApp();
  const noApp = run(['--name', 'x']);
  assert.equal(noApp.status, 2);
  assert.match(noApp.stdout, /--app/);
  const j = run(['--file', path.join(tmp, 'missing.md'), '--app', app, '--json']);
  assert.equal(j.status, 1);
  assert.equal(JSON.parse(j.stdout).ok, false);
});

test('cli: --file with --json prints the summary and the next step', async () => {
  const app = await makeApp();
  const src = path.join(tmp, 'cli-style.DESIGN.md');
  await writeFile(src, LIGHT);
  const r = run(['--file', src, '--app', app, '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'file');
  assert.match(out.next, /apply-design\.mjs/);
  assert.match(out.next, /--source design-md/);
});

test('main: --list goes through listNames (checked with a stubbed global fetch)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = fake([[/api\.github\.com/, res(JSON.stringify([{ name: 'a1', type: 'dir' }, { name: 'b2', type: 'dir' }]))]]);
  try {
    const r = await main({ _: [], list: true });
    assert.deepEqual(r.names, ['a1', 'b2']);
    assert.equal(r.ok, true);
  } finally {
    globalThis.fetch = real;
  }
});

test('shipped files carry no private names', async (t) => {
  const bad = privateWordsRegex();
  if (!bad) return t.skip('no .private-words.txt here');
  const files = [
    'scripts/design-from-designmd.mjs', 'scripts/design/designmd/fetch.mjs', 'scripts/design/designmd/parse.mjs',
    'scripts/design/designmd/draft.mjs', 'scripts/design/designmd/font-map.mjs',
  ];
  for (const f of files) {
    const text = await readFile(path.join(root, f), 'utf8');
    assert.ok(!bad.test(text), f);
  }
});

// ---- review fixes ----
test('import --url: only a file from VoltAgent/awesome-design-md gets the MIT line; other repos get "check the licence"', async () => {
  const app = await makeApp();
  const other = fake([[/raw\.githubusercontent\.com\/someone\/else/, res(LIGHT)]]);
  await importDesignMd({ appDir: app, url: 'https://raw.githubusercontent.com/someone/else/main/DESIGN.md', fetchImpl: other });
  const [only] = await readdir(path.join(app, 'design-input'));
  const saved = await readFile(path.join(app, 'design-input', only), 'utf8');
  assert.doesNotMatch(saved, /MIT licence/);
  assert.match(saved, /Check the licence of this file before sharing it\./);
  const app2 = await makeApp();
  const own = fake([[/VoltAgent\/awesome-design-md\/main\/design-md\/acme\/DESIGN\.md/, res(LIGHT)]]);
  await importDesignMd({ appDir: app2, url: 'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/acme/DESIGN.md', fetchImpl: own });
  assert.match(await readFile(path.join(app2, 'design-input', 'acme.DESIGN.md'), 'utf8'), /MIT licence, VoltAgent\/awesome-design-md/);
});

test('import: warns when design-input/ is not in the app\'s .gitignore', async () => {
  const app = await makeApp();
  const f = fake([[/design-md\/acme\/DESIGN\.md$/, res(LIGHT)]]);
  assert.match((await importDesignMd({ appDir: app, name: 'acme', fetchImpl: f })).gitignoreWarning, /design-input\//);
  await writeFile(path.join(app, '.gitignore'), '.shipyard/\n/design-input/\n');
  assert.equal((await importDesignMd({ appDir: app, name: 'acme', fetchImpl: f })).gitignoreWarning, null);
});

test('fetch: a redirect off GitHub is refused before any request goes there; GitHub-to-GitHub redirects are followed', async () => {
  const calls = [];
  const off = async (url) => {
    calls.push(url);
    return res('', { status: 302, headers: { location: 'https://evil.example/x' } });
  };
  await assert.rejects(fetchMod.downloadByUrl('https://raw.githubusercontent.com/o/r/main/D.md', { fetchImpl: off }), /somewhere else/);
  assert.deepEqual(calls, ['https://raw.githubusercontent.com/o/r/main/D.md'], 'the other host was never asked');
  const hop = async (url) => (url.includes('/o/r/') ? res('', { status: 301, headers: { location: 'https://raw.githubusercontent.com/o/moved/main/D.md' } }) : res('hello'));
  assert.equal((await fetchMod.downloadByUrl('https://raw.githubusercontent.com/o/r/main/D.md', { fetchImpl: hop })).text, 'hello');
  const loop = async () => res('', { status: 302, headers: { location: 'https://raw.githubusercontent.com/o/r/main/D.md' } });
  await assert.rejects(fetchMod.downloadByUrl('https://raw.githubusercontent.com/o/r/main/D.md', { fetchImpl: loop }), /circles/);
});
