#!/usr/bin/env node
// Writes ~/.shipyard/settings.html: one page showing your accounts, keys (saved or
// not, never the values), defaults, company details and apps. Each "Change" button
// copies a sentence to paste into Claude, which then makes the change.
// The page is one self-contained file: no network requests, works light or dark.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile, rename, rm, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadProfile, STEP_IDS } from './lib/profile.mjs';
import { listSecrets } from './lib/secrets.mjs';
import { listPresets, listCustomLooks } from './design/presets.mjs';
import { isHex } from './design/color.mjs';
import { SETTINGS_HTML, HOME_DIR, ensureHomeDir, isMainModule } from './lib/paths.mjs';
import { ok, info, warn, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const HELP = `Usage: settings-page.mjs [--no-open] [--json]

Writes ~/.shipyard/settings.html and opens it in your browser.
  --no-open   write the file but do not open it
  --json      machine-readable output
Exit code: 0 = ok, 1 = could not write the page, 2 = bad usage.
`;

// ---------- small helpers ----------

/** Escape text for HTML (also safe inside double-quoted attributes). */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** "16 Oct 2026, 14:03" in the computer's time zone, or '' if it isn't a date. */
export function formatTime(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Only web links become clickable. Anything else is shown as plain text. */
function safeHref(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const has = (v) => typeof v === 'string' && v.trim() !== '';
const text = (v) => (has(v) ? v.trim() : '');

/**
 * Two small colour dots per theme (page colour with the accent on top), drawn as inline SVG so the
 * page's content security policy (no style attributes) is not needed. Colours must be real hex values.
 */
function swatchesHtml(sw) {
  const one = (theme, label) => {
    const bg = sw?.[theme]?.background;
    const accent = sw?.[theme]?.accent;
    if (!isHex(bg) || !isHex(accent)) return '';
    return `<svg class="sw" width="40" height="24" viewBox="0 0 40 24" role="img" aria-label="${esc(`${label} accent`)}"><rect x="0.5" y="0.5" width="39" height="23" rx="7" fill="${esc(bg)}" stroke="#8886"/><circle cx="20" cy="12" r="7" fill="${esc(accent)}"/></svg>`;
  };
  const light = one('light', 'Light');
  const dark = one('dark', 'Dark');
  return light || dark ? `<span class="swatches">${light}${dark}</span> ` : '';
}

/** Name and swatches for a look id: from what the app saved, else from the known looks. */
function lookInfo(id, saved, looks) {
  const known = has(id) ? looks?.[id] : undefined;
  return { name: text(saved?.name) || known?.name || text(id), swatches: saved?.swatches ?? known?.swatches };
}

// ---------- building blocks ----------

/** Swatches plus the look's name, as escaped HTML. */
function lookValue(id, saved, looks) {
  const info = lookInfo(id, saved, looks);
  return `${swatchesHtml(info.swatches)}${esc(info.name)}`;
}

const unset = (label = 'Not set') => `<span class="muted">${esc(label)}</span>`;

/** Status marks. The words matter as much as the symbol, so it never relies on colour alone. */
const mark = {
  yes: (label) => `<span class="st st-ok"><span aria-hidden="true">✓</span> ${esc(label)}</span>`,
  no: (label) => `<span class="st st-no"><span aria-hidden="true">✗</span> ${esc(label)}</span>`,
  need: (label) => `<span class="st st-need"><span aria-hidden="true">✗</span> ${esc(label)}</span>`,
  odd: (label) => `<span class="st st-odd"><span aria-hidden="true">!</span> ${esc(label)}</span>`,
};

/**
 * One row. `valueHtml` must already be escaped HTML.
 * `copy` (a sentence) adds a button that copies it; `button` is its label.
 */
function row({ label, valueHtml, copy, button = 'Change', note }) {
  const btn = copy
    ? `<button type="button" class="btn" data-copy="${esc(copy)}" aria-label="${esc(`${button}: ${label}`)}">${esc(button)}</button>`
    : '';
  return `<li class="row">
<div class="row-main"><div class="row-label">${esc(label)}</div><div class="row-value">${valueHtml}</div>${note ? `<div class="row-note">${note}</div>` : ''}</div>
${btn}
</li>`;
}

const section = (id, title, body, extra = '') =>
  `<section class="block" aria-labelledby="h-${id}">
<h2 id="h-${id}">${esc(title)}</h2>${extra}
${body}
</section>`;

const list = (rows) => `<ul class="rows card">\n${rows.join('\n')}\n</ul>`;

// ---------- sections ----------

function accountsSection(profile) {
  const a = profile.accounts ?? {};
  const item = (key, name, connectedText, extraNote) => {
    const acct = a[key] ?? {};
    const isOk = acct.ok === true;
    return row({
      label: name,
      valueHtml: isOk ? `${mark.yes(connectedText(acct))}` : mark.no('Not set up'),
      note: isOk ? extraNote?.(acct) : undefined,
      copy: isOk ? `Shipyard: change my ${name} account` : `Shipyard: set up ${name}`,
      button: isOk ? 'Change' : 'Set up',
    });
  };
  return section('accounts', 'Accounts', list([
    item('github', 'GitHub', (x) => (has(x.user) ? `Connected as ${x.user}` : 'Connected')),
    item('vercel', 'Vercel', (x) => (has(x.user) ? `Connected as ${x.user}` : 'Connected'),
      (x) => (has(x.scope) ? `Team: ${esc(x.scope)}` : undefined)),
    item('supabase', 'Supabase', (x) => (has(x.orgName) ? `Connected, organization ${x.orgName}` : 'Connected')),
    item('openrouter', 'OpenRouter', () => 'Key works'),
    item('openai', 'OpenAI', () => 'Key works'),
    item('resend', 'Resend', (x) => (has(x.domain) ? `Key works, domain ${x.domain}` : 'Key works')),
    item('stripe', 'Stripe', (x) => `Key works, ${x.mode === 'live' ? 'live' : 'test'} mode`),
  ]));
}

const KEY_NAMES = {
  SUPABASE_ACCESS_TOKEN: 'Supabase access token',
  OPENROUTER_API_KEY: 'OpenRouter key',
  OPENAI_API_KEY: 'OpenAI key',
  RESEND_API_KEY: 'Resend key',
  STRIPE_SECRET_KEY: 'Stripe secret key',
  STRIPE_PUBLISHABLE_KEY: 'Stripe publishable key',
  STRIPE_LIVE_SECRET_KEY: 'Stripe live secret key (real money)',
  STRIPE_LIVE_PUBLISHABLE_KEY: 'Stripe live publishable key (real money)',
  GOOGLE_CLIENT_ID: 'Google sign-in client ID',
  GOOGLE_CLIENT_SECRET: 'Google sign-in client secret',
};

function keysSection(keys) {
  const rows = keys.map((k) => {
    let value;
    if (k.present && k.looksValid) value = mark.yes('Saved');
    else if (k.present) value = mark.odd('Saved, but the format looks off');
    else value = k.required ? mark.need('Missing, needed') : mark.no('Not saved');
    return row({
      label: KEY_NAMES[k.name] ?? k.name,
      valueHtml: value,
      note: `<code>${esc(k.name)}</code>${k.required ? ' · required' : ''}`,
      copy: k.present ? `Shipyard: update my ${k.name} key` : `Shipyard: add my ${k.name} key`,
      button: k.present ? 'Change' : 'Add',
    });
  });
  return section('keys', 'Keys', list(rows), '\n<p class="hint">Only whether a key is saved. The values never appear here.</p>');
}

function youSection(profile) {
  const o = profile.owner ?? {};
  const langs = Array.isArray(o.languages) ? o.languages.filter(has) : [];
  const field = (label, value, sentence) =>
    row({
      label,
      valueHtml: has(value) ? esc(value) : unset(),
      copy: `Shipyard: change my ${sentence}`,
      button: has(value) ? 'Change' : 'Add',
    });
  return section('you', 'You', list([
    field('Name', o.name, 'name'),
    field('Email', o.email, 'email'),
    field('Country', o.country, 'country'),
    row({
      label: 'Languages',
      valueHtml: langs.length > 0 ? esc(langs.join(', ')) : unset(),
      copy: 'Shipyard: change my languages',
    }),
  ]));
}

const LAYOUTS = {
  'bottom-nav': 'Bottom tabs (phone first)',
  sidebar: 'Sidebar (for tools)',
  'top-nav': 'Links in the top bar (like a website)',
};
const otherLayout = (l) => (l === 'sidebar' ? 'bottom-nav' : 'sidebar');

function defaultsSection(profile, looks) {
  const d = profile.defaults ?? {};
  const dom = profile.domain ?? {};
  const layout = Object.hasOwn(LAYOUTS, d.layout) ? d.layout : 'bottom-nav';
  const toggle = (label, on, offWord, sentence) =>
    row({
      label,
      valueHtml: on ? mark.yes('On') : mark.no('Off'),
      copy: `Shipyard: turn ${sentence} ${on ? 'off' : 'on'}${offWord}`,
      button: 'Change',
    });
  return section('defaults', 'Defaults', list([
    row({
      label: 'Design',
      valueHtml: has(d.design) ? lookValue(d.design, null, looks) : unset('Not chosen yet'),
      copy: 'Shipyard: change my default design',
    }),
    row({
      label: 'Layout',
      valueHtml: esc(LAYOUTS[layout]),
      copy: `Shipyard: set my default layout to ${otherLayout(layout)}`,
    }),
    toggle('Installable on phones', d.pwa !== false, ' by default', 'installable web apps'),
    toggle('Phone store apps', d.phoneApps === true, ' by default', 'phone store apps'),
    toggle('Keep AI costs low', d.budgetMode !== false, '', 'budget mode'),
    row({
      label: 'Web address',
      valueHtml: has(dom.name) ? esc(dom.name) : esc('Free address (yourapp.vercel.app)'),
      copy: 'Shipyard: change my web address',
    }),
  ]));
}

function companySection(profile) {
  const c = profile.company ?? {};
  const field = (label, value, sentence) =>
    row({
      label,
      valueHtml: has(value) ? esc(value) : unset(),
      copy: `Shipyard: change my company ${sentence}`,
      button: has(value) ? 'Change' : 'Add',
    });
  return section('company', 'Company', list([
    field('Legal name', c.legalName, 'legal name'),
    field('Address', c.address, 'address'),
    field('Contact email', c.contactEmail, 'contact email'),
    field('VAT ID', c.vatId, 'VAT ID'),
  ]));
}

const APP_STATUS = {
  scaffolded: 'Just created',
  provisioned: 'Ready to go online',
  live: 'Live',
  paused: 'Paused',
};
const SUPABASE_STATUS = { ACTIVE_HEALTHY: 'Running', INACTIVE: 'Paused', COMING_UP: 'Starting' };

/** Turn whatever `lastVerify` holds into a short sentence. It is written by another script, so be forgiving. */
export function describeVerify(lv) {
  if (lv === null || lv === undefined || typeof lv !== 'object') return { html: unset('Not checked yet'), when: '' };
  let passed = null;
  if (typeof lv.ok === 'boolean') passed = lv.ok;
  else if (typeof lv.failed === 'number') passed = lv.failed === 0;
  else if (typeof lv.status === 'string') passed = ['pass', 'passed', 'ok', 'green'].includes(lv.status.toLowerCase()) ? true : ['fail', 'failed', 'red'].includes(lv.status.toLowerCase()) ? false : null;
  const problems = typeof lv.failed === 'number' ? lv.failed : Array.isArray(lv.failures) ? lv.failures.length : null;
  const when = formatTime(lv.at ?? lv.checkedAt ?? lv.time ?? lv.date ?? lv.timestamp ?? lv.ranAt);
  let html;
  if (passed === true) html = mark.yes('Passed');
  else if (passed === false && lv.failed === 0) html = mark.need('Not verified');
  else if (passed === false) html = mark.need(problems ? `Failed, ${problems} ${problems === 1 ? 'problem' : 'problems'}` : 'Failed');
  else html = esc('Checked');
  return { html, when };
}

function linkOrText(url, label) {
  const href = safeHref(url);
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label ?? url)}</a>`
    : esc(url);
}

function repoValue(repo) {
  if (!has(repo)) return unset('Not saved to GitHub yet');
  if (/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) return linkOrText(`https://github.com/${repo.trim()}`, repo.trim());
  return linkOrText(repo.trim());
}

/**
 * Launch summary for one app. Reads what the launch scripts may have saved on the app entry
 * (`launch.domain`, `launch.emailVerified`, `launch.legalAt`, `launch.billing`, `launch.shells`),
 * with forgiving fallbacks. Never throws on odd data.
 */
export function describeLaunch(app) {
  const l = app.launch && typeof app.launch === 'object' ? app.launch : {};
  const modules = Array.isArray(app.modules) ? app.modules.filter(has) : [];
  let host = '';
  try {
    if (has(app.url)) host = new URL(app.url.trim()).hostname;
  } catch {
    host = '';
  }
  const custom = text(l.domain) || (host && !host.endsWith('.vercel.app') ? host : '');
  const legal = formatTime(l.legalAt ?? l.legalGeneratedAt);
  const billingMode = ['test', 'live'].includes(l.billing) ? l.billing : '';
  const shells = [...new Set([...(Array.isArray(l.shells) ? l.shells : []), ...(Array.isArray(app.shells) ? app.shells : [])])].filter(has);
  const lines = [
    custom ? mark.yes(`Own address: ${custom}`) : unset('Own address: not yet'),
    l.emailVerified === true ? mark.yes('Sign-up emails verified') : unset('Sign-up emails: not set up'),
    legal ? mark.yes(`Legal pages made ${legal}`) : unset('Legal pages: not made yet'),
    billingMode
      ? mark.yes(`Payments: ${billingMode === 'live' ? 'live' : 'test mode'}`)
      : modules.includes('billing') ? mark.odd('Payments: added, not set up') : unset('Payments: not added'),
    shells.length > 0 ? mark.yes(`Store apps: ${shells.join(', ')}`) : unset('Store apps: none'),
  ];
  return lines.map((x) => `<div>${x}</div>`).join('');
}

/**
 * Ops summary for one app: error log, scheduled health checks, code review, auto-merge, backups.
 * Reads `app.ops` (`health`, `review`, `automerge`, `deps`, `backupAt`), filled in from the app folder
 * when the page is written. Falls back to the module list. Never throws on odd data.
 */
export function describeOps(app) {
  const o = app.ops && typeof app.ops === 'object' ? app.ops : {};
  const modules = Array.isArray(app.modules) ? app.modules.filter(has) : [];
  const backup = formatTime(o.backupAt);
  const lines = [
    o.errors === true || modules.includes('errors') ? mark.yes('Error log and alerts: on') : unset('Error log and alerts: not added'),
    o.health === true ? mark.yes('Health checks every 6 hours') : unset('Health checks: not set up'),
    o.review === true ? mark.yes('Code review on every pull request') : unset('Code review: not set up'),
    o.automerge === true ? mark.yes('Small safe changes merge themselves') : unset('Auto-merge: not set up'),
    backup ? mark.yes(`Last backup ${backup}`) : unset('Backups: none yet'),
  ];
  return lines.map((x) => `<div>${x}</div>`).join('');
}

/** Video summary for one app. Reads `app.video` (`setUp`, `published[]`). Never throws. */
export function describeVideo(app) {
  const v = app.video && typeof app.video === 'object' ? app.video : {};
  const published = Array.isArray(v.published) ? v.published.filter((x) => x && typeof x === 'object') : [];
  const setUp = v.setUp === true || has(v.engineSha) || published.length > 0;
  const lines = [
    setUp ? mark.yes('Video folder set up') : unset('Video: not set up'),
    published.length > 0
      ? mark.yes(`Published: ${published.map((x) => text(x.name)).filter(Boolean).join(', ') || `${published.length} video${published.length === 1 ? '' : 's'}`}`)
      : unset('Published video: none yet'),
  ];
  return lines.map((x) => `<div>${x}</div>`).join('');
}

const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Look in the app folder and the backups folder for what ops and video have done, and add it to a copy
 * of the app entry. Silent on any problem: the page then shows "not set up".
 */
export async function withDiskFacts(app, { homeDir = HOME_DIR } = {}) {
  const out = { ...app };
  const dir = has(app.dir) ? app.dir : '';
  let cfg = {};
  if (dir) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, '.shipyard-app.json'), 'utf8'));
      if (parsed && typeof parsed === 'object') cfg = parsed;
    } catch {
      cfg = {};
    }
    const wf = (name) => exists(path.join(dir, '.github', 'workflows', name));
    out.ops = {
      ...(typeof app.ops === 'object' && app.ops ? app.ops : {}),
      errors: Array.isArray(cfg.modules) && cfg.modules.includes('errors'),
      health: await wf('health.yml'),
      review: await exists(path.join(dir, '.coderabbit.yaml')),
      automerge: await wf('automerge.yml'),
    };
    out.video = {
      ...(cfg.video && typeof cfg.video === 'object' ? cfg.video : {}),
      ...(typeof app.video === 'object' && app.video ? app.video : {}),
      setUp: await exists(path.join(dir, 'video', 'package.json')),
    };
  }
  if (/^[a-z][a-z0-9-]*$/.test(String(app.slug ?? ''))) {
    try {
      const names = (await readdir(path.join(homeDir, 'backups', app.slug))).sort();
      const last = names.at(-1); // folder names are UTC timestamps like 2026-10-16T14-03-00Z
      const m = last && /^(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:]?(\d{2})/.exec(last);
      if (m) out.ops = { ...(out.ops ?? {}), backupAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z` };
    } catch {
      // no backups folder
    }
  }
  return out;
}

function appCard(app, looks) {
  const name = text(app.name) || text(app.slug) || 'Untitled app';
  const layout = Object.hasOwn(LAYOUTS, app.layout) ? app.layout : '';
  const modules = Array.isArray(app.modules) ? app.modules.filter(has) : [];
  const status = APP_STATUS[app.status] ?? (has(app.status) ? app.status : 'Unknown');
  const verify = describeVerify(app.lastVerify);
  const sbStatus = SUPABASE_STATUS[app.supabaseStatus] ?? (has(app.supabaseStatus) ? app.supabaseStatus : '');

  const rows = [
    row({ label: 'Address', valueHtml: has(app.url) ? linkOrText(app.url.trim()) : unset('Not online yet') }),
    row({ label: 'Code on GitHub', valueHtml: repoValue(app.repo) }),
    row({
      label: 'Supabase project',
      valueHtml: has(app.supabaseRef) ? `<code>${esc(app.supabaseRef)}</code>${sbStatus ? ` · ${esc(sbStatus)}` : ''}` : unset('Not created yet'),
    }),
    row({
      label: 'Look',
      valueHtml: has(app.design?.id) || has(app.design?.name) ? lookValue(app.design?.id, app.design, looks) : unset('Not chosen yet'),
      copy: `Shipyard: change ${name}'s look`,
    }),
    row({
      label: 'Layout',
      valueHtml: layout ? esc(LAYOUTS[layout]) : unset('Not set'),
      copy: `Shipyard: change ${name}'s layout to ${otherLayout(layout)}`,
    }),
    row({
      label: 'Modules',
      valueHtml: modules.length > 0 ? esc(modules.join(', ')) : unset('None'),
      copy: `Shipyard: change ${name}'s modules`,
    }),
    row({
      label: 'Last check',
      valueHtml: verify.html,
      note: verify.when ? esc(verify.when) : undefined,
      copy: `Shipyard: verify ${name} again`,
      button: 'Run again',
    }),
    row({
      label: 'Launch',
      valueHtml: describeLaunch(app),
      copy: `Shipyard: launch ${name}`,
      button: 'Open',
    }),
    row({
      label: 'Ops',
      valueHtml: describeOps(app),
      copy: `Shipyard: ops for ${name}`,
      button: 'Open',
    }),
    row({
      label: 'Video',
      valueHtml: describeVideo(app),
      copy: `Shipyard: make a video for ${name}`,
      button: 'Open',
    }),
  ];
  return `<article class="app card">
<header class="app-head"><h3>${esc(name)}</h3><span class="pill">${esc(status)}</span></header>
<ul class="rows inner">
${rows.join('\n')}
</ul>
</article>`;
}

