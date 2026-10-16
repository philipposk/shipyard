#!/usr/bin/env node
// Writes ~/.shipyard/design-gallery.html: every ready-made look as a small picture of an app on a phone
// and on a computer screen (so you see the menu, the homepage, the cards, the buttons and the type, not
// just colours), light and dark, with a "Use this look" button that copies a sentence to paste into Claude.
// With --app <folder> --real the pictures are real screenshots of YOUR app in each look.
// The only request the page makes is to Google Fonts (to show the real fonts). Offline it falls back
// to the device font and still works.
import { createHash, randomBytes } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli, isMain, ProvisionError, resolveAppDir, readAppConfig } from './provision/common.mjs';
import { HOME_DIR, ensureHomeDir } from './lib/paths.mjs';
import * as log from './lib/log.mjs';
import { listPresets, listCustomLooks, isValidId } from './design/presets.mjs';
import { validateTokens } from './design/validate.mjs';
import { headingFont, withDefaults } from './design/tokens.mjs';
import { googleFontsCssUrl } from './design/fonts.mjs';
import { homeContentWarning } from './design/home-content.mjs';
import { replicaCss, lookVarsCss, renderReplica, lookFacts, SCREENS } from './design/replica.mjs';
import { esc, openInBrowser } from './settings-page.mjs';

export const GALLERY_HTML = path.join(HOME_DIR, 'design-gallery.html');

const HELP = `
Make a page that shows every ready-made look on a phone and on a computer screen, in light and dark,
so you can pick one.

Usage:
  node design-gallery.mjs [--app <app-folder>] [--real] [--no-open] [--json]

  --app <folder>  the app you are choosing for (the sentence you copy names it)
  --real          with --app: show real screenshots of your own app in each look (takes about a minute,
                  needs npm install to have been run in the app)
  --no-open       write the page but do not open it
  --json          print the result as JSON
  --help          show this text

Writes ${'~/.shipyard/design-gallery.html'} and opens it in your browser.
Exit code: 0 done, 1 could not write the page, 2 wrong options.
`;

/** The screenshots --real asks for: name, size, colour mode. */
export const REAL_VIEWS = [
  { name: 'phone-light', width: SCREENS.phone.w, height: SCREENS.phone.h, theme: 'light' },
  { name: 'phone-dark', width: SCREENS.phone.w, height: SCREENS.phone.h, theme: 'dark' },
  { name: 'desktop-light', width: 1280, height: 800, theme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 800, theme: 'dark' },
];

// ---------- page style (neutral, light + dark) ----------

