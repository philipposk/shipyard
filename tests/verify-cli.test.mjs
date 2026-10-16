import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/lib/run.mjs';
import { startFake, tempDir, removeDir, makeAppFromTemplate, SERVER, ANON, APP_NAME } from './verify-helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify.mjs');
const HOME = mkdtempSync(path.join(os.tmpdir(), 'shipyard-verify-cli-home-'));
process.env.SHIPYARD_HOME = HOME;
const { runChecks } = await import('../scripts/verify.mjs');

async function fixture(t, fakeOpts, { withProfile = true, withEnv = true } = {}) {
  const fake = await startFake(fakeOpts);
  t.after(() => fake.close());
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await makeAppFromTemplate(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  if (withEnv) {
    await writeFile(path.join(dir, '.env.local'), [
      `NEXT_PUBLIC_SUPABASE_URL=${fake.url}`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON}`, `SUPABASE_SERVICE_ROLE_KEY=${SERVER}`, '',
    ].join('\n'));
  }
  const home = await tempDir('shipyard-verify-home-');
  t.after(() => removeDir(home));
  if (withProfile) {
    await writeFile(path.join(home, 'profile.json'), JSON.stringify({
      version: 1, apps: [{ slug: 'fake-planner', name: APP_NAME, url: fake.url, status: 'live', lastVerify: null }],
    }));
  }
  return { fake, dir, home };
}
const verify = (args, home) => run(process.execPath, [SCRIPT, ...args], { env: { SHIPYARD_HOME: home }, timeoutMs: 60_000 });

test('--help prints usage and exits 0', async () => {
  const r = await verify(['--help'], HOME);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: node verify\.mjs <appDir>/);
  assert.match(r.stdout, /--only/);
});

test('usage errors exit 2 with a plain message', async (t) => {
  const { dir, home } = await fixture(t, {});
  for (const args of [[], [dir, '--only', 'nope'], [dir, '--url', 'ftp://x'], ['/definitely/not/here'], [dir, '--bogus'], [dir, 'extra']]) {
    const r = await verify(args, home);
    assert.equal(r.code, 2, `args ${JSON.stringify(args)} gave ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Usage: node verify\.mjs/);
  }
  const unknown = await verify([dir, '--only', 'routes,nope'], home);
  assert.match(unknown.stderr, /Unknown check: nope\. Choose from: secrets, proxy, design, routes/);
});

test('a healthy app: exit 0, JSON result, saved to verify.json and the profile, no keys printed', async (t) => {
  const { fake, dir, home } = await fixture(t, {});
  const r = await verify([dir, '--json'], home);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.url, fake.url);
  assert.deepEqual(result.checks.map((c) => c.name), ['secrets', 'proxy', 'design', 'routes', 'protection', 'auth', 'isolation', 'browser']);
  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  for (const n of ['secrets', 'proxy', 'design', 'routes', 'protection', 'auth', 'isolation']) assert.equal(byName[n].ok && !byName[n].skipped, true, `${n}: ${JSON.stringify(byName[n])}`);
  assert.equal(byName.browser.skipped, true);
  assert.ok(!r.stdout.includes(SERVER) && !r.stdout.includes(ANON));

  const saved = JSON.parse(await readFile(path.join(dir, '.shipyard', 'verify.json'), 'utf8'));
  assert.equal(saved.ok, true);
  const profile = JSON.parse(await readFile(path.join(home, 'profile.json'), 'utf8'));
  const app = profile.apps.find((a) => a.slug === 'fake-planner');
  assert.equal(app.lastVerify.ok, true);
  assert.equal(app.lastVerify.passed, 7);
  assert.deepEqual(app.lastVerify.skippedChecks, ['browser']);
  assert.equal(app.url, fake.url);
  assert.equal(fake.state.users.size, 0);
});

test('a failing check exits 1 and the human report says what to fix and what was not checked', async (t) => {
  const { dir, home } = await fixture(t, { leak: ['read'] });
  const r = await verify([dir, '--only', 'isolation,routes'], home);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ Pages:/);
  assert.match(r.stdout, /✗ Privacy between users: 2 privacy problems found/);
  assert.match(r.stdout, /another signed-in user can read/);
  assert.match(r.stdout, /1 of 2 checks failed/);
  assert.match(r.stdout, /What verify did not check:/);
  assert.match(r.stdout, /Sign-in: left out with --only/);
  assert.ok(!r.stdout.includes(SERVER));
  const profile = JSON.parse(await readFile(path.join(home, 'profile.json'), 'utf8'));
  assert.deepEqual(profile.apps[0].lastVerify.failedChecks, ['isolation']);
});

test('--url overrides the saved address', async (t) => {
  const { fake, dir, home } = await fixture(t, {});
  const r = await verify([dir, '--only', 'protection', '--url', `${fake.url}/`, '--json'], home);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).url, fake.url);
});

test('without any web address the live checks are skipped, not failed', async (t) => {
  const { dir, home } = await fixture(t, {}, { withProfile: false });
  const r = await verify([dir, '--json', '--only', 'routes,protection,auth,browser,isolation'], home);
  assert.equal(r.code, 0, r.stdout);
  const result = JSON.parse(r.stdout);
  const skipped = result.checks.filter((c) => c.skipped).map((c) => c.name);
  assert.deepEqual(skipped, ['routes', 'protection', 'auth', 'browser']);
  assert.equal(result.checks.find((c) => c.name === 'isolation').ok, true);
  // Not in the profile: nothing is written there.
  await assert.rejects(readFile(path.join(home, 'profile.json'), 'utf8'));
});

test('no .env.local: the Supabase checks are skipped with a reason', async (t) => {
  const { dir, home } = await fixture(t, {}, { withEnv: false });
  const r = await verify([dir, '--json', '--only', 'auth,isolation'], home);
  assert.equal(r.code, 0);
  const result = JSON.parse(r.stdout);
  assert.ok(result.checks.every((c) => c.skipped && /missing from \.env\.local/.test(c.reason)));
});

test('runChecks turns a crashing check into a failed result', async () => {
  const checks = await runChecks({ appDir: '/x', url: null, secrets: new Map([['K', 'a-secret-value-123']]) }, ['nope', 'proxy']);
  assert.equal(checks[0].ok, false);
  assert.equal(checks[0].summary, 'the check crashed');
  assert.equal(checks[1].name, 'proxy');
});
