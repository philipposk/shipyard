import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-vercel-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const V = await import('../scripts/provision/vercel-core.mjs');
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { updateEnvFile } = await import('../scripts/provision/envfile.mjs');
const { readAppConfig, updateAppConfig } = await import('../scripts/provision/common.mjs');
const { loadProfile, saveProfile, defaultProfile } = await import('../scripts/lib/profile.mjs');
const { run: realRun, which } = await import('../scripts/lib/run.mjs');
const haveGit = (await which('git')) !== null;

const URL_SB = 'https://abcdefghij0123456789.supabase.co';
const ANON = `sb_publishable_${'P'.repeat(30)}`;
const SERVICE = `sb_secret_${'S'.repeat(30)}`;
const RESEND = `re_${'r'.repeat(30)}`;
const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });
const bad = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

/** Fake run(): answers git and `npx vercel` calls and records everything. */
function makeRun({ git = {}, vercel = {}, remote = 'https://me:ghp_loginTokenValue@github.com/me/box.git' } = {}) {
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input, cwd: opts.cwd });
    if (cmd === 'git') {
      const key = args.join(' ');
      if (key in git) return git[key];
      if (key === 'rev-parse --is-inside-work-tree') return ok('true\n');
      if (key === 'remote get-url origin') return ok(`${remote}\n`);
      if (key.startsWith('rev-parse --verify')) return ok('abc123\n');
      return ok();
    }
    if (cmd === 'npx') {
      const rest = args.slice(2); // after --yes <the pinned Vercel CLI>
      const key = rest[0] === 'env' ? `env ${rest[1]}` : rest[0] === 'project' ? 'project protection' : rest.slice(0, 2).join(' ').replace(/ -.*/, '');
      const handler = vercel[key] ?? vercel[rest[0]];
      if (handler) return typeof handler === 'function' ? handler(rest, opts) : handler;
      if (rest[0] === 'whoami') return ok('bob\n');
      return ok();
    }
    return ok();
  };
  return { fn, calls, vercelCalls: () => calls.filter((c) => c.cmd === 'npx').map((c) => ({ ...c, rest: c.args.slice(2) })) };
}

let n = 0;
async function makeApp({ withSupabase = true } = {}) {
  const slug = `vc-app-${++n}`;
  const parent = path.join(tmp, `p${n}`);
  await scaffold({ slug, name: slug, description: 'd', parent });
  const dir = path.join(parent, slug);
  if (withSupabase) {
    await updateEnvFile(path.join(dir, '.env.local'), {
      NEXT_PUBLIC_SUPABASE_URL: URL_SB,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE,
      ADMIN_EMAIL: 'owner@example.com',
    });
  }
  return { slug, dir };
}

before(async () => {
  const p = defaultProfile();
  p.accounts.vercel.scope = 'my-team';
  await saveProfile(p);
});
after(() => rm(tmp, { recursive: true, force: true }));

const noSecrets = async () => new Map();