function appsSection(profile, looks) {
  const apps = Array.isArray(profile.apps) ? profile.apps : [];
  if (apps.length === 0) {
    const empty = `<div class="empty card"><p><strong>No apps yet</strong></p><p class="muted">Tell Claude what you want to build.</p>
<button type="button" class="btn btn-primary" data-copy="Shipyard: build a new app">Start an app</button></div>`;
    return section('apps', 'Apps', empty);
  }
  return section('apps', 'Apps', apps.filter((a) => a && typeof a === 'object').map((a) => appCard(a, looks)).join('\n'));
}

// ---------- the page ----------

const CSS = `
:root{
  --bg:#f6f7f9;--fg:#14161a;--card:#ffffff;--muted:#5b6270;--line:#e3e6eb;--line-strong:#b9bfca;
  --accent:#2563eb;--accent-contrast:#ffffff;--accent-soft:#e8effd;--danger:#b4301f;
  --radius:14px;--radius-sm:10px;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1116;--fg:#eceff4;--card:#171b22;--muted:#9aa3b2;--line:#262c36;--line-strong:#3a4250;
    --accent:#6b9bff;--accent-contrast:#0a0f1a;--accent-soft:#1c2740;--danger:#ef6a5e;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 96px}
h1{font-size:1.75rem;line-height:1.2;margin:0}
h2{font-size:1.125rem;margin:0 0 12px}
h3{font-size:1.0625rem;margin:0;overflow-wrap:anywhere}
p{margin:0}
a{color:var(--accent)}
code{font:0.875em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.muted,.row-label,.row-note,.hint{color:var(--muted)}
.top{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;justify-content:space-between;margin-bottom:8px}
.top p{color:var(--muted);font-size:0.875rem;margin-top:4px}
.progress{margin:16px 0 8px}
.steps{display:flex;gap:4px;margin-top:8px}
.steps span{flex:1;height:6px;border-radius:3px;background:var(--line)}
.steps span.on{background:var(--accent)}
.block{margin-top:32px}
.hint{font-size:0.875rem;margin:-4px 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius)}
.rows{list-style:none;margin:0;padding:0}
.rows>.row+.row{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center;padding:12px 16px}
.row-label{font-size:0.875rem}
.row-value{overflow-wrap:anywhere}
.row-note{font-size:0.875rem;overflow-wrap:anywhere}
.st{font-weight:600}
.st-ok{color:var(--accent)}
.st-no,.st-odd{color:var(--muted)}
.st-need{color:var(--danger)}
.btn{font:inherit;font-weight:600;min-height:44px;min-width:44px;padding:0 16px;border-radius:var(--radius-sm);border:1px solid var(--line-strong);background:var(--card);color:var(--fg);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--accent)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-contrast)}
.btn-primary:hover{filter:brightness(0.94)}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.app{margin-bottom:16px;overflow:hidden}
.app-head{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:16px 16px 4px}
.sw{vertical-align:middle;margin-right:4px}
.swatches{white-space:nowrap}
.pill{font-size:0.8125rem;font-weight:600;padding:2px 10px;border-radius:999px;background:var(--accent-soft);color:var(--accent);white-space:nowrap}
.rows.inner>.row:first-child{border-top:0}
.empty{padding:20px 16px;display:grid;gap:8px;justify-items:start}
.empty .btn{margin-top:8px}
#toast{position:fixed;left:50%;bottom:20px;transform:translate(-50%,16px);max-width:calc(100vw - 32px);padding:12px 16px;border-radius:var(--radius-sm);background:var(--fg);color:var(--bg);font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;overflow-wrap:anywhere}
#toast.show{opacity:1;transform:translate(-50%,0)}
.offscreen{position:fixed;left:-9999px;top:0}
@media (prefers-reduced-motion:reduce){#toast{transition:none}}
@media (max-width:420px){
  main{padding-top:16px}
  .row{padding:12px}
  .btn{padding:0 12px}
}
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
  document.addEventListener('click', function (event) {
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

const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/**
 * Build the whole page as a string. Pure: give it the profile, the key list
 * (names and yes/no only) and the time. Every value is HTML-escaped.
 */
export function renderSettingsHtml({ profile, keys = [], now = new Date(), looks = {} }) {
  const p = profile ?? {};
  const done = Array.isArray(p.setup?.done) ? p.setup.done.filter((id) => STEP_IDS.includes(id)) : [];
  const total = STEP_IDS.length;
  const finished = done.length >= total;
  const next = STEP_IDS.find((id) => !done.includes(id));
  const bar = STEP_IDS.map((id) => `<span class="${done.includes(id) ? 'on' : ''}"></span>`).join('');

  const csp = `default-src 'none'; style-src ${sha(CSS)}; script-src ${sha(SCRIPT)}`;
  const progress = finished
    ? `<p>Setup is finished.</p>`
    : `<p>Setup: ${done.length} of ${total} steps done. Next: ${esc(next)}.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<title>Shipyard settings</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top">
