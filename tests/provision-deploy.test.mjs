import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Real path: the app's own key scan compares paths and is confused by symlinked temp folders.
const tmp = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'shipyard-deploy-')));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const D = await import('../scripts/provision/deploy-core.mjs');
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { readAppConfig, updateAppConfig } = await import('../scripts/provision/common.mjs');
const { loadProfile, saveProfile, defaultProfile } = await import('../scripts/lib/profile.mjs');
const { run: realRun, which } = await import('../scripts/lib/run.mjs');
const haveGit = (await which('git')) !== null;

const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });
const bad = (stderr = 'boom', code = 1) => ({ code, stdout: '', stderr });
const sleep = async () => {};

/**
 * Fake run(): git answers come from `state`, the key scan from `scan`, and vercel
 * from `vercel`. deploy prints a deployment address on stdout and the short address on stderr.
 */
function makeRun({ status = '', head = 'aaa111', remote = 'aaa111', scan = ok(JSON.stringify({ ok: true, findings: [] })), deployments = [], vercel = {} } = {}) {
  const calls = [];
  const queue = [...deployments];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input, cwd: opts.cwd });
    if (cmd === 'git') {
      const key = args.join(' ');
      if (key.startsWith('status --porcelain')) return ok(status);
      if (key === 'rev-parse HEAD refs/remotes/origin/main') return remote === null ? { code: 128, stdout: '', stderr: 'fatal' } : ok(`${head}\n${remote}\n`);
      return ok();
    }
    if (cmd === process.execPath) return scan;
    if (cmd === 'npx') {
      const rest = args.slice(2);
      if (vercel[rest[0]]) return vercel[rest[0]](rest, opts);
      if (rest[0] === 'deploy') return queue.shift() ?? ok('https://deployment-abc.vercel.app\n');
      return ok();
    }
    return ok();
  };
  return {
    fn,
    calls,
    deploys: () => calls.filter((c) => c.cmd === 'npx' && c.args[2] === 'deploy'),
    envAdds: () => calls.filter((c) => c.cmd === 'npx' && c.args[2] === 'env' && c.args[3] === 'add'),
  };
}

/** fetch stand-in: address -> status (or a function returning [status, body]). Unknown addresses answer 404. */
function makeFetch(map) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const origin = new URL(url).origin;
    const hit = map[origin];
    if (hit instanceof Error) throw hit;
    const [status, body] = typeof hit === 'number' ? [hit, '<html><body>Welcome</body></html>'] : Array.isArray(hit) ? hit : [404, 'not found'];
    return new Response(body, { status });
  };
  return { fn, urls };
}

let n = 0;
async function makeApp() {
  const slug = `dp-app-${++n}`;
  const parent = path.join(tmp, `p${n}`);
  await scaffold({ slug, name: slug, description: 'd', parent });
  const dir = path.join(parent, slug);
  await updateAppConfig(dir, { supabaseRef: 'abcdefghij0123456789', vercelProject: slug, siteUrl: `https://${slug}.vercel.app` });
  return { slug, dir };
}

before(async () => {
  const p = defaultProfile();
  p.accounts.vercel.scope = 'my-team';
  await saveProfile(p);
});
after(() => rm(tmp, { recursive: true, force: true }));

const profileApp = async (slug) => (await loadProfile()).apps.find((a) => a.slug === slug);

test('happy path: checks, deploys, opens the public address, records it and updates sign-in addresses', async () => {
  const { slug, dir } = await makeApp();
  const alias = `https://${slug}.vercel.app`;
  const r = makeRun({ deployments: [ok('https://deployment-abc.vercel.app\n', `Production: https://deployment-abc.vercel.app\nAliased: ${alias} [3s]\n`)] });
  const f = makeFetch({ [alias]: 200 });
  const authCalls = [];
  const result = await D.deploy({ appDir: dir }, { run: r.fn, fetch: f.fn, sleep, setAuthUrls: async (o) => { authCalls.push(o); return { changed: true }; } });

  assert.equal(result.ok, true);
  assert.equal(result.url, alias);
  assert.equal(result.deploymentUrl, 'https://deployment-abc.vercel.app');
  assert.deepEqual(result.authUrls, { ok: true, changed: true });
  assert.equal(r.deploys().length, 1);
  assert.deepEqual(r.envAdds(), [], 'the address guess was right, nothing to fix');
  assert.deepEqual(authCalls, [{ appDir: dir, url: alias }]);

  // The key scan ran first, inside the app folder, with Node.
  const scanCall = r.calls.find((c) => c.cmd === process.execPath);
  assert.equal(scanCall.args[0], path.join(dir, 'scripts', 'secret-scan.mjs'));
  assert.equal(scanCall.cwd, dir);
  assert.ok(r.calls.indexOf(scanCall) < r.calls.indexOf(r.deploys()[0]));
  // Deploy used the saved team.
  assert.ok(r.deploys()[0].args.includes('--scope') && r.deploys()[0].args.includes('my-team'));

  const cfg = await readAppConfig(dir);
  assert.equal(cfg.url, alias);
  assert.equal(cfg.siteUrl, alias);
  const app = await profileApp(slug);
  assert.equal(app.url, alias);
  assert.equal(app.status, 'live');
});

