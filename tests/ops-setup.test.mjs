// ops-setup against a scaffolded app with a fake GitHub and a fake Vercel. No network, no real gh or vercel.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { makeFakes, tempHome, TEMPLATES, FAKE_SECRET } from './ops-helpers.mjs';

const sandbox = await tempHome();
process.env.SHIPYARD_HOME = sandbox.home;

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { readAppConfig, updateAppConfig } = await import('../scripts/provision/common.mjs');
const { run: realRun, which } = await import('../scripts/lib/run.mjs');
const { loadProfile } = await import('../scripts/lib/profile.mjs');
const S = await import('../scripts/ops/setup-core.mjs');
const C = await import('../scripts/ops/common.mjs');
const haveGit = (await which('git')) !== null;

after(() => sandbox.cleanup());

let n = 0;
async function makeApp({ remote = 'https://github.com/test-user/tea-shop.git', siteUrl = 'https://tea-shop.vercel.app' } = {}) {
  const slug = `tea-shop${n++ === 0 ? '' : `-${n}`}`;
  const parent = path.join(sandbox.dir, `app${n}`);
  await scaffold({ slug, name: 'Tea Shop', description: 'Order tea', parent });
  const dir = path.join(parent, slug);
  if (remote) await realRun('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  if (siteUrl) await updateAppConfig(dir, { siteUrl, vercelProject: slug });
  return { dir, slug };
}
const setup = (app, fakes, opts = {}, deps = {}) => S.opsSetup({ appDir: app.dir, ...opts }, { run: fakes.run, vercel: fakes.vercel, randomSecret: () => FAKE_SECRET, ...deps });
const fakes = () => makeFakes({ gitRun: realRun });
const read = (dir, rel) => readFile(path.join(dir, ...rel.split('/')), 'utf8');
const tpl = (rel) => readFile(path.join(TEMPLATES, ...rel.split('/')), 'utf8');
const ghCalls = (f, ...words) => f.calls.filter((c) => c.cmd === 'gh' && words.every((w) => c.args.includes(w)));
const ALL = ['.github/workflows/health.yml', '.coderabbit.yaml', '.github/workflows/automerge.yml', '.github/ops/automerge-check.mjs', '.github/dependabot.yml'];

test('first run: writes every file exactly as the template, adds the error log module, makes labels, sets SITE_URL and CRON_SECRET', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  const r = await setup(app, f);
  assert.equal(r.ok, true, r.problems.join());
  for (const rel of ALL) {
    assert.equal(await read(app.dir, rel), await tpl(rel), rel);
    assert.equal(r.files.find((x) => x.path === rel).status, 'created');
  }
  assert.equal(r.errorsModule.status, 'added');
  assert.deepEqual((await readAppConfig(app.dir)).modules, ['errors']);
  assert.ok(await stat(path.join(app.dir, 'src', 'app', 'api', 'ops', 'summary', 'route.ts')));
  assert.deepEqual([...f.state.labels].sort(), ['automerge', 'needs-review', 'ops-alert']);
  assert.equal(f.state.vars.SITE_URL, 'https://tea-shop.vercel.app');
  assert.equal(r.cronSecret.status, 'set');
  assert.ok(f.state.secrets.includes('CRON_SECRET'));
  assert.equal(r.repository, 'test-user/tea-shop');
});

test('CRON_SECRET goes to GitHub through stdin and to Vercel as a value, and appears in no argument, result or file', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  const r = await setup(app, f);
  assert.equal(f.state.lastSecretInput, FAKE_SECRET, 'GitHub got the value through stdin');
  const secretCall = ghCalls(f, 'secret', 'set')[0];
  assert.deepEqual(secretCall.args, ['secret', 'set', 'CRON_SECRET', '--repo', 'test-user/tea-shop', '--app', 'actions']);
  const add = f.vercelCalls.find((c) => c.fn === 'envAdd');
  assert.equal(add.name, 'CRON_SECRET');
  assert.equal(add.value, FAKE_SECRET);
  assert.deepEqual(add.target, ['production']);
  for (const c of f.calls) assert.ok(!c.args.join(' ').includes(FAKE_SECRET), `secret in arguments of ${c.args.join(' ')}`);
  assert.ok(!JSON.stringify(r).includes(FAKE_SECRET), 'not in the result');
  assert.ok(!(await readFile(path.join(app.dir, '.shipyard-app.json'), 'utf8')).includes(FAKE_SECRET));
  const profile = JSON.stringify(await loadProfile());
  assert.ok(!profile.includes(FAKE_SECRET));
  // the same value on both sides
  assert.equal(add.value, f.state.lastSecretInput);
});

