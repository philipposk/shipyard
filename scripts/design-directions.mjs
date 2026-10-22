#!/usr/bin/env node
// "3 directions for my homepage": the coding agent drafts three genuinely different looks for THIS app
// (direction-a/b/c.tokens.json). This script checks them, takes real screenshots of the app in each look
// (phone light, phone dark, computer light, computer dark) and writes one page with the three side by
// side and a "Use direction B" button that copies a sentence to paste into Claude.
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { runCli, isMain, resolveAppDir, readAppConfig } from './provision/common.mjs';
import { HOME_DIR, ensureHomeDir } from './lib/paths.mjs';
import * as log from './lib/log.mjs';
import { loadProfile } from './lib/profile.mjs';
import { validateTokens, autoFix } from './design/validate.mjs';
import { isObject, normalizeTokens, sharedDims, withDefaults } from './design/tokens.mjs';
import { hexToHsl } from './design/color.mjs';
import { lookFacts } from './design/replica.mjs';
import { homeContentWarning } from './design/home-content.mjs';
import { renderPreviews, RenderError } from './design/render-previews.mjs';
import { BrowserError } from './design/capture/browser.mjs';
import { esc, openInBrowser } from './settings-page.mjs';
import { agentName, agentNameStart, currentAgent } from './lib/agent.mjs';

export const DIRECTION_KEYS = ['a', 'b', 'c'];
/** Two directions may share at most this many of the 7 look dimensions (menu, homepage, cards, buttons, spacing, text size, font). */
export const MAX_SHARED_DIMS = 4;
const MAX_TOKEN_FILE = 256 * 1024;

export const DIRECTION_VIEWS = [
  { name: 'phone-light', width: 390, height: 800, theme: 'light' },
  { name: 'phone-dark', width: 390, height: 800, theme: 'dark' },
  { name: 'desktop-light', width: 1280, height: 800, theme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 800, theme: 'dark' },
];