test('happy path: links, sends settings by stdin, opens the site, connects git, records everything', async () => {
  const { slug, dir } = await makeApp();
  await updateAppConfig(dir, { env: [...(await readAppConfig(dir)).env, 'RESEND_API_KEY', 'OPENROUTER_API_KEY'] });
  const r = makeRun();
  const result = await V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: async () => new Map([['RESEND_API_KEY', RESEND]]) });

  assert.equal(result.ok, true);
  assert.equal(result.project, slug);
  assert.equal(result.scope, 'my-team');
  assert.equal(result.siteUrl, `https://${slug}.vercel.app`);
  assert.deepEqual(result.protection, { ok: true });
  assert.equal(result.gitConnected, true);

  const calls = r.vercelCalls();
  const first = calls.map((c) => c.rest[0]);
  assert.deepEqual(first.slice(0, 2), ['whoami', 'link']);
  const link = calls.find((c) => c.rest[0] === 'link');
  assert.deepEqual(link.rest.slice(0, 5), ['link', '--yes', '--project', slug, '--scope']);
  assert.equal(link.cwd, dir);
  assert.ok(first.indexOf('project') > first.lastIndexOf('env'));
  assert.ok(first.indexOf('git') > first.indexOf('project'));

  // Env vars: values only on stdin, production and development, site address for production only.
  const adds = calls.filter((c) => c.rest[0] === 'env' && c.rest[1] === 'add');
  const byName = new Map();
  for (const c of adds) {
    const name = c.rest[2];
    byName.set(name, [...(byName.get(name) ?? []), { target: c.rest[3], input: c.input }]);
  }
  assert.deepEqual(byName.get('NEXT_PUBLIC_SUPABASE_URL').map((x) => x.target), ['production', 'development']);
  assert.equal(byName.get('NEXT_PUBLIC_SUPABASE_URL')[0].input, URL_SB);
  assert.equal(byName.get('SUPABASE_SERVICE_ROLE_KEY')[0].input, SERVICE);
  assert.equal(byName.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')[1].input, ANON);
  assert.equal(byName.get('ADMIN_EMAIL')[0].input, 'owner@example.com');
  assert.ok(!byName.has('RESEND_API_KEY'), 'the full-access Resend key in the keys file never goes to an app (launch-email gives the app its own sending-only key)');
  assert.ok(!byName.has('OPENROUTER_API_KEY'), 'no value, nothing sent');
  assert.deepEqual(byName.get('NEXT_PUBLIC_SITE_URL'), [{ target: 'production', input: `https://${slug}.vercel.app` }]);
  assert.deepEqual(result.envMissing.sort(), ['NEXT_PUBLIC_CONTACT_EMAIL', 'NEXT_PUBLIC_ENABLE_PWA', 'NEXT_PUBLIC_SIGNUP_MODE', 'NEXT_PUBLIC_SITE_PRIVATE', 'OPENROUTER_API_KEY', 'RESEND_API_KEY']);

  // No secret ever appears on a command line.
  const argv = JSON.stringify(r.calls.map((c) => c.args));
  for (const secret of [ANON, SERVICE, RESEND]) assert.ok(!argv.includes(secret));
  assert.ok(!JSON.stringify(result).includes(SERVICE));

  // Saved.
  const cfg = await readAppConfig(dir);
  assert.equal(cfg.vercelProject, slug);
  assert.equal(cfg.siteUrl, `https://${slug}.vercel.app`);
  const app = (await loadProfile()).apps.find((a) => a.slug === slug);
  assert.equal(app.vercelProject, slug);
  assert.equal(app.status, 'provisioned');
  assert.equal(app.repo, 'https://github.com/me/box', 'the login part of the remote is dropped');
});

test('it keeps the real address after a deploy and does not downgrade a live app', async () => {
  const { slug, dir } = await makeApp();
  await updateAppConfig(dir, { url: `https://${slug}-real.vercel.app` });
  const { upsertApp } = await import('../scripts/lib/profile.mjs');
  await upsertApp({ slug, status: 'live' });
  const r = makeRun();
  const result = await V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets });
  assert.equal(result.siteUrl, `https://${slug}-real.vercel.app`);
  assert.equal((await loadProfile()).apps.find((a) => a.slug === slug).status, 'live');
});

test('"push first": not a repo, no GitHub remote, or main not pushed stop before Vercel is touched', async () => {
  const { dir } = await makeApp();
  const cases = [
    [{ 'rev-parse --is-inside-work-tree': bad('fatal: not a git repository') }, /not a git repository/],
    [{ 'remote get-url origin': bad('error: No such remote') }, /Push first.*not on GitHub/],
    [{ 'rev-parse --verify --quiet refs/remotes/origin/main': { code: 1, stdout: '', stderr: '' } }, /Push first.*main branch/],
  ];
  for (const [git, pattern] of cases) {
    const r = makeRun({ git });
    await assert.rejects(() => V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets }), pattern);
    assert.equal(r.vercelCalls().length, 0);
  }
});

test('missing Supabase settings send the student back to provision-supabase', async () => {
  const { dir } = await makeApp({ withSupabase: false });
  const r = makeRun();
  await assert.rejects(() => V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets }), /provision-supabase\.mjs/);
  assert.equal(r.vercelCalls().length, 0);
});

test('not logged in to Vercel stops with the setup step', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ vercel: { whoami: bad('Error: No existing credentials found.') } });
  await assert.rejects(() => V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets }), (e) => /shipyard:setup/.test(e.message) && /credentials/.test(e.message));
  assert.ok(!r.vercelCalls().some((c) => c.rest[0] === 'link'));
});

test('a project that can not be linked is reported', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ vercel: { link: bad('Error: The name is already taken') } });
  await assert.rejects(() => V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets }), /already taken/);
  assert.ok(!r.vercelCalls().some((c) => c.rest[0] === 'env'));
});

test('a setting Vercel refuses is named, without its value', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ vercel: { 'env add': (rest, opts) => (rest[2] === 'SUPABASE_SERVICE_ROLE_KEY' ? bad(`Error: rejected ${opts.input}`) : ok()) } });
  await assert.rejects(
    () => V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets }),
    (e) => /SUPABASE_SERVICE_ROLE_KEY/.test(e.message) && !e.message.includes(SERVICE) && Array.isArray(e.data.envFailed),
  );
});

