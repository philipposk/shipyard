import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSettingsHtml, esc, formatTime, describeVerify } from '../scripts/settings-page.mjs';
import { defaultProfile } from '../scripts/lib/profile.mjs';
import { KNOWN_SECRETS } from '../scripts/lib/secrets.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'settings-page.mjs');
const NOW = new Date(2026, 9, 16, 14, 3);

const keysNone = KNOWN_SECRETS.map((k) => ({ name: k.name, present: false, looksValid: false, required: k.required }));

function fullProfile() {
  const p = defaultProfile();
  p.owner = { name: 'Jane Doe', email: 'jane@example.com', country: 'Greece', languages: ['en', 'el'] };
  p.accounts.github = { user: 'janedoe', ok: true };
  p.accounts.vercel = { user: 'jane', scope: 'jane-team', ok: true };
  p.accounts.supabase = { orgId: 'org-1', orgName: 'Jane Org', ok: true };
  p.accounts.resend = { ok: true, domain: 'jane.dev' };
  p.accounts.stripe = { ok: true, mode: 'test' };
  p.defaults.design = 'Calm and paper-like';
  p.company = { legalName: 'Jane Ltd', address: '1 Main St', contactEmail: 'hi@jane.dev', vatId: 'EL123' };
  p.domain = { choice: 'buy', name: 'jane.dev' };
  p.setup.done = ['tools', 'github', 'vercel'];
  p.apps = [
    {
      slug: 'notes', name: 'Notes', dir: '/x', url: 'https://notes.example.com', repo: 'janedoe/notes',
      supabaseRef: 'abcdefghijklmnop', supabaseStatus: 'ACTIVE_HEALTHY', vercelProject: 'notes',
      layout: 'sidebar', modules: ['auth', 'items'], status: 'live', step: '', createdAt: '2026-10-01T10:00:00Z',
      lastVerify: { ok: true, at: '2026-10-15T09:30:00Z' },
    },
    { slug: 'todo', name: '', url: '', repo: '', layout: 'bottom-nav', modules: [], status: 'scaffolded', lastVerify: null },
  ];
  return p;
}

const render = (profile, keys = keysNone) => renderSettingsHtml({ profile, keys, now: NOW });

test('empty profile renders every section and a first-run state', () => {
  const html = render(defaultProfile());
  for (const h of ['Accounts', 'Keys', 'You', 'Defaults', 'Company', 'Apps']) assert.match(html, new RegExp(`<h2 id="h-[a-z]+">${h}</h2>`));
  assert.match(html, /No apps yet/);
  assert.match(html, /Setup: 0 of 10 steps done\. Next: tools\./);
  assert.match(html, /data-copy="Shipyard: continue setup"/);
  assert.match(html, /data-copy="Shipyard: set up GitHub"/);
  assert.match(html, /Missing, needed/);
  assert.match(html, /Not saved/);
  assert.match(html, /Shipyard: set my default layout to sidebar/);
  assert.match(html, /Updated 16 Oct 2026, 14:03/);
});