const PAGE_CSS = `
:root{--pg-bg:#f6f7f9;--pg-fg:#14161a;--pg-card:#ffffff;--pg-muted:#5b6270;--pg-line:#e3e6eb;--pg-line-strong:#b9bfca;--pg-accent:#1f2937;--pg-accent-contrast:#ffffff;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--pg-bg:#0e1116;--pg-fg:#eceff4;--pg-card:#171b22;--pg-muted:#9aa3b2;--pg-line:#262c36;--pg-line-strong:#3a4250;--pg-accent:#eceff4;--pg-accent-contrast:#0e1116}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--pg-bg);color:var(--pg-fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:1240px;margin:0 auto;padding:24px 16px 96px}
h1{font-size:1.75rem;line-height:1.2;margin:0}
h2{font-size:1.25rem;line-height:1.25;margin:0}
p{margin:0}
.top{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between}
.lead{color:var(--pg-muted);margin-top:8px;max-width:62ch}
.group{margin:40px 0 12px;font-size:1rem;color:var(--pg-muted);font-weight:600}
.looks{display:grid;gap:24px;margin-top:24px;grid-template-columns:minmax(0,1fr)}
.look{background:var(--pg-card);border:1px solid var(--pg-line);border-radius:16px;padding:16px;display:grid;gap:20px;align-content:start;grid-template-columns:minmax(0,1fr)}
.look-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.look-info{display:grid;gap:12px;align-content:start}
.look-desc{color:var(--pg-muted)}
.look-good{font-size:.875rem;color:var(--pg-muted)}
.pill{font-size:.8125rem;font-weight:600;padding:2px 10px;border-radius:999px;background:var(--pg-line);white-space:nowrap}
.facts{margin:0;display:grid;gap:6px;font-size:.875rem}
.facts div{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px}
.facts dt{color:var(--pg-muted)}
.facts dd{margin:0;font-weight:600}
.swatch-row{display:flex;gap:6px;align-items:center}
.sw{width:22px;height:22px;border-radius:50%;border:1px solid var(--pg-line-strong);display:inline-block}
.btn{font:inherit;font-weight:600;min-height:44px;min-width:44px;padding:0 18px;border-radius:10px;border:1px solid var(--pg-accent);background:var(--pg-accent);color:var(--pg-accent-contrast);cursor:pointer}
.btn:hover{filter:brightness(1.12)}
.btn:focus-visible,.seg button:focus-visible{outline:3px solid var(--pg-fg);outline-offset:2px}
.look-foot{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--pg-line-strong);border-radius:10px;overflow:hidden}
.seg button{font:inherit;font-size:.875rem;font-weight:600;min-height:44px;min-width:64px;padding:0 14px;border:0;background:transparent;color:var(--pg-fg);cursor:pointer}
.seg button+button{border-left:1px solid var(--pg-line-strong)}
.seg button[aria-pressed="true"]{background:var(--pg-fg);color:var(--pg-bg)}
.shots{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);align-items:start}
.shot-fig{margin:0;display:grid;gap:6px;min-width:0}
.shot-fig.phone{max-width:250px;width:100%;justify-self:center}
.shot-fig figcaption{font-size:.8125rem;color:var(--pg-muted);font-weight:600}
.frame{border:1px solid var(--pg-line-strong);background:var(--pg-line);overflow:hidden}
.frame-phone{border-radius:26px;border-width:5px;border-color:var(--pg-line-strong)}
.frame-desk{border-radius:10px}
.chrome{display:flex;gap:5px;padding:7px 10px;background:var(--pg-card);border-bottom:1px solid var(--pg-line)}
.chrome i{width:8px;height:8px;border-radius:50%;background:var(--pg-line-strong);display:block}
.screen{container-type:inline-size;width:100%}
.frame-phone .screen{aspect-ratio:${SCREENS.phone.w}/${SCREENS.phone.h}}
.frame-desk .screen{aspect-ratio:${SCREENS.desktop.w}/${SCREENS.desktop.h}}
.screen img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.look[data-view="light"] .on-dark,.look[data-view="dark"] .on-light{display:none}
#toast{position:fixed;left:50%;bottom:20px;transform:translate(-50%,16px);max-width:calc(100vw - 32px);padding:12px 16px;border-radius:10px;background:var(--pg-fg);color:var(--pg-bg);font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;overflow-wrap:anywhere}
#toast.show{opacity:1;transform:translate(-50%,0)}
.offscreen{position:fixed;left:-9999px;top:0}
@media (min-width:760px){.shots{grid-template-columns:minmax(0,230px) minmax(0,1fr)}.shot-fig.phone{max-width:none;justify-self:stretch}}
@media (min-width:1100px){.look{grid-template-columns:minmax(0,270px) minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){#toast{transition:none}}
`;

const SCRIPT = `
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
      var cards = document.querySelectorAll('.look');
      for (var i = 0; i < cards.length; i++) setView(cards[i], view);
      var globals = document.querySelectorAll('[data-all-view]');
      for (var j = 0; j < globals.length; j++) globals[j].setAttribute('aria-pressed', globals[j] === all ? 'true' : 'false');
      return;
    }
    var one = event.target.closest('[data-view-btn]');
    if (one) {
      setView(one.closest('.look'), one.getAttribute('data-view-btn'));
      return;
    }
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var value = button.getAttribute('data-copy');
    function finish(copied) {
      show(copied ? 'Copied, paste it into Claude' : 'Could not copy. Select and copy this: ' + value);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { finish(true); }, function () { finish(legacyCopy(value)); });
    } else {
      finish(legacyCopy(value));
    }
  });
})();
`;

// ---------- one look ----------

const fileUrl = (file) => pathToFileURL(path.resolve(String(file))).href;

/** The picture inside a frame: a drawn replica, or the real screenshots when we have them. */
function screen(t, kind, appName, shots) {
  const light = shots?.[`${kind}-light`];
  const dark = shots?.[`${kind}-dark`];
  if (light && dark) {
    const alt = (mode) => `${t.name} on your app, ${kind === 'phone' ? 'phone' : 'computer'}, ${mode}`;
    return `<img class="on-light" src="${esc(fileUrl(light))}" alt="${esc(alt('light'))}" loading="lazy"><img class="on-dark" src="${esc(fileUrl(dark))}" alt="${esc(alt('dark'))}" loading="lazy">`;
  }
  return renderReplica(t, { appName, kind });
}