test('when Vercel can not switch off its login page, the student gets the dashboard steps', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ vercel: { project: bad('unknown command'), git: bad('Failed to connect') } });
  const result = await V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets });
  assert.equal(result.ok, true);
  assert.equal(result.protection.ok, false);
  assert.equal(result.protection.manual, true);
  assert.match(result.protection.instruction, /Deployment Protection/);
  assert.equal(result.gitConnected, false);
});

test('works without a team scope (personal account)', async () => {
  const saved = await loadProfile();
  const blank = defaultProfile();
  await saveProfile(blank);
  try {
    const { dir } = await makeApp();
    const r = makeRun();
    const result = await V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets });
    assert.equal(result.scope, null);
    assert.ok(!r.vercelCalls().some((c) => c.rest.includes('--scope')));
  } finally {
    await saveProfile(saved);
  }
});

test('collectEnv prefers .env.local over the keys file and skips empty values', async () => {
  const { dir } = await makeApp();
  await updateEnvFile(path.join(dir, '.env.local'), { RESEND_API_KEY: 'from-local', EMPTY_ONE: '' });
  const cfg = { ...(await readAppConfig(dir)), env: ['RESEND_API_KEY', 'EMPTY_ONE', 'ONLY_SECRET', 'NEXT_PUBLIC_SITE_URL'] };
  const { values, missing } = await V.collectEnv({ appDir: dir, config: cfg, readSecrets: async () => new Map([['RESEND_API_KEY', 'from-secrets'], ['ONLY_SECRET', 'x']]) });
  assert.equal(values.get('RESEND_API_KEY'), 'from-local');
  assert.ok(!values.has('ONLY_SECRET'), 'a name that is not on the per-app list never falls back to the keys file');
  assert.deepEqual(missing, ['EMPTY_ONE', 'ONLY_SECRET']);
  assert.ok(!values.has('NEXT_PUBLIC_SITE_URL'), 'the site address is set separately');
});

test('collectEnv refuses account-level keys, wherever the value would come from', async () => {
  const { dir } = await makeApp();
  const base = await readAppConfig(dir);
  const token = `sbp_${'z9y8x7w6'.repeat(5)}`;
  for (const name of ['SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN', 'GITHUB_TOKEN']) {
    const cfg = { ...base, env: [...base.env, name] };
    await assert.rejects(
      () => V.collectEnv({ appDir: dir, config: cfg, readSecrets: async () => new Map([[name, token]]) }),
      (e) => e.data.reason === 'account-level-key' && e.message.includes(name) && /whole account/.test(e.message) && !e.message.includes(token),
    );
  }
  // Even when the value sits in the app's own .env.local.
  await updateEnvFile(path.join(dir, '.env.local'), { SUPABASE_ACCESS_TOKEN: token });
  await assert.rejects(
    () => V.collectEnv({ appDir: dir, config: { ...base, env: [...base.env, 'SUPABASE_ACCESS_TOKEN'] }, readSecrets: noSecrets }),
    /whole account/,
  );
});

test('per-app keys (AI, email, payments, Google) may still come from the keys file', async () => {
  const { dir } = await makeApp();
  const base = await readAppConfig(dir);
  const names = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
  const { values } = await V.collectEnv({
    appDir: dir,
    config: { ...base, env: [...base.env, ...names] },
    readSecrets: async () => new Map(names.map((n) => [n, `value-of-${n}`])),
  });
  for (const n of names) assert.equal(values.get(n), `value-of-${n}`);
});

test('collectEnv: the full-access Resend key and the live Stripe keys are never taken from the keys file', async () => {
  const { dir } = await makeApp();
  const base = await readAppConfig(dir);
  const { values } = await V.collectEnv({
    appDir: dir,
    config: { ...base, env: [...base.env, 'RESEND_API_KEY'] },
    readSecrets: async () => new Map([['RESEND_API_KEY', 'full-access']]),
  });
  assert.ok(!values.has('RESEND_API_KEY'));
  for (const name of ['STRIPE_LIVE_SECRET_KEY', 'STRIPE_LIVE_PUBLISHABLE_KEY']) {
    await assert.rejects(
      () => V.collectEnv({ appDir: dir, config: { ...base, env: [...base.env, name] }, readSecrets: async () => new Map([[name, 'sk_live_x']]) }),
      (e) => e.data.reason === 'live-key' && e.message.includes(name) && !e.message.includes('sk_live_x'),
    );
  }
});