test('the real random secret is 64 hex characters (32 random bytes)', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await S.opsSetup({ appDir: app.dir }, { run: f.run, vercel: f.vercel });
  assert.match(f.state.lastSecretInput, /^[0-9a-f]{64}$/);
  const second = await makeApp();
  const g = fakes();
  await S.opsSetup({ appDir: second.dir }, { run: g.run, vercel: g.vercel });
  assert.notEqual(f.state.lastSecretInput, g.state.lastSecretInput);
});

test('running again changes nothing: files unchanged, the secret is kept, the variable is left', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await setup(app, f);
  const adds = f.vercelCalls.filter((c) => c.fn === 'envAdd').length;
  const secretSets = ghCalls(f, 'secret', 'set').length;
  const r = await setup(app, f);
  assert.equal(r.ok, true);
  assert.ok(r.files.every((x) => x.status === 'unchanged'), JSON.stringify(r.files));
  assert.equal(r.errorsModule.status, 'present');
  assert.equal(r.cronSecret.status, 'kept');
  assert.equal(r.variable.status, 'unchanged');
  assert.equal(f.vercelCalls.filter((c) => c.fn === 'envAdd').length, adds);
  assert.equal(ghCalls(f, 'secret', 'set').length, secretSets);
  assert.ok(!ghCalls(f, 'variable', 'set').length || ghCalls(f, 'variable', 'set').length === 1);
});

test('a file the student changed is not overwritten: the lines that differ are shown', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await setup(app, f);
  const file = path.join(app.dir, '.github', 'dependabot.yml');
  const mine = (await readFile(file, 'utf8')).replace('interval: "weekly"', 'interval: "daily"');
  await writeFile(file, mine);
  const r = await setup(app, f);
  const dep = r.files.find((x) => x.path === '.github/dependabot.yml');
  assert.equal(dep.status, 'kept');
  assert.equal(await readFile(file, 'utf8'), mine, 'the student\'s file is untouched');
  assert.ok(dep.diff.lines.some((d) => d.type === '-' && d.text.includes('daily')));
  assert.ok(dep.diff.lines.some((d) => d.type === '+' && d.text.includes('weekly')));
  assert.equal(r.ok, true);
});

test('--force-file replaces one changed file with the Shipyard version', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await setup(app, f);
  const file = path.join(app.dir, '.coderabbit.yaml');
  await writeFile(file, '# my own\nlanguage: "de"\n');
  const r = await setup(app, f, { forceFiles: ['.coderabbit.yaml'] });
  assert.equal(r.files.find((x) => x.path === '.coderabbit.yaml').status, 'replaced');
  assert.equal(await readFile(file, 'utf8'), await tpl('.coderabbit.yaml'));
});

test('--force-file for a file ops does not write is a usage error', { skip: !haveGit }, async () => {
  const app = await makeApp();
  await assert.rejects(setup(app, fakes(), { only: ['deps'], forceFiles: ['.coderabbit.yaml'] }), /--force-file/);
  await assert.rejects(setup(app, fakes(), { forceFiles: ['package.json'] }), /only writes/);
});