test('it refuses to deploy while there are unsaved changes, and nothing is deployed', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ status: ' M src/app/page.tsx\n?? notes.txt' });
  await assert.rejects(() => D.deploy({ appDir: dir }, { run: r.fn, fetch: makeFetch({}).fn, sleep }), /Commit and push first/);
  assert.equal(r.deploys().length, 0);
  assert.equal(r.calls.some((c) => c.cmd === process.execPath), false, 'no scan before the save check');
});

test('it refuses when the latest version is not on GitHub', async () => {
  const { dir } = await makeApp();
  const behind = makeRun({ head: 'aaa111', remote: 'bbb222' });
  await assert.rejects(() => D.deploy({ appDir: dir }, { run: behind.fn, fetch: makeFetch({}).fn, sleep }), /not on GitHub yet.*Commit and push first/);
  const noRemote = makeRun({ remote: null });
  await assert.rejects(() => D.deploy({ appDir: dir }, { run: noRemote.fn, fetch: makeFetch({}).fn, sleep }), /Commit and push first/);
  assert.equal(behind.deploys().length + noRemote.deploys().length, 0);
});

test('a leaked key stops the deploy and shows only where it is', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ scan: { code: 1, stdout: JSON.stringify({ ok: false, findings: [{ file: 'src/lib/oops.ts', line: 3, pattern: 'Stripe secret key' }] }), stderr: '' } });
  await assert.rejects(
    () => D.deploy({ appDir: dir }, { run: r.fn, fetch: makeFetch({}).fn, sleep }),
    (e) => /nothing was deployed/.test(e.message) && /oops\.ts:3/.test(e.message) && e.data.reason === 'secret-scan',
  );
  assert.equal(r.deploys().length, 0);
});

test('a key check that can not run also stops the deploy', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ scan: { code: 2, stdout: JSON.stringify({ ok: false, error: 'Could not list files.' }), stderr: '' } });
  await assert.rejects(() => D.deploy({ appDir: dir }, { run: r.fn, fetch: makeFetch({}).fn, sleep }), /could not run.*Could not list files/);
  assert.equal(r.deploys().length, 0);
});

test('a key check that prints nothing counts as failed, not as clean', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ scan: ok('', '') });
  await assert.rejects(() => D.deploy({ appDir: dir }, { run: r.fn, fetch: makeFetch({}).fn, sleep }), /did not run properly/);
  assert.equal(r.deploys().length, 0);
});

test('no Vercel project yet points to provision-vercel', async () => {
  const { dir } = await makeApp();
  await updateAppConfig(dir, { vercelProject: undefined });
  const r = makeRun();
  await assert.rejects(() => D.deploy({ appDir: dir }, { run: r.fn, fetch: makeFetch({}).fn, sleep }), /provision-vercel\.mjs/);
});

test('a Vercel login page in front of the site is caught and explained', async () => {
  const { slug, dir } = await makeApp();
  const r = makeRun();
  const f = makeFetch({
    [`https://${slug}.vercel.app`]: [401, '<html>Authentication Required</html>'],
    'https://deployment-abc.vercel.app': [401, '<html>https://vercel.com/sso-api?url=</html>'],
  });
  await assert.rejects(
    () => D.deploy({ appDir: dir }, { run: r.fn, fetch: f.fn, sleep }),
    (e) => {
      assert.match(e.message, /log in to Vercel/);
      assert.match(e.message, /Vercel Authentication/);
      assert.equal(e.data.reason, 'protected');
      assert.equal(e.data.deploymentUrl, 'https://deployment-abc.vercel.app');
      return true;
    },
  );
  assert.notEqual((await profileApp(slug))?.status, 'live');
  assert.equal(f.urls.length, 2, 'a login page is final, no waiting and retrying');
});