const helpText = () => `
Show three different looks for your own app, side by side, as real screenshots.

Usage:
  node design-directions.mjs <app-folder> [--no-open] [--json]

Before you run it, three design files must exist in <app-folder>/.shipyard/design/:
  direction-a.tokens.json, direction-b.tokens.json, direction-c.tokens.json
(${agentNameStart()} writes them for you. They must be clearly different from each other.)

It checks each file (and repairs small readability problems), takes screenshots of your app in each look
(this starts your app in preview mode for a minute and stops it again), and writes
~/.shipyard/directions-<app>.html, then opens it. Pick one with the "Use direction" button.
Your app needs npm install to have been run first.

  --no-open   write the page but do not open it
  --json      print the result as JSON
  --help      show this text

Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

// ---------- reading and checking the three files ----------

export const directionFile = (appDir, key) => path.join(appDir, '.shipyard', 'design', `direction-${key}.tokens.json`);

async function readTokenFile(file, label) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return { missing: true };
  }
  if (!info.isFile() || info.size > MAX_TOKEN_FILE) return { error: `${label} is not a design file (it is not a file, or it is too big).` };
  try {
    const parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
    if (!isObject(parsed)) throw new Error('not an object');
    return { tokens: normalizeTokens(parsed) };
  } catch {
    return { error: `${label} is not valid JSON, so I cannot read it.` };
  }
}

async function pickLanguages(appDir, config) {
  const clean = (list) => (Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z]{2,3}([-_][a-z0-9]+)?$/.test(x)) : []);
  const fromApp = clean(config.languages);
  if (fromApp.length > 0) return fromApp;
  let profile = null;
  try {
    profile = await loadProfile();
  } catch {
    profile = null;
  }
  const fromProfile = clean(profile?.owner?.languages);
  return fromProfile.length > 0 ? fromProfile : ['en'];
}

/**
 * Check the three looks as a set.
 * -> { tooAlike: [{ a, b, shared: [dimension names] }], similarColour: [{ a, b }] }
 * `list` is [{ key, tokens }].
 */
export function compareDirections(list) {
  const tooAlike = [];
  const similarColour = [];
  const dflt = (t) => (t.defaultTheme === 'dark' ? t.dark : t.light);
  const hue = (hex) => {
    const { h, s, l } = hexToHsl(hex);
    return { h, s, l };
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const shared = sharedDims(list[i].tokens, list[j].tokens);
      if (shared.length > MAX_SHARED_DIMS) tooAlike.push({ a: list[i].key, b: list[j].key, shared });
      try {
        const x = hue(dflt(list[i].tokens).accent);
        const y = hue(dflt(list[j].tokens).accent);
        const dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
        const bothColourful = x.s > 0.2 && y.s > 0.2;
        const sameLight = Math.abs(hexToHsl(dflt(list[i].tokens).background).l - hexToHsl(dflt(list[j].tokens).background).l) < 0.1;
        if (sameLight && ((bothColourful && dh < 20) || (!bothColourful && Math.abs(x.l - y.l) < 0.1 && x.s < 0.2 && y.s < 0.2))) {
          similarColour.push({ a: list[i].key, b: list[j].key });
        }
      } catch {
        // colour problems are reported by validateTokens
      }
    }
  }
  return { tooAlike, similarColour };
}

const DIM_WORDS = { nav: 'menu style', home: 'homepage style', cards: 'card style', buttons: 'button style', density: 'spacing', scale: 'text size', font: 'font' };
const dimList = (dims) => dims.map((d) => DIM_WORDS[d] ?? d).join(', ');

/**
 * Read, check and repair the three files. Returns { ok, directions, problems, fixed, warnings }.
 * `directions` is [{ key, file, tokens, changes }] (tokens are the repaired ones).
 */
export async function loadDirections(appDir, { languages = ['en'] } = {}) {
  const problems = [];
  const fixed = [];
  const warnings = [];
  const directions = [];
  const missing = [];
  for (const key of DIRECTION_KEYS) {
    const file = directionFile(appDir, key);
    const label = `direction-${key}.tokens.json`;
    const r = await readTokenFile(file, label);
    if (r.missing) {
      missing.push(label);
      continue;
    }
    if (r.error) {
      problems.push(r.error);
      continue;
    }
    let tokens = r.tokens;
    let result = validateTokens(tokens, { languages });
    let changes = [];
    if (!result.ok) {
      const repaired = autoFix(tokens);
      changes = repaired.changes;
      tokens = repaired.tokens;
      result = validateTokens(tokens, { languages });
    }
    if (!result.ok) {
      problems.push(`Direction ${key.toUpperCase()} has problems:\n  - ${result.errors.join('\n  - ')}`);
      continue;
    }
    for (const c of changes) fixed.push(`Direction ${key.toUpperCase()}: ${c}.`);
    for (const w of result.warnings) warnings.push(`Direction ${key.toUpperCase()}: ${w}`);
    directions.push({ key, file, label, tokens: withDefaults(tokens), changes });
  }
  if (missing.length > 0) {
    problems.unshift(`I need three design files in .shipyard/design/ inside the app, and ${missing.length === 3 ? 'none of them exist yet' : `these are missing: ${missing.join(', ')}`}. Ask ${agentName()} to draft them (the design skill has a short guide called directions).`);
  }
  if (problems.length === 0) {
    const { tooAlike, similarColour } = compareDirections(directions);
    for (const t of tooAlike) {
      problems.push(`Directions ${t.a.toUpperCase()} and ${t.b.toUpperCase()} are too alike (they share the same ${dimList(t.shared)}). Make them more different: change at least ${t.shared.length - MAX_SHARED_DIMS} of those so the two feel like different apps.`);
    }
    for (const s of similarColour) warnings.push(`Directions ${s.a.toUpperCase()} and ${s.b.toUpperCase()} use almost the same main colour on a similar background. Different colours make the choice easier.`);
    const names = new Map();
    for (const d of directions) {
      const n = String(d.tokens.name).trim().toLowerCase();
      if (names.has(n)) warnings.push(`Directions ${names.get(n).toUpperCase()} and ${d.key.toUpperCase()} have the same name. Give each its own name so you can tell them apart.`);
      names.set(n, d.key);
    }
  }
  return { ok: problems.length === 0, directions, problems, fixed, warnings };
}

// ---------- the page ----------

const PAGE_CSS = `
:root{--pg-bg:#f6f7f9;--pg-fg:#14161a;--pg-card:#ffffff;--pg-muted:#5b6270;--pg-line:#e3e6eb;--pg-line-strong:#b9bfca;--pg-accent:#1f2937;--pg-accent-contrast:#ffffff;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--pg-bg:#0e1116;--pg-fg:#eceff4;--pg-card:#171b22;--pg-muted:#9aa3b2;--pg-line:#262c36;--pg-line-strong:#3a4250;--pg-accent:#eceff4;--pg-accent-contrast:#0e1116}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--pg-bg);color:var(--pg-fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:1320px;margin:0 auto;padding:24px 16px 96px}
h1{font-size:1.75rem;line-height:1.2;margin:0}
h2{font-size:1.25rem;line-height:1.25;margin:0}
p{margin:0}
.top{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between}
.lead{color:var(--pg-muted);margin-top:8px;max-width:62ch}
.dirs{display:grid;gap:24px;margin-top:24px;grid-template-columns:minmax(0,1fr)}
.dir{background:var(--pg-card);border:1px solid var(--pg-line);border-radius:16px;padding:16px;display:grid;gap:16px;align-content:start;grid-template-columns:minmax(0,1fr)}
.tag{display:inline-block;font-size:.8125rem;font-weight:700;padding:2px 10px;border-radius:999px;background:var(--pg-line);margin-bottom:8px}
.dir-desc{color:var(--pg-muted);margin-top:4px}
.facts{margin:0;display:grid;gap:6px;font-size:.875rem}
.facts div{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px}
.facts dt{color:var(--pg-muted)}
.facts dd{margin:0;font-weight:600}
.swatch-row{display:flex;gap:6px;align-items:center}
.sw{width:22px;height:22px;border-radius:50%;border:1px solid var(--pg-line-strong);display:inline-block}
.btn{font:inherit;font-weight:600;min-height:44px;min-width:44px;padding:0 18px;border-radius:10px;border:1px solid var(--pg-accent);background:var(--pg-accent);color:var(--pg-accent-contrast);cursor:pointer}
.btn:hover{filter:brightness(1.12)}
.btn:focus-visible,.seg button:focus-visible{outline:3px solid var(--pg-fg);outline-offset:2px}
.foot{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--pg-line-strong);border-radius:10px;overflow:hidden}
.seg button{font:inherit;font-size:.875rem;font-weight:600;min-height:44px;min-width:64px;padding:0 14px;border:0;background:transparent;color:var(--pg-fg);cursor:pointer}
.seg button+button{border-left:1px solid var(--pg-line-strong)}
.seg button[aria-pressed="true"]{background:var(--pg-fg);color:var(--pg-bg)}
.shots{display:grid;gap:12px;grid-template-columns:minmax(0,1fr)}
.fig{margin:0;display:grid;gap:6px;min-width:0}
.fig figcaption{font-size:.8125rem;color:var(--pg-muted);font-weight:600}
.frame{border:1px solid var(--pg-line-strong);background:var(--pg-line);overflow:hidden;line-height:0}
.frame img{display:block;width:100%;height:auto}
.frame-phone{border-radius:22px;border-width:4px;max-width:260px;margin:0 auto;width:100%}
.frame-desk{border-radius:10px}
.dir[data-view="light"] .on-dark,.dir[data-view="dark"] .on-light{display:none}
.notes{margin:24px 0 0;padding:0;list-style:none;display:grid;gap:8px;color:var(--pg-muted);font-size:.875rem}
#toast{position:fixed;left:50%;bottom:20px;transform:translate(-50%,16px);max-width:calc(100vw - 32px);padding:12px 16px;border-radius:10px;background:var(--pg-fg);color:var(--pg-bg);font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;overflow-wrap:anywhere}
#toast.show{opacity:1;transform:translate(-50%,0)}
.offscreen{position:fixed;left:-9999px;top:0}
@media (min-width:1000px){.dirs{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (prefers-reduced-motion:reduce){#toast{transition:none}}
`;

const script = (agent) => `
(function () {
  var toast = document.getElementById('toast');
  var timer;
  function show(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function () { toast.classList.remove('show'); }, 3500);
  }
  function legacyCopy(value) {
    var box = document.createElement('textarea');
    box.value = value;
    box.setAttribute('readonly', '');
    box.className = 'offscreen';
    document.body.appendChild(box);
    box.select();
    var done = false;
    try { done = document.execCommand('copy'); } catch (e) { done = false; }
    document.body.removeChild(box);
    return done;
  }
  function setView(card, view) {
    card.setAttribute('data-view', view);
    var buttons = card.querySelectorAll('[data-view-btn]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-view-btn') === view ? 'true' : 'false');
    }
  }
  document.addEventListener('click', function (event) {
    var all = event.target.closest('[data-all-view]');
    if (all) {
      var view = all.getAttribute('data-all-view');
      var cards = document.querySelectorAll('.dir');
      for (var i = 0; i < cards.length; i++) setView(cards[i], view);
      var globals = document.querySelectorAll('[data-all-view]');
      for (var j = 0; j < globals.length; j++) globals[j].setAttribute('aria-pressed', globals[j] === all ? 'true' : 'false');
      return;
    }
    var one = event.target.closest('[data-view-btn]');
    if (one) {
      setView(one.closest('.dir'), one.getAttribute('data-view-btn'));
      return;
    }
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var value = button.getAttribute('data-copy');
    function finish(copied) {
      show(copied ? 'Copied, paste it into ${agentName(agent)}' : 'Could not copy. Select and copy this: ' + value);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { finish(true); }, function () { finish(legacyCopy(value)); });
    } else {
      finish(legacyCopy(value));
    }
  });
})();
`;

const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/** The sentence the "Use direction" button copies. */
export const directionSentence = (key, appName) => `Shipyard: use direction ${key.toUpperCase()}${appName ? ` for ${appName}` : ''}`;

function pictures(d, kind, appName) {
  const t = d.tokens;
  const light = d.shots?.[`${kind}-light`];
  const dark = d.shots?.[`${kind}-dark`];
  const alt = (mode) => `Direction ${d.key.toUpperCase()}, ${t.name}: ${appName || 'your app'} on ${kind === 'phone' ? 'a phone' : 'a computer'}, ${mode}`;
  return `<img class="on-light" src="${esc(light)}" alt="${esc(alt('light'))}"><img class="on-dark" src="${esc(dark)}" alt="${esc(alt('dark'))}">`;
}

function card(d, appName) {
  const t = d.tokens;
  const dflt = t.defaultTheme === 'dark' ? 'dark' : 'light';
  const facts = lookFacts(t).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const swatches = [t.light.background, t.light.accent, t.dark.background, t.dark.accent]
    .map((c) => `<span class="sw" role="img" aria-label="${esc(c)}" data-c="${esc(c)}"></span>`).join('');
  const sentence = directionSentence(d.key, appName);
  const seg = ['light', 'dark'].map((v) => `<button type="button" data-view-btn="${v}" aria-pressed="${v === dflt}">${v === 'light' ? 'Light' : 'Dark'}</button>`).join('');
  return `<article class="dir" data-view="${dflt}" aria-labelledby="dir-${d.key}">
