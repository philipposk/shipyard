// ops-status against a fake GitHub and a fake Vercel: what it reports when nothing, some, or everything is set up.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeFakes, tempHome, FAKE_SECRET } from './ops-helpers.mjs';

const sandbox = await tempHome();
process.env.SHIPYARD_HOME = sandbox.home;

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { updateAppConfig } = await import('../scripts/provision/common.mjs');
const { run: realRun, which } = await import('../scripts/lib/run.mjs');
const Setup = await import('../scripts/ops/setup-core.mjs');
const Status = await import('../scripts/ops/status-core.mjs');
const haveGit = (await which('git')) !== null;

after(() => sandbox.cleanup());

let n = 0;
async function makeApp({ remote = 'https://github.com/test-user/tea-shop.git' } = {}) {
  const slug = `st-app-${++n}`;
  const parent = path.join(sandbox.dir, `app${n}`);
  await scaffold({ slug, name: 'Status App', description: 'x', parent });
  const dir = path.join(parent, slug);
  if (remote) await realRun('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  await updateAppConfig(dir, { siteUrl: 'https://status-app.vercel.app' });
  return { dir, slug };
}
const status = (app, f, extra = {}) => Status.opsStatus({ appDir: app.dir }, { run: f.run, vercel: f.vercel, homeDir: sandbox.home, ...extra });
const item = (r, id) => r.items.find((i) => i.id === id);
const fakes = (o = {}) => makeFakes({ gitRun: realRun, repo: 'test-user/tea-shop', ...o });
const fullSetup = async (app, f) => Setup.opsSetup({ appDir: app.dir, applySettings: true }, { run: f.run, vercel: f.vercel, randomSecret: () => FAKE_SECRET });

test('nothing set up: every part says "not set up", nothing is broken, each has the command that fixes it', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const r = await status(app, fakes());
  assert.equal(r.ok, true);
  assert.equal(r.repository, 'test-user/tea-shop');
  for (const id of ['errors', 'health', 'cron-secret', 'site-url', 'review', 'automerge', 'deps', 'backup']) assert.equal(item(r, id).status, 'off', id);
  assert.match(item(r, 'health').next, /ops-setup\.mjs .* --only health/);
  assert.match(item(r, 'backup').next, /backup-export\.mjs/);
});

test('everything set up and working: all ok', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  f.state.runs = [{ status: 'completed', conclusion: 'success', createdAt: '2026-10-16T12:17:00Z', url: 'https://github.com/x/runs/1' }];
  await fullSetup(app, f);
  const dir = path.join(sandbox.home, 'backups', app.slug, '2026-10-10T08-00-00Z');
  await mkdir(dir, { recursive: true });
  const r = await status(app, f, { now: () => new Date('2026-10-16T13:00:00Z') });
  assert.deepEqual(r.items.filter((i) => i.status !== 'ok').map((i) => `${i.id}:${i.status}:${i.detail}`), []);
  assert.equal(r.ok, true);
  assert.match(item(r, 'health').detail, /Last run 2026-10-16 12:17 UTC: all fine/);
  assert.match(item(r, 'backup').detail, /2026-10-10 08:00 UTC/);
  assert.equal(r.visibility, 'public');
});

test('an open ops-alert issue and a failed last run are failures', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await fullSetup(app, f);
  f.state.runs = [{ status: 'completed', conclusion: 'failure', createdAt: '2026-10-16T12:17:00Z', url: 'https://github.com/x/runs/9' }];
  let r = await status(app, f);
  assert.equal(item(r, 'health').status, 'fail');
  assert.match(item(r, 'health').detail, /ended with "failure"/);
  assert.equal(r.ok, false);
  f.state.issues = [{ number: 12, url: 'u' }, { number: 14, url: 'u' }];
  r = await status(app, f);
  assert.match(item(r, 'health').detail, /2 open alerts .*#12, #14/);
});

test('the health workflow has never run: a warning that says how to start it', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await fullSetup(app, f);
  const r = await status(app, f);
  assert.equal(item(r, 'health').status, 'warn');
  assert.match(item(r, 'health').detail, /Run workflow/);
  assert.equal(r.ok, true);
});