<div><h1>Shipyard settings</h1><p>Updated ${esc(formatTime(now))}</p></div>
${finished ? '' : '<button type="button" class="btn btn-primary" data-copy="Shipyard: continue setup">Continue setup</button>'}
</header>
<div class="progress" role="group" aria-label="Setup progress">${progress}<div class="steps" aria-hidden="true">${bar}</div></div>
${accountsSection(p)}
${keysSection(keys)}
${youSection(p)}
${defaultsSection(p, looks)}
${companySection(p)}
${appsSection(p, looks)}
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---------- writing and opening ----------

function launchDetached(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Open a file in the default browser. Returns true if the system accepted the request. */
export function openInBrowser(file, platform = process.platform) {
  if (platform === 'darwin') return launchDetached('open', [file]);
  if (platform === 'win32') return launchDetached('rundll32', ['url.dll,FileProtocolHandler', file]);
  return launchDetached('xdg-open', [file]);
}

/** Build the page from the real profile and keys file and save it. Returns the file path. */
export async function writeSettingsPage({ now = new Date() } = {}) {
  const profile = await loadProfile();
  let keys = [];
  try {
    keys = await listSecrets();
  } catch {
    // unreadable keys file: show every key as not saved
  }
  const looks = {};
  try {
    for (const t of [...(await listCustomLooks()), ...(await listPresets())]) {
      if (t?.id && t.light?.accent && t.dark?.accent) {
        looks[t.id] = {
          name: t.name,
          swatches: {
            light: { background: t.light.background, accent: t.light.accent },
            dark: { background: t.dark.background, accent: t.dark.accent },
          },
        };
      }
    }
  } catch {
    // no looks list: the page shows the saved look names only
  }
  if (Array.isArray(profile.apps)) {
    profile.apps = await Promise.all(profile.apps.map((a) => (a && typeof a === 'object' ? withDiskFacts(a) : a)));
  }
  const html = renderSettingsHtml({ profile, keys, now, looks });
  await ensureHomeDir();
  const tmp = `${SETTINGS_HTML}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, html, { mode: 0o600 });
    await rename(tmp, SETTINGS_HTML);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return SETTINGS_HTML;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { boolean: ['json', 'help', 'no-open'], alias: { h: 'help' } });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.json) setQuiet(true);

  let file;
  try {
    file = await writeSettingsPage();
  } catch (err) {
    process.stderr.write(`Could not write the settings page: ${err.message}\n`);
    return 1;
  }
  const opened = args['no-open'] ? false : await openInBrowser(file);

  if (args.json) {
    json({ ok: true, path: file, opened });
    return 0;
  }
  ok(`Settings page ready: ${file}`);
  if (opened) info('It should open in your browser now.');
  else if (args['no-open']) info('Open that file in your browser to see it.');
  else warn('Could not open your browser automatically. Open that file yourself.');
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Could not build the settings page: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