<div>
<span class="tag">Direction ${esc(d.key.toUpperCase())}</span>
<h2 id="dir-${d.key}">${esc(t.name)}</h2>
<p class="dir-desc">${esc(t.description ?? t.goodFor ?? '')}</p>
</div>
<figure class="fig"><div class="frame frame-desk">${pictures(d, 'desktop', appName)}</div><figcaption>On a computer</figcaption></figure>
<figure class="fig"><div class="frame frame-phone">${pictures(d, 'phone', appName)}</div><figcaption>On a phone</figcaption></figure>
<dl class="facts">${facts}</dl>
<div class="foot"><div class="seg" role="group" aria-label="Show direction ${esc(d.key.toUpperCase())} in">${seg}</div><button type="button" class="btn" data-copy="${esc(sentence)}" aria-label="${esc(`Use direction ${d.key.toUpperCase()}`)}">Use direction ${esc(d.key.toUpperCase())}</button></div>
<div class="swatch-row" aria-label="Main colours">${swatches}</div>
</article>`;
}

/**
 * Build the page. Pure. `directions` is [{ key, tokens, shots: { "phone-light": "data:image/png;base64,...", ... } }].
 * The swatch colours are written as CSS rules (no inline style attributes, so the page can run under a strict CSP).
 */
export function renderDirectionsHtml({ appName = '', directions = [], notes = [], agent = currentAgent() } = {}) {
  const js = script(agent);
  const colours = [...new Set(directions.flatMap((d) => [d.tokens.light.background, d.tokens.light.accent, d.tokens.dark.background, d.tokens.dark.accent]))]
    .filter((c) => /^#[0-9a-f]{6}$/.test(c));
  const swatchCss = colours.map((c) => `.sw[data-c="${c}"]{background:${c}}`).join('\n');
  const style = `${PAGE_CSS}${swatchCss}\n`;
  const csp = ["default-src 'none'", `style-src ${sha(style)}`, 'img-src data:', `script-src ${sha(js)}`].join('; ');
  const heading = appName ? `Three directions for ${esc(appName)}` : 'Three directions';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<title>Shipyard directions</title>
<style>${style}</style>
</head>
<body>
<main>
<div class="top">
<div>
<h1>${heading}</h1>
<p class="lead">These are real screenshots of your own app in three different looks. Pick the one that feels right, press its button, then paste the sentence into ${agentName(agent)}.</p>
</div>
<div class="seg" role="group" aria-label="Show all in"><button type="button" data-all-view="light" aria-pressed="false">All light</button><button type="button" data-all-view="dark" aria-pressed="false">All dark</button></div>
</div>
<div class="dirs">
${directions.map((d) => card(d, appName)).join('\n')}
</div>
${notes.length > 0 ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>${js}</script>
</body>
</html>
`;
}