test('a file Shipyard wrote earlier and the student never touched is brought up to date', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await setup(app, f, { only: ['deps'] });
  const rel = '.github/dependabot.yml';
  const old = '# an older Shipyard version\nversion: 2\nupdates: []\n';
  await writeFile(path.join(app.dir, rel), old);
  await updateAppConfig(app.dir, { ops: { ...(await readAppConfig(app.dir)).ops, files: { [rel]: C.sha256(old) } } });
  const r = await setup(app, f, { only: ['deps'] });
  assert.equal(r.files[0].status, 'updated');
  assert.equal(await read(app.dir, rel), await tpl(rel));
});

test('Windows line endings in the app do not count as an edit', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await setup(app, f, { only: ['review'] });
  const file = path.join(app.dir, '.coderabbit.yaml');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/\n/g, '\r\n'));
  const r = await setup(app, f, { only: ['review'] });
  assert.equal(r.files[0].status, 'unchanged');
});

test('a link where a file should go is refused, and nothing is written through it', { skip: !haveGit || process.platform === 'win32' }, async () => {
  const app = await makeApp();
  await mkdir(path.join(app.dir, '.github'), { recursive: true });
  const victim = path.join(sandbox.dir, 'victim.txt');
  await writeFile(victim, 'keep me');
  await symlink(victim, path.join(app.dir, '.github', 'dependabot.yml'));
  const r = await setup(app, fakes(), { only: ['deps'] });
  assert.equal(r.files[0].status, 'refused');
  assert.equal(r.ok, false);
  assert.equal(await readFile(victim, 'utf8'), 'keep me');
});

test('--only deps writes one file and touches neither GitHub nor Vercel nor the modules', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  const r = await setup(app, f, { only: ['deps'] });
  assert.deepEqual(r.files.map((x) => x.path), ['.github/dependabot.yml']);
  assert.equal(r.errorsModule, null);
  assert.equal(f.calls.filter((c) => c.cmd === 'gh').length, 0);
  assert.equal(f.vercelCalls.length, 0);
  assert.deepEqual((await readAppConfig(app.dir)).modules, []);
  await assert.rejects(readFile(path.join(app.dir, '.github', 'workflows', 'health.yml'), 'utf8'), /ENOENT/);
});

test('--only review says how to install CodeRabbit and the free alternative', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const r = await setup(app, fakes(), { only: ['review'] });
  const text = r.next.join('\n');
  assert.match(text, /github\.com\/apps\/coderabbitai/);
  assert.match(text, /\/code-review/);
  assert.match(text, /public repositories/);
});

test('--only health needs no auto-merge labels; --only automerge makes no CRON_SECRET', { skip: !haveGit }, async () => {
  const a = await makeApp();
  const f1 = fakes();
  await setup(a, f1, { only: ['health'] });
  assert.deepEqual(f1.state.labels, ['ops-alert']);
  const b = await makeApp();
  const f2 = fakes();
  await setup(b, f2, { only: ['automerge'] });
  assert.deepEqual([...f2.state.labels].sort(), ['automerge', 'needs-review']);
  assert.equal(f2.vercelCalls.length, 0);
  assert.equal(ghCalls(f2, 'secret').length, 0);
  assert.deepEqual((await readAppConfig(b.dir)).modules, [], 'auto-merge does not need the error log module');
});

test('no GitHub address yet: the files are still written, the GitHub part is listed as still to do', { skip: !haveGit }, async () => {
  const app = await makeApp({ remote: null });
  const f = fakes();
  const r = await setup(app, f);
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
  assert.match(r.pending.join(), /not on GitHub yet/);
  assert.equal(r.files.filter((x) => x.status === 'created').length, ALL.length);
  assert.equal(f.calls.filter((c) => c.cmd === 'gh').length, 0);
  assert.equal(r.cronSecret, null);
});

test('a remote that is not github.com is treated as no GitHub repository', { skip: !haveGit }, async () => {
  const app = await makeApp({ remote: 'https://gitlab.com/me/app.git' });
  const r = await setup(app, fakes(), { only: ['health'] });
  assert.match(r.pending.join(), /not a github\.com repository/);
});