test('a 200 page that is really the Vercel login is not accepted either', async () => {
  const { slug, dir } = await makeApp();
  const f = makeFetch({ [`https://${slug}.vercel.app`]: [200, '<html><a href="https://vercel.com/sso-api">Continue with Vercel</a></html>'], 'https://deployment-abc.vercel.app': 200 });
  const result = await D.deploy({ appDir: dir }, { run: makeRun().fn, fetch: f.fn, sleep, setAuthUrls: async () => ({ changed: false }) });
  assert.equal(result.url, 'https://deployment-abc.vercel.app', 'falls back to the address that really opens');
  assert.ok(result.warnings.length > 0);
});

test('a site that never answers is reported after retrying', async () => {
  const { dir } = await makeApp();
  const f = makeFetch({});
  const naps = [];
  await assert.rejects(
    () => D.deploy({ appDir: dir }, { run: makeRun().fn, fetch: f.fn, sleep: async (ms) => { naps.push(ms); }, checkTries: 3 }),
    (e) => /did not open correctly/.test(e.message) && e.data.reason === 'unreachable' && /answered 404/.test(e.message),
  );
  assert.ok(naps.length >= 4, 'slept between tries');
});

test('when Vercel picks another address, the setting is fixed and the app is built once more', async () => {
  const { slug, dir } = await makeApp();
  const real = `https://${slug}-xyz.vercel.app`;
  const r = makeRun({
    deployments: [
      ok('https://deployment-1.vercel.app\n', `Aliased: ${real} [2s]\n`),
      ok('https://deployment-2.vercel.app\n', `Aliased: ${real} [2s]\n`),
    ],
  });
  const f = makeFetch({ [real]: 200 });
  const result = await D.deploy({ appDir: dir }, { run: r.fn, fetch: f.fn, sleep, setAuthUrls: async () => ({ changed: true }) });
  assert.equal(result.ok, true);
  assert.equal(result.url, real);
  assert.equal(r.deploys().length, 2);
  const adds = r.envAdds();
  assert.equal(adds.length, 1);
  assert.equal(adds[0].args[4], 'NEXT_PUBLIC_SITE_URL');
  assert.equal(adds[0].args[5], 'production');
  assert.equal(adds[0].input, real);
  assert.equal(result.deploymentUrl, 'https://deployment-2.vercel.app');
  assert.equal((await readAppConfig(dir)).siteUrl, real);
});

test('if Vercel does not print the short address but the recorded one works, that one is used', async () => {
  const { slug, dir } = await makeApp();
  const r = makeRun({ deployments: [ok('https://deployment-abc.vercel.app\n', '')] });
  const f = makeFetch({ [`https://${slug}.vercel.app`]: 200 });
  const result = await D.deploy({ appDir: dir }, { run: r.fn, fetch: f.fn, sleep, setAuthUrls: async () => ({ changed: false }) });
  assert.equal(result.url, `https://${slug}.vercel.app`);
  assert.equal(r.deploys().length, 1);
  assert.deepEqual(result.warnings, []);
});