test('after go-live, provision-vercel only refreshes the payment values in development, never over production', async () => {
  const { dir } = await makeApp();
  await updateAppConfig(dir, { env: [...(await readAppConfig(dir)).env, 'STRIPE_SECRET_KEY'], launch: { billing: { mode: 'live' } } });
  await updateEnvFile(path.join(dir, '.env.local'), { STRIPE_SECRET_KEY: 'sk_test_localvalue123456789' });
  const r = makeRun();
  await V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets });
  const stripe = r.vercelCalls().filter((c) => c.rest[0] === 'env' && c.rest[1] === 'add' && c.rest[2] === 'STRIPE_SECRET_KEY');
  assert.deepEqual(stripe.map((c) => c.rest[3]), ['development']);
});

test('provisionVercel stops before touching Vercel when an account-level key is listed', async () => {
  const { dir } = await makeApp();
  await updateAppConfig(dir, { env: [...(await readAppConfig(dir)).env, 'SUPABASE_ACCESS_TOKEN'] });
  const r = makeRun();
  await assert.rejects(
    () => V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: async () => new Map([['SUPABASE_ACCESS_TOKEN', `sbp_${'a1b2c3d4'.repeat(5)}`]]) }),
    /whole account/,
  );
  assert.equal(r.vercelCalls().length, 0, 'nothing was sent to Vercel');
});

// ---- checkPushed with a real git repository -------------------------------

function git(dir, ...args) {
  return spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
}

test('checkPushed against real git: no remote, remote without main, then pushed', { skip: !haveGit }, async () => {
  const { dir } = await makeApp();
  await assert.rejects(() => V.checkPushed(realRun, dir), /Push first.*not on GitHub/);

  const bare = path.join(tmp, 'remote-vercel.git');
  assert.equal(git(tmp, 'init', '--bare', bare).status, 0);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A');
  assert.equal(git(dir, 'commit', '-m', 'first').status, 0);
  await assert.rejects(() => V.checkPushed(realRun, dir), /main branch is not on GitHub/);

  const push = git(dir, 'push', '-u', 'origin', 'main');
  assert.equal(push.status, 0, push.stderr);
  assert.equal(await V.checkPushed(realRun, dir), bare);
});

function cli(args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'provision-vercel.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'home'), NO_COLOR: '1' },
  });
}

test('provision-vercel.mjs: --help exits 0, wrong options exit 2, unknown folder exits 1', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['x', '--nope']).status, 2);
  const missing = cli([path.join(tmp, 'nope'), '--json']);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
});

test('an app in a shared Supabase project sends its schema name to Vercel too', async () => {
  const { dir } = await makeApp();
  await updateEnvFile(path.join(dir, '.env.local'), { NEXT_PUBLIC_SUPABASE_SCHEMA: 'app_notes' });
  await updateAppConfig(dir, { shared: true, schema: 'app_notes' });
  const r = makeRun();
  const result = await V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets });
  assert.ok(result.envSet.includes('NEXT_PUBLIC_SUPABASE_SCHEMA'));
  const adds = r.vercelCalls().filter((c) => c.rest[0] === 'env' && c.rest[1] === 'add' && c.rest[2] === 'NEXT_PUBLIC_SUPABASE_SCHEMA');
  assert.deepEqual(adds.map((c) => [c.rest[3], c.input]), [['production', 'app_notes'], ['development', 'app_notes']]);
});

test('a shared app without its schema name in .env.local is not sent to Vercel (it would read the public schema)', async () => {
  const { dir } = await makeApp();
  await updateAppConfig(dir, { shared: true, schema: 'app_notes' });
  const r = makeRun();
  await assert.rejects(
    () => V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets }),
    /NEXT_PUBLIC_SUPABASE_SCHEMA/,
  );
  assert.equal(r.vercelCalls().filter((c) => c.rest[0] === 'env').length, 0);
});

test('an app with its own Supabase project does not get a schema setting', async () => {
  const { dir } = await makeApp();
  const r = makeRun();
  const result = await V.provisionVercel({ appDir: dir }, { run: r.fn, readSecrets: noSecrets });
  assert.ok(!result.envSet.includes('NEXT_PUBLIC_SUPABASE_SCHEMA'));
});

test('fixGitignore swaps the bare .env* line that vercel link adds for .env*.local', async () => {
  const { fixGitignore } = await import('../scripts/provision/vercel-core.mjs');
  const d = await mkdtemp(path.join(os.tmpdir(), 'gi-'));
  try {
    await writeFile(path.join(d, '.gitignore'), 'node_modules\n.env*.local\n.vercel\n.env*\n');
    assert.equal(await fixGitignore(d), true);
    assert.equal(await readFile(path.join(d, '.gitignore'), 'utf8'), 'node_modules\n.env*.local\n.vercel\n');
    assert.equal(await fixGitignore(d), false);
    await writeFile(path.join(d, '.gitignore'), '.env*\n!.env.example\n');
    assert.equal(await fixGitignore(d), false);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