test('not logged in to GitHub: says so in plain words and still writes the files', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  f.state.loggedIn = false;
  const r = await setup(app, f);
  assert.match(r.pending.join(), /gh auth login/);
  assert.equal(r.files.length, ALL.length);
  assert.equal(f.vercelCalls.length, 0, 'no secret made when GitHub can not be reached');
});

test('gh not installed: a plain message that points to setup', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = makeFakes({ gitRun: realRun, overrides: { 'auth status': { code: 127, stdout: '', stderr: 'Command not found: gh' } } });
  const r = await setup(app, f, { only: ['automerge'] });
  assert.match(r.pending.join(), /shipyard:setup/);
});

test('GitHub issues switched off: the health check could not open alerts, so the student is told', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const r = await setup(app, makeFakes({ gitRun: realRun, repoInfo: { has_issues: false } }), { only: ['health'] });
  assert.match(r.pending.join(), /Issues are switched off/);
});

test('no live address yet: SITE_URL is not set and the student is told to deploy first', { skip: !haveGit }, async () => {
  const app = await makeApp({ siteUrl: null });
  const f = fakes();
  const r = await setup(app, f, { only: ['health'] });
  assert.equal(r.variable.status, 'missing');
  assert.match(r.pending.join(), /Deploy first/);
  assert.equal(ghCalls(f, 'variable', 'set').length, 0);
});

test('a new address (custom domain) updates the SITE_URL variable', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await setup(app, f, { only: ['health'] });
  await updateAppConfig(app.dir, { launch: { domain: { name: 'tea.example', url: 'https://tea.example' } } });
  const r = await setup(app, f, { only: ['health'] });
  assert.equal(r.variable.status, 'updated');
  assert.equal(f.state.vars.SITE_URL, 'https://tea.example');
});

test('CRON_SECRET: Vercel failure stops before GitHub, reports a problem, and a re-run tries again', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  f.vercelState.failAdd = true;
  const r = await setup(app, f, { only: ['health'] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /Could not send CRON_SECRET to Vercel/);
  assert.equal(ghCalls(f, 'secret', 'set').length, 0);
  assert.equal((await readAppConfig(app.dir)).ops.cronSecretAt, undefined);
  f.vercelState.failAdd = false;
  const again = await setup(app, f, { only: ['health'] });
  assert.equal(again.ok, true);
  assert.equal(again.cronSecret.status, 'set');
});