test('empty profile: no web addresses at all (nothing can be fetched)', () => {
  const html = render(defaultProfile());
  assert.ok(!/https?:\/\//.test(html), 'no http(s) addresses');
  for (const bad of ['<link', '<img', '@import', 'url(', 'fetch(', 'XMLHttpRequest', 'src=', '<iframe', '<form']) {
    assert.ok(!html.includes(bad), bad);
  }
});

test('content security policy matches the inline style and script exactly', () => {
  const html = render(fullProfile());
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1].replace(/&#39;/g, "'");
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const h = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
  assert.ok(csp.includes(`style-src ${h(style)}`));
  assert.ok(csp.includes(`script-src ${h(script)}`));
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/style="/.test(html), 'no inline style attributes (the policy would block them)');
});

test('full profile shows accounts, defaults, company and apps', () => {
  const html = render(fullProfile());
  assert.match(html, /Connected as janedoe/);
  assert.match(html, /Team: jane-team/);
  assert.match(html, /Connected, organization Jane Org/);
  assert.match(html, /Key works, domain jane\.dev/);
  assert.match(html, /Key works, test mode/);
  assert.match(html, /Setup: 3 of 10 steps done\. Next: supabase\./);
  assert.match(html, /Jane Ltd/);
  assert.match(html, /EL123/);
  assert.match(html, /jane\.dev/);
  assert.match(html, /Calm and paper-like/);
  assert.match(html, /Jane Doe/);
  assert.match(html, /en, el/);
  // app card
  assert.match(html, /<h3>Notes<\/h3>/);
  assert.match(html, /<span class="pill">Live<\/span>/);
  assert.match(html, /<a href="https:\/\/notes\.example\.com\/"[^>]*>https:\/\/notes\.example\.com<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/janedoe\/notes"/);
  assert.match(html, /<code>abcdefghijklmnop<\/code> · Running/);
  assert.match(html, /Sidebar \(for tools\)/);
  assert.match(html, /auth, items/);
  assert.match(html, /Passed/);
  assert.match(html, /15 Oct 2026, \d\d:\d\d/);
  // second app falls back to its slug
  assert.match(html, /<h3>todo<\/h3>/);
  assert.match(html, /Just created/);
  assert.match(html, /Not checked yet/);
});

test('every Change button copies a Shipyard sentence', () => {
  const html = render(fullProfile());
  const sentences = [...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1].replace(/&#39;/g, "'"));
  assert.ok(sentences.length > 20);
  for (const s of sentences) assert.match(s, /^Shipyard: /);
  assert.ok(sentences.includes('Shipyard: set my default layout to sidebar'));
  assert.ok(sentences.includes("Shipyard: change Notes's layout to bottom-nav"));
  assert.ok(sentences.includes("Shipyard: change todo's layout to sidebar"));
  assert.ok(sentences.includes('Shipyard: change my GitHub account'));
  assert.ok(sentences.includes('Shipyard: verify Notes again'));
  assert.match(html, />Change<\/button>/);
  assert.match(html, /Copied, paste it into Claude/);
});

test('switching a default turns the toggle sentence around', () => {
  const p = defaultProfile();
  p.defaults.layout = 'sidebar';
  p.defaults.pwa = false;
  const html = render(p);
  assert.match(html, /Shipyard: set my default layout to bottom-nav/);
  assert.match(html, /Shipyard: turn installable web apps on by default/);
  assert.match(html, /Shipyard: turn budget mode off/);
});

test('escapes every value, including attributes and links', () => {
  const p = fullProfile();
  const evil = '<script>alert(1)</script>';
  p.owner.name = evil;
  p.company.legalName = '"><img src=x onerror=alert(2)>';
  p.defaults.design = "'; drop table --";
  p.apps[0].name = `<b>"quoted"</b> & co`;
  p.apps[0].url = 'javascript:alert(3)';
  p.apps[0].repo = '<svg onload=alert(4)>';
  p.apps[0].modules = ['<i>x</i>'];
  p.apps[0].supabaseRef = '<u>ref</u>';
  p.apps[0].status = '<s>live</s>';
  p.apps[0].lastVerify = { ok: false, failed: 2, at: '2026-10-15T09:30:00Z' };
  const html = render(p);
  const body = html.split('</style>')[1].split('<script>')[0];
  for (const bad of ['<script>alert', '<img src=x', '<svg onload', '<b>"quoted"', '<i>x</i>', '<u>ref', '<s>live', "'; drop"]) {
    assert.ok(!body.includes(bad), `unescaped: ${bad}`);
  }
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body, /&lt;b&gt;&quot;quoted&quot;&lt;\/b&gt; &amp; co/);
  assert.match(body, /data-copy="Shipyard: verify &lt;b&gt;&quot;quoted&quot;&lt;\/b&gt; &amp; co again"/);
  assert.match(body, /Failed, 2 problems/);
  assert.ok(!/<a href="javascript/.test(body));
  assert.equal([...html.matchAll(/<script>/g)].length, 1, 'only our own script');
});

test('esc, formatTime, describeVerify', () => {
  assert.equal(esc(`<a href="x">'&\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
  assert.equal(esc(null), '');
  assert.equal(formatTime('not a date'), '');
  assert.equal(formatTime(''), '');
  assert.equal(formatTime(new Date(2026, 0, 5, 7, 8)), '5 Jan 2026, 07:08');
  assert.match(describeVerify(null).html, /Not checked yet/);
  assert.match(describeVerify({ failed: 0 }).html, /Passed/);
  assert.match(describeVerify({ status: 'FAILED', failures: [1] }).html, /Failed, 1 problem</);
  assert.match(describeVerify({}).html, /Checked/);
});

test('keys: saved, odd format and missing are told apart; names only', () => {
  const keys = KNOWN_SECRETS.map((k, i) => ({ name: k.name, present: i < 2, looksValid: i === 0, required: k.required }));
  const html = render(defaultProfile(), keys);
  assert.match(html, /✓<\/span> Saved</);
  assert.match(html, /Saved, but the format looks off/);
  assert.match(html, /<code>SUPABASE_ACCESS_TOKEN<\/code> · required/);
  assert.match(html, /Shipyard: update my SUPABASE_ACCESS_TOKEN key/);
  assert.match(html, /Shipyard: add my RESEND_API_KEY key/);
});

test('no em dashes, no gradients, no external fonts', () => {
  const html = render(fullProfile());
  assert.ok(!html.includes('—'));
  assert.ok(!/gradient/i.test(html));
  assert.ok(!/@font-face|fonts\.googleapis/.test(html));
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /name="viewport"/);
});

// ---- the real script ----

test('script: writes the file privately, never includes key values, honours --no-open', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'settings-'));
  try {
    const marker = `sbp_${'MARKER12345'.repeat(3)}`;
    const marker2 = `sk-or-v1-${'SECRETVALUE'.repeat(3)}`;
    await writeFile(path.join(home, 'secrets.env'), `SUPABASE_ACCESS_TOKEN=${marker}\nOPENROUTER_API_KEY=${marker2}\n`);
    await writeFile(path.join(home, 'profile.json'), JSON.stringify(fullProfile()));
    const r = spawnSync(process.execPath, [SCRIPT, '--no-open'], { env: { ...process.env, SHIPYARD_HOME: home, NO_COLOR: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(home, 'settings.html');
    assert.match(r.stdout, /Settings page ready/);
    const html = await readFile(file, 'utf8');
    assert.ok(!html.includes(marker) && !html.includes(marker2));
    assert.ok(!r.stdout.includes(marker));
    assert.match(html, /Supabase access token/);
    assert.match(html, /✓<\/span> Saved/);
    assert.match(html, /<h3>Notes<\/h3>/);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

    const j = spawnSync(process.execPath, [SCRIPT, '--no-open', '--json'], { env: { ...process.env, SHIPYARD_HOME: home }, encoding: 'utf8' });
    const out = JSON.parse(j.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.opened, false);
    assert.equal(out.path, file);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('script: works on a first run with no files, bad flag is 2, --help is 0', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'settings-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--no-open'], { env: { ...process.env, SHIPYARD_HOME: path.join(home, 'new') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(await readFile(path.join(home, 'new', 'settings.html'), 'utf8'), /No apps yet/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('launch row: unset, partly done and fully done, escaped', async () => {
  const { describeLaunch } = await import('../scripts/settings-page.mjs');
  const none = describeLaunch({ url: 'https://x.vercel.app', modules: [] });
  assert.match(none, /Own address: not yet/);
  assert.match(none, /Payments: not added/);
  assert.match(none, /Store apps: none/);
  const part = describeLaunch({ url: 'https://notes.example.com', modules: ['billing'] });
  assert.match(part, /Own address: notes\.example\.com/);
  assert.match(part, /Payments: added, not set up/);
  const full = describeLaunch({
    modules: ['billing'],
    launch: { domain: 'a.dev', emailVerified: true, legalAt: '2026-10-15T09:30:00Z', billing: 'live', shells: ['mobile', 'desktop'] },
  });
  assert.match(full, /Sign-up emails verified/);
  assert.match(full, /Legal pages made 15 Oct 2026/);
  assert.match(full, /Payments: live/);
  assert.match(full, /Store apps: mobile, desktop/);
  assert.ok(!/<script|<b>/.test(describeLaunch({ launch: { domain: '<b>x</b>', shells: ['<script>'] } })));
  const html = render(fullProfile());
  assert.match(html, /Shipyard: launch Notes/);
  assert.doesNotThrow(() => describeLaunch({ launch: 'junk', url: 5, modules: 'x' }));
});

test('ops and video rows: unset, partly done, done, escaped', async () => {
  const { describeOps, describeVideo } = await import('../scripts/settings-page.mjs');
  const none = describeOps({ modules: [] });
  assert.match(none, /Error log and alerts: not added/);
  assert.match(none, /Health checks: not set up/);
  assert.match(none, /Backups: none yet/);
  const full = describeOps({ modules: ['errors'], ops: { health: true, review: true, automerge: true, backupAt: '2026-10-15T09:30:00Z' } });
  assert.match(full, /Error log and alerts: on/);
  assert.match(full, /Health checks every 6 hours/);
  assert.match(full, /Code review on every pull request/);
  assert.match(full, /merge themselves/);
  assert.match(full, /Last backup 15 Oct 2026/);
  assert.match(describeVideo({}), /Video: not set up/);
  assert.match(describeVideo({ video: { setUp: true } }), /Published video: none yet/);
  const pub = describeVideo({ video: { setUp: true, published: [{ name: 'demo' }, { name: '<script>' }] } });
  assert.match(pub, /Published: demo, &lt;script&gt;/);
  assert.ok(!/<script/.test(pub));
  assert.doesNotThrow(() => describeOps({ ops: 'junk', modules: 'x' }));
  assert.doesNotThrow(() => describeVideo({ video: { published: 'junk' } }));
  const html = render(fullProfile());
  assert.match(html, /Shipyard: ops for Notes/);
  assert.match(html, /Shipyard: make a video for Notes/);
});

test('withDiskFacts reads the app folder and the backups folder', async () => {
  const { withDiskFacts } = await import('../scripts/settings-page.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'shipyard-diskfacts-'));
  try {
    const dir = path.join(root, 'app');
    await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
    await mkdir(path.join(dir, 'video'), { recursive: true });
    await writeFile(path.join(dir, '.github', 'workflows', 'health.yml'), 'name: x\n');
    await writeFile(path.join(dir, 'video', 'package.json'), '{}');
    await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ modules: ['errors'], video: { published: [{ name: 'demo' }] } }));
    await mkdir(path.join(root, 'home', 'backups', 'notes', '2026-10-14T08-00-00Z'), { recursive: true });
    await mkdir(path.join(root, 'home', 'backups', 'notes', '2026-10-15T09-30-00Z'), { recursive: true });
    const out = await withDiskFacts({ slug: 'notes', dir }, { homeDir: path.join(root, 'home') });
    assert.equal(out.ops.errors, true);
    assert.equal(out.ops.health, true);
    assert.equal(out.ops.automerge, false);
    assert.equal(out.ops.review, false);
    assert.equal(out.ops.backupAt, '2026-10-15T09:30:00Z');
    assert.equal(out.video.setUp, true);
    assert.equal(out.video.published[0].name, 'demo');
    const missing = await withDiskFacts({ slug: 'nope', dir: path.join(root, 'nothing') }, { homeDir: path.join(root, 'home') });
    assert.equal(missing.ops.health, false);
    assert.equal(missing.video.setUp, false);
    assert.doesNotThrow(() => withDiskFacts({ slug: '../x', dir: 5 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