test('failing to tell Supabase leaves the site live but reports it as not ok', async () => {
  const { slug, dir } = await makeApp();
  const alias = `https://${slug}.vercel.app`;
  const r = makeRun({ deployments: [ok('https://d.vercel.app\n', `Aliased: ${alias}\n`)] });
  const result = await D.deploy({ appDir: dir }, {
    run: r.fn,
    fetch: makeFetch({ [alias]: 200 }).fn,
    sleep,
    setAuthUrls: async () => { throw new Error('SUPABASE_ACCESS_TOKEN is missing.'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.authUrls.ok, false);
  assert.match(result.error, /live at .*sign-in addresses/);
  assert.equal((await profileApp(slug)).status, 'live');
  assert.equal((await profileApp(slug)).url, alias);
});

test('a failed Vercel deploy is reported with Vercel\'s own message', async () => {
  const { dir } = await makeApp();
  const r = makeRun({ vercel: { deploy: () => bad('Error: Build failed: Module not found') } });
  await assert.rejects(() => D.deploy({ appDir: dir }, { run: r.fn, fetch: makeFetch({}).fn, sleep }), /Vercel could not deploy.*Module not found/);
});

test('checkSite: retries a 404, stops at once on a login page, accepts a 200', async () => {
  let calls = 0;
  const flaky = async () => new Response(calls++ < 2 ? 'not yet' : '<html>hello</html>', { status: calls <= 2 ? 404 : 200 });
  const naps = [];
  const good = await D.checkSite('https://a.vercel.app', { fetch: flaky, sleep: async (ms) => { naps.push(ms); }, tries: 5, delayMs: 10 });
  assert.deepEqual(good, { ok: true, status: 200 });
  assert.equal(naps.length, 2);

  let seen = 0;
  const locked = async () => { seen++; return new Response('Authentication Required', { status: 401 }); };
  const prot = await D.checkSite('https://a.vercel.app', { fetch: locked, sleep, tries: 5 });
  assert.equal(prot.reason, 'protected');
  assert.equal(seen, 1);

  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(await D.checkSite('https://a.vercel.app', { fetch: down, sleep, tries: 2 }), { ok: false, status: 0, reason: 'unreachable' });
  const e500 = await D.checkSite('https://a.vercel.app', { fetch: async () => new Response('x', { status: 500 }), sleep, tries: 1 });
  assert.deepEqual(e500, { ok: false, status: 500, reason: 'status' });
});

// ---- the save check against a real git repository -------------------------

function git(dir, ...args) {
  return spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
}

test('checkSavedAndPushed with real git: clean, only the app file changed, edited, untracked, unpushed', { skip: !haveGit }, async () => {
  const { dir } = await makeApp();
  const bare = path.join(tmp, 'remote-deploy.git');
  assert.equal(git(tmp, 'init', '--bare', bare).status, 0);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A');
  assert.equal(git(dir, 'commit', '-m', 'first').status, 0);
  const push = git(dir, 'push', '-u', 'origin', 'main');
  assert.equal(push.status, 0, push.stderr);

  await D.checkSavedAndPushed(realRun, dir);

  // Only Shipyard's own bookkeeping file changed: still fine.
  await updateAppConfig(dir, { url: 'https://example.vercel.app' });
  await D.checkSavedAndPushed(realRun, dir);

  const page = path.join(dir, 'src', 'lib', 'constants.ts');
  const original = await readFile(page, 'utf8');
  await writeFile(page, `${original}\n// edit\n`);
  await assert.rejects(() => D.checkSavedAndPushed(realRun, dir), /not saved yet/);
  await writeFile(page, original);
  await D.checkSavedAndPushed(realRun, dir);

  await writeFile(path.join(dir, 'new-file.txt'), 'hi');
  await assert.rejects(() => D.checkSavedAndPushed(realRun, dir), /not saved yet/);
  git(dir, 'add', '-A');
  assert.equal(git(dir, 'commit', '-m', 'second').status, 0);
  await assert.rejects(() => D.checkSavedAndPushed(realRun, dir), /not on GitHub yet/);
  assert.equal(git(dir, 'push').status, 0);
  await D.checkSavedAndPushed(realRun, dir);
});

test('checkSavedAndPushed says so when the folder is not a git repository', async () => {
  const plain = await mkdtemp(path.join(tmp, 'plain-'));
  await assert.rejects(() => D.checkSavedAndPushed(realRun, plain), /Commit and push first|not a git repository/);
});

test('secretScan runs the real template scan: clean repo passes, a planted key fails without printing it', { skip: !haveGit }, async () => {
  const { dir } = await makeApp();
  git(dir, 'add', '-A');
  await D.secretScan(realRun, dir);
  const fakeKey = `sk_${'live'}_${'Z9'.repeat(15)}`;
  await writeFile(path.join(dir, 'oops.txt'), `key = ${fakeKey}\n`);
  git(dir, 'add', 'oops.txt');
  await assert.rejects(
    () => D.secretScan(realRun, dir),
    (e) => /oops\.txt:1/.test(e.message) && !e.message.includes(fakeKey),
  );
});

function cli(args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'deploy.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'home'), NO_COLOR: '1' },
  });
}

test('deploy.mjs: --help exits 0, wrong options exit 2, unknown folder exits 1', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['x', '--nope']).status, 2);
  const missing = cli([path.join(tmp, 'nope'), '--json']);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
});