test('CRON_SECRET: GitHub refusing it after Vercel took it is a problem, and the next run replaces it on both sides', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = makeFakes({ gitRun: realRun, overrides: { 'secret set': { code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' } } });
  const r = await setup(app, f, { only: ['health'] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /GitHub did not accept it/);
  assert.equal((await readAppConfig(app.dir)).ops.cronSecretAt, undefined, 'not recorded as done');
  // GitHub works again: Vercel already has a (now unknown) value, so both get a fresh one
  const g = makeFakes({ gitRun: realRun, vercelEnv: ['CRON_SECRET'] });
  g.state.secrets.push('CRON_SECRET');
  const again = await setup(app, g, { only: ['health'] }, { randomSecret: () => 'b'.repeat(64) });
  assert.equal(again.cronSecret.status, 'rotated');
  assert.equal(g.vercelCalls.find((c) => c.fn === 'envAdd').value, 'b'.repeat(64));
  assert.equal(g.state.lastSecretInput, 'b'.repeat(64));
});

test('CRON_SECRET: only on one side means a fresh one on both; --rotate-secret forces it', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = makeFakes({ gitRun: realRun, vercelEnv: ['CRON_SECRET'] });
  const r = await setup(app, f, { only: ['health'] });
  assert.equal(r.cronSecret.status, 'rotated');
  const kept = await setup(app, f, { only: ['health'] });
  assert.equal(kept.cronSecret.status, 'kept');
  const forced = await setup(app, f, { only: ['health'], rotateSecret: true }, { randomSecret: () => 'c'.repeat(64) });
  assert.equal(forced.cronSecret.status, 'rotated');
  assert.equal(f.state.lastSecretInput, 'c'.repeat(64));
});

test('the error log module cannot be added (an old app): the health part is skipped, the rest still happens', { skip: !haveGit }, async () => {
  const app = await makeApp();
  await rm(path.join(app.dir, 'src', 'lib', 'health', 'checks.ts'), { force: true });
  const f = fakes();
  const r = await setup(app, f);
  assert.equal(r.errorsModule.status, 'blocked');
  assert.equal(r.ok, false);
  assert.ok(!r.files.some((x) => x.path.endsWith('health.yml')), 'no health workflow without the page it reads');
  assert.ok(r.files.some((x) => x.path === '.github/dependabot.yml'));
  assert.equal(ghCalls(f, 'secret', 'set').length, 0);
});

// ---------------------------------------------------------------------------------------------
// Repository settings

test('settings: looked at and listed, but nothing changed, until the student said yes', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  const r = await setup(app, f, { only: ['automerge'] });
  assert.deepEqual(r.settings.proposals.map((p) => p.id), ['allow_auto_merge', 'delete_branch_on_merge', 'require_checks']);
  assert.equal(r.complete, false);
  assert.match(r.pending.join('\n'), /--apply-settings/);
  assert.equal(f.calls.filter((c) => c.cmd === 'gh' && c.args.includes('-X')).length, 0, 'no PATCH or POST');
});

test('settings: with --apply-settings it turns on auto-merge, branch clean-up and a rule that waits for the test check', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  const r = await setup(app, f, { only: ['automerge'], applySettings: true });
  assert.equal(r.ok, true, r.problems.join());
  assert.deepEqual(f.state.patched, ['repos/test-user/tea-shop', '-F', 'allow_auto_merge=true', '-F', 'delete_branch_on_merge=true']);
  const rule = f.state.postedRuleset;
  assert.equal(rule.enforcement, 'active');
  assert.equal(rule.target, 'branch');
  assert.deepEqual(rule.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.equal(rule.rules[0].type, 'required_status_checks');
  assert.deepEqual(rule.rules[0].parameters.required_status_checks, [{ context: 'test', integration_id: 15368 }]);
  assert.ok(!('bypass_actors' in rule));
  assert.deepEqual(r.settings.applied.sort(), ['allow_auto_merge', 'delete_branch_on_merge', 'require_checks']);
  assert.equal(r.complete, true);
});

test('settings: applying twice does not make a second rule, and leaves settings that are already right', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  await setup(app, f, { only: ['automerge'], applySettings: true });
  const posts = f.calls.filter((c) => c.args.includes('POST')).length;
  const again = await setup(app, f, { only: ['automerge'], applySettings: true });
  assert.equal(f.calls.filter((c) => c.args.includes('POST')).length, posts);
  assert.deepEqual(again.settings.proposals, []);
  assert.equal(again.complete, true);
});

test('settings: an existing protection that already requires checks is left alone', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = fakes();
  f.state.protectedChecks = true;
  f.state.repo.allow_auto_merge = true;
  f.state.repo.delete_branch_on_merge = true;
  const r = await setup(app, f, { only: ['automerge'], applySettings: true });
  assert.deepEqual(r.settings.proposals, []);
  assert.equal(f.state.postedRuleset, null);
});

test('settings: the rule asks for the check name the app\'s own test workflow really has', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const wf = path.join(app.dir, '.github', 'workflows', 'test.yml');
  await writeFile(wf, (await readFile(wf, 'utf8')).replace('  test:\n', '  test:\n    name: Run the tests\n'));
  const f = fakes();
  await setup(app, f, { only: ['automerge'], applySettings: true });
  assert.deepEqual(f.state.postedRuleset.rules[0].parameters.required_status_checks, [{ context: 'Run the tests', integration_id: 15368 }]);
});