function viewButtons(t, attr) {
  const dflt = t.defaultTheme === 'dark' ? 'dark' : 'light';
  return `<div class="seg" role="group" aria-label="Show ${esc(t.name)} in">${['light', 'dark'].map((v) => `<button type="button" ${attr}="${v}" aria-pressed="${v === dflt}">${v === 'light' ? 'Light' : 'Dark'}</button>`).join('')}</div>`;
}

function lookCard(input, { appName, forApp, current, shots }) {
  const t = withDefaults(input);
  const sentence = `Shipyard: use the ${t.name} look${forApp ? ` for ${forApp}` : ''}`;
  const isCurrent = current && current === t.id;
  const dflt = t.defaultTheme === 'dark' ? 'dark' : 'light';
  const facts = lookFacts(t).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const real = Boolean(shots?.['phone-light'] && shots?.['desktop-light']);
  return `<article class="look lk-${t.id}" data-view="${dflt}" aria-labelledby="look-${t.id}">
<div class="look-info">
<div class="look-head"><div><h2 id="look-${t.id}">${esc(t.name)}</h2><p class="look-desc">${esc(t.description ?? '')}</p></div>${isCurrent ? '<span class="pill">In use</span>' : ''}</div>
<p class="look-good">Good for ${esc(t.goodFor ?? 'many kinds of apps')}.</p>
<dl class="facts">${facts}</dl>
<div class="look-foot">${viewButtons(t, 'data-view-btn')}<button type="button" class="btn" data-copy="${esc(sentence)}" aria-label="${esc(`Use the ${t.name} look`)}">Use this look</button></div>
</div>
<div class="shots">
<figure class="shot-fig phone"><div class="frame frame-phone"><div class="screen">${screen(t, 'phone', appName, shots)}</div></div><figcaption>${real ? 'Your app on a phone' : 'On a phone'}</figcaption></figure>
<figure class="shot-fig"><div class="frame frame-desk"><div class="chrome"><i></i><i></i><i></i></div><div class="screen">${screen(t, 'desktop', appName, shots)}</div></div><figcaption>${real ? 'Your app on a computer' : 'On a computer'}</figcaption></figure>
</div>
</article>`;
}

const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/**
 * Build the whole page. Pure: looks (token files), app info and, for --real, screenshot paths.
 * { looks, saved, appName, current, shots } -> HTML string.
 *   shots: { "<look id>": { "phone-light": "/path.png", "phone-dark": ..., "desktop-light": ..., "desktop-dark": ... } }
 */
export function renderGalleryHtml({ looks = [], saved = [], appName = '', current = '', shots = {} } = {}) {
  const usable = (list) => list.filter((t) => isValidId(t?.id) && validateTokens(t).ok);
  const main = usable(looks);
  const mine = usable(saved).filter((t) => !main.some((m) => m.id === t.id));
  const all = [...main, ...mine];
  const shown = appName || 'Your app';
  const anyReal = all.some((t) => shots?.[t.id]?.['phone-light']);
  const fontsUrl = googleFontsCssUrl(all.flatMap((t) => [t.font.body, headingFont(t)]), { maxWeight: 800 });
  const style = `${PAGE_CSS}${replicaCss()}\n${all.map(lookVarsCss).join('\n')}`;
  const csp = [
    "default-src 'none'",
    `style-src ${sha(style)}${fontsUrl ? ' https://fonts.googleapis.com' : ''}`,
    ...(fontsUrl ? ['font-src https://fonts.gstatic.com'] : []),
    ...(anyReal ? ['img-src file:'] : []),
    `script-src ${sha(SCRIPT)}`,
  ].join('; ');
  const cards = (list) => list.map((t) => lookCard(t, { appName: shown, forApp: appName, current, shots: shots?.[t.id] })).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<title>Shipyard looks</title>
${fontsUrl ? `<link rel="stylesheet" href="${esc(fontsUrl)}">\n` : ''}<style>${style}</style>
</head>
<body>
<main>
<div class="top">
<div>
<h1>Pick a look${appName ? ` for ${esc(appName)}` : ''}</h1>
<p class="lead">${anyReal ? 'These are real screenshots of your app in each look.' : 'Each look changes more than colours: the menu, the homepage, the cards, the buttons and the text.'} Press "Use this look", then paste the sentence into Claude.</p>
</div>
<div class="seg" role="group" aria-label="Show all looks in"><button type="button" data-all-view="light" aria-pressed="false">All light</button><button type="button" data-all-view="dark" aria-pressed="false">All dark</button></div>
</div>
<div class="looks">
${cards(main)}
</div>
${mine.length > 0 ? `<h2 class="group">Looks you saved</h2>\n<div class="looks">\n${cards(mine)}\n</div>` : ''}
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---------- real screenshots of the student's own app ----------

/**
 * Ask the renderer for screenshots of the app in each look.
 * Returns { shots, message }: `shots` is { id: { view: path } } (empty when it could not run) and
 * `message` is a plain sentence about why, or null.
 */
export async function renderRealShots({ appDir, looks, importRenderer = () => import('./design/render-previews.mjs') }) {
  let renderer;
  try {
    renderer = await importRenderer();
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
      return { shots: {}, message: 'The screenshot maker (scripts/design/render-previews.mjs) is not installed in this copy of Shipyard, so I am showing the drawn pictures instead. Update the Shipyard plugin to get --real.' };
    }
    return { shots: {}, message: `The screenshot maker would not start (${String(err?.message ?? err).split('\n')[0]}), so I am showing the drawn pictures instead.` };
  }
  if (typeof renderer.renderPreviews !== 'function') {
    return { shots: {}, message: 'The screenshot maker in this copy of Shipyard is not the expected one, so I am showing the drawn pictures instead.' };
  }
  try {
    const out = await renderer.renderPreviews({
      appDir,
      items: looks.map((t) => ({ id: t.id, tokens: t })),
      views: REAL_VIEWS,
    });
    const shots = {};
    for (const r of out ?? []) {
      if (r?.id && r?.view && r?.png) (shots[r.id] ??= {})[r.view] = r.png;
    }
    return { shots, message: Object.keys(shots).length === 0 ? 'No screenshots came back, so I am showing the drawn pictures instead.' : null };
  } catch (err) {
    return { shots: {}, message: `I could not take screenshots of your app (${String(err?.message ?? err).split('\n')[0]}), so I am showing the drawn pictures instead.` };
  }
}