test('CRON_SECRET missing on GitHub or on Vercel is a failure that names where; only names are ever looked at', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await fullSetup(app, f);
  f.state.secrets = [];
  let r = await status(app, f);
  assert.equal(item(r, 'cron-secret').status, 'fail');
  assert.match(item(r, 'cron-secret').detail, /missing on GitHub\./);
  f.state.secrets = ['CRON_SECRET'];
  f.vercelState.env = [];
  r = await status(app, f);
  assert.match(item(r, 'cron-secret').detail, /missing on Vercel\./);
  assert.ok(!JSON.stringify(r).includes(FAKE_SECRET));
  assert.ok(f.calls.every((c) => !c.args.includes('get') || c.args[0] === 'variable'), 'no secret value is requested');
});

test('SITE_URL different from the app address is a warning, a missing one a failure', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await fullSetup(app, f);
  f.state.vars.SITE_URL = 'https://old.example.com';
  let r = await status(app, f);
  assert.equal(item(r, 'site-url').status, 'warn');
  delete f.state.vars.SITE_URL;
  r = await status(app, f);
  assert.equal(item(r, 'site-url').status, 'fail');
});

test('auto-merge files without the repository settings: a warning that says exactly what is missing', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes({ repoInfo: { private: true } });
  await Setup.opsSetup({ appDir: app.dir, only: ['automerge'] }, { run: f.run, vercel: f.vercel });
  const r = await status(app, f);
  assert.equal(item(r, 'automerge').status, 'warn');
  assert.match(item(r, 'automerge').detail, /Allow auto-merge" is off/);
  assert.match(item(r, 'automerge').detail, /does not wait for the tests.*paid GitHub plan/);
  assert.equal(r.visibility, 'private');
  assert.match(item(r, 'automerge').next, /--apply-settings/);
});

test('the workflow without its rules file is a warning', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await Setup.opsSetup({ appDir: app.dir, only: ['automerge'] }, { run: f.run, vercel: f.vercel });
  const { rm } = await import('node:fs/promises');
  await rm(path.join(app.dir, '.github', 'ops', 'automerge-check.mjs'));
  const r = await status(app, f);
  assert.equal(item(r, 'automerge').status, 'warn');
  assert.match(item(r, 'automerge').detail, /rules file/);
});

test('an old backup is a warning; a recent one is fine', { skip: !haveGit }, async () => {
  const app = await makeApp();
  await mkdir(path.join(sandbox.home, 'backups', app.slug, '2026-08-01T08-00-00Z'), { recursive: true });
  const r = await status(app, fakes(), { now: () => new Date('2026-10-16T08:00:00Z') });
  assert.equal(item(r, 'backup').status, 'warn');
  assert.match(item(r, 'backup').detail, /76 days ago/);
});

test('no GitHub address: the parts that need GitHub say they could not be checked', { skip: !haveGit }, async () => {
  const app = await makeApp({ remote: null });
  const f = fakes();
  await Setup.opsSetup({ appDir: app.dir, only: ['health', 'automerge'] }, { run: f.run, vercel: f.vercel });
  const r = await status(app, f);
  assert.equal(r.repository, null);
  assert.equal(item(r, 'health').status, 'warn');
  assert.match(item(r, 'health').detail, /not on GitHub yet/);
  assert.equal(item(r, 'automerge').status, 'warn');
  assert.equal(r.ok, true);
});

test('a GitHub that can not be reached does not crash the report', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await fullSetup(app, f);
  f.state.loggedIn = false;
  const r = await status(app, f);
  assert.equal(r.ok, true);
  assert.equal(item(r, 'health').status, 'warn');
  assert.match(item(r, 'health').detail, /gh auth login/);
});

test('when() formats times and survives rubbish', () => {
  assert.equal(Status.when('2026-10-16T14:03:09Z'), '2026-10-16 14:03 UTC');
  assert.equal(Status.when('nope'), '');
  assert.equal(Status.when(undefined), '');
});