test('testCheckName: job name, job id, quoted names, expressions, no jobs', () => {
  assert.equal(S.testCheckName('name: Tests\njobs:\n  test:\n    runs-on: x\n'), 'test');
  assert.equal(S.testCheckName('jobs:\n  build:\n    name: "Build it"\n    runs-on: x\n  other:\n    name: nope\n'), 'Build it');
  assert.equal(S.testCheckName("jobs:\n  build:\n    name: 'Build it'\n"), 'Build it');
  assert.equal(S.testCheckName('jobs:\n  build:\n    name: Build ${{ matrix.os }}\n'), 'build');
  assert.equal(S.testCheckName('name: x\n'), 'test');
  assert.equal(S.testCheckName(''), 'test');
  assert.equal(S.testCheckName(undefined), 'test');
});

test('settings: a free private repository can not require checks; that is explained, not a failure', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = makeFakes({
    gitRun: realRun, repoInfo: { private: true },
    overrides: { 'api -X POST': { code: 1, stdout: '', stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' } },
  });
  const r = await setup(app, f, { only: ['automerge'], applySettings: true });
  assert.equal(r.ok, true, r.problems.join());
  assert.equal(r.complete, false);
  assert.match(r.pending.join(), /paid GitHub plan, or make the repository public/);
  assert.equal(r.settings.failed[0].planLimit, true);
});

test('settings: a real error while changing them is a problem with a plain message', { skip: !haveGit }, async () => {
  const app = await makeApp();
  const f = makeFakes({ gitRun: realRun, overrides: { 'api -X PATCH': { code: 1, stdout: '', stderr: 'gh: Must have admin rights to Repository. (HTTP 403)' } } });
  const r = await setup(app, f, { only: ['automerge'], applySettings: true });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /owner or an admin/);
});

// ---------------------------------------------------------------------------------------------
// Records

test('what was set up is written to the app file and the profile (no secrets), for the settings page', { skip: !haveGit }, async () => {
  const app = await makeApp();
  await setup(app, fakes());
  const ops = (await readAppConfig(app.dir)).ops;
  assert.equal(Object.keys(ops.files).length, ALL.length);
  for (const h of Object.values(ops.files)) assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(ops.setupAt && ops.cronSecretAt);
  const entry = (await loadProfile()).apps.find((a) => a.slug === app.slug);
  assert.deepEqual(entry.ops, { health: true, review: true, automerge: true, deps: true });
});

test('parseOnly: names in a fixed order, commas or repeated, unknown names refused', () => {
  assert.deepEqual(S.parseOnly([]), ['health', 'review', 'automerge', 'deps']);
  assert.deepEqual(S.parseOnly(['deps,health']), ['health', 'deps']);
  assert.deepEqual(S.parseOnly(['review', 'automerge']), ['review', 'automerge']);
  assert.throws(() => S.parseOnly(['health,nope']), /nope/);
});

test('repoSlugFrom: github.com remotes in the usual spellings, nothing else', () => {
  assert.equal(C.repoSlugFrom('https://github.com/me/app.git'), 'me/app');
  assert.equal(C.repoSlugFrom('https://me:ghp_secretvalue@github.com/me/app.git'), 'me/app');
  assert.equal(C.repoSlugFrom('git@github.com:me/app.git'), 'me/app');
  assert.equal(C.repoSlugFrom('https://github.com/me/my.app-1'), 'me/my.app-1');
  assert.equal(C.repoSlugFrom('https://gitlab.com/me/app.git'), null);
  assert.equal(C.repoSlugFrom('https://github.com.evil.com/me/app.git'), null);
  assert.equal(C.repoSlugFrom('https://github.com/me'), null);
  assert.equal(C.repoSlugFrom(''), null);
});

test('diffLines: shows removed and added lines with their numbers, and caps long output', () => {
  const d = C.diffLines('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(d.lines, [{ type: '-', line: 2, text: 'b' }, { type: '+', line: 2, text: 'B' }]);
  const big = C.diffLines(Array.from({ length: 100 }, (_, i) => `x${i}`).join('\n'), Array.from({ length: 100 }, (_, i) => `y${i}`).join('\n'));
  assert.equal(big.lines.length, 24);
  assert.equal(big.more, 176);
  assert.deepEqual(C.diffLines('same\n', 'same\n'), { lines: [], more: 0 });
});