// ---------- writing ----------

export async function writeGallery({ appDir, real = false, importRenderer } = {}) {
  let appName = '';
  let current = '';
  if (appDir) {
    const config = await readAppConfig(appDir);
    appName = String(config.name ?? config.slug ?? '');
    current = String(config.design?.id ?? '');
  }
  const looks = await listPresets();
  const saved = await listCustomLooks();
  let shots = {};
  let message = null;
  let homeWarning = null;
  if (real) {
    homeWarning = await homeContentWarning(appDir);
    if (!appDir) throw new log.UsageError('--real needs --app <app-folder>, so I know which app to take screenshots of.');
    const usable = [...looks, ...saved.filter((t) => !looks.some((m) => m.id === t.id))].filter((t) => isValidId(t?.id) && validateTokens(t).ok);
    ({ shots, message } = await renderRealShots({ appDir, looks: usable, importRenderer }));
  }
  const html = renderGalleryHtml({ looks, saved, appName, current, shots });
  await ensureHomeDir();
  const tmp = `${GALLERY_HTML}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, html, { mode: 0o600 });
    await rename(tmp, GALLERY_HTML);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { path: GALLERY_HTML, appName, real: Object.keys(shots).length > 0, message, homeWarning };
}

export async function main(args) {
  if (args._.length > 0) throw new log.UsageError('This command takes no folder. Use --app <app-folder> to choose for one app.');
  if (args.real && !args.app) throw new log.UsageError('--real needs --app <app-folder>, so I know which app to take screenshots of.');
  const appDir = args.app ? await resolveAppDir(args.app) : undefined;
  if (args.real) log.info('Taking screenshots of your app in each look. This takes about a minute.');
  let written;
  try {
    written = await writeGallery({ appDir, real: Boolean(args.real) });
  } catch (err) {
    if (err instanceof ProvisionError || err instanceof log.UsageError) throw err;
    throw new ProvisionError(`Could not write the looks page: ${err.message}`);
  }
  if (written.message) log.warn(written.message);
  if (written.homeWarning) log.warn(written.homeWarning);
  const opened = args['no-open'] ? false : await openInBrowser(written.path);
  log.ok(`Looks page ready: ${written.path}`);
  if (opened) log.info('It should open in your browser now.');
  else if (args['no-open']) log.info('Open that file in your browser to see it.');
  else log.warn('Could not open your browser automatically. Open that file yourself.');
  return { ok: true, path: written.path, opened, app: written.appName || null, real: written.real, ...(written.homeWarning ? { warnings: [written.homeWarning] } : {}) };
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['app'], boolean: ['no-open', 'real'] }, help: HELP, main });
}