// ---------- the whole job ----------

const slugOf = (s) => String(s ?? 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
export const directionsPagePath = (slug) => path.join(HOME_DIR, `directions-${slugOf(slug)}.html`);

async function writeAtomic(file, text, mode = 0o644) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * makeDirections({ appDir, renderer, onProgress }) ->
 *   { ok, page, directions: [{ key, id, name }], fixed, warnings } or { ok: false, error, problems }
 * `renderer` is renderPreviews (a fake one in tests).
 */
export async function makeDirections({ appDir, renderer = renderPreviews, onProgress = () => {} }) {
  const config = await readAppConfig(appDir);
  const languages = await pickLanguages(appDir, config);
  const loaded = await loadDirections(appDir, { languages });
  const homeWarning = await homeContentWarning(appDir);
  if (homeWarning) loaded.warnings.push(homeWarning);
  if (!loaded.ok) {
    return { ok: false, error: loaded.problems.join('\n'), problems: loaded.problems, fixed: loaded.fixed, warnings: loaded.warnings };
  }
  // keep the repaired versions, so "use direction B" applies exactly what the screenshot shows
  for (const d of loaded.directions) {
    if (d.changes.length > 0) await writeAtomic(d.file, `${JSON.stringify(d.tokens, null, 2)}\n`);
  }

  let rendered;
  try {
    rendered = await renderer({
      appDir,
      items: loaded.directions.map((d) => ({ id: `direction-${d.key}`, tokens: d.tokens })),
      views: DIRECTION_VIEWS,
      onProgress,
    });
  } catch (err) {
    if (err instanceof RenderError || err instanceof BrowserError) {
      return { ok: false, error: err.message, problems: [err.message], fixed: loaded.fixed, warnings: loaded.warnings };
    }
    throw err;
  }

  const shots = {};
  for (const r of rendered ?? []) {
    const png = await readFile(r.png);
    (shots[r.id] ??= {})[r.view] = `data:image/png;base64,${png.toString('base64')}`;
  }
  for (const d of loaded.directions) {
    const s = shots[`direction-${d.key}`] ?? {};
    for (const v of DIRECTION_VIEWS) {
      if (!s[v.name]) return { ok: false, error: `The screenshot "${v.name}" for direction ${d.key.toUpperCase()} is missing, so I did not write the page.`, problems: [], fixed: loaded.fixed, warnings: loaded.warnings };
    }
    d.shots = s;
  }

  const appName = String(config.name ?? config.slug ?? '');
  const html = renderDirectionsHtml({
    appName,
    directions: loaded.directions,
    notes: [...loaded.fixed, ...loaded.warnings],
  });
  await ensureHomeDir();
  const page = directionsPagePath(config.slug);
  await writeAtomic(page, html, 0o600);
  return {
    ok: true,
    page,
    app: appName,
    directions: loaded.directions.map((d) => ({ key: d.key, id: d.tokens.id, name: d.tokens.name, summary: lookFacts(d.tokens).map(([k, v]) => `${k}: ${v}`).join('; ') })),
    fixed: loaded.fixed,
    warnings: loaded.warnings,
  };
}

export async function main(args) {
  if (args._.length !== 1) {
    throw new log.UsageError('Give the app folder, for example: node design-directions.mjs ./my-app');
  }
  const appDir = await resolveAppDir(args._[0]);
  log.info('Checking your three directions, then taking screenshots of your app in each. This takes about a minute.');
  const r = await makeDirections({ appDir, onProgress: (m) => log.info(m) });
  if (!r.ok) {
    for (const p of r.problems?.length ? r.problems : [r.error]) log.fail(p);
    return { ok: false, error: r.error, problems: r.problems ?? [] };
  }
  for (const f of r.fixed) log.warn(`Fixed: ${f}`);
  for (const w of r.warnings) log.warn(w);
  const opened = args['no-open'] ? false : await openInBrowser(r.page);
  log.ok(`Directions page ready: ${r.page}`);
  for (const d of r.directions) log.info(`Direction ${d.key.toUpperCase()}: ${d.name} (${d.summary})`);
  if (opened) log.info('It should open in your browser now.');
  else if (args['no-open']) log.info('Open that file in your browser to see it.');
  else log.warn('Could not open your browser automatically. Open that file yourself.');
  log.info(`Press "Use direction A/B/C" on the page and paste the sentence into ${agentName()}.`);
  return { ok: true, page: r.page, opened, app: r.app, directions: r.directions, fixed: r.fixed, warnings: r.warnings };
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { boolean: ['no-open'] }, help: helpText(), main });
}
