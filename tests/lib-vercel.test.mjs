import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const V = await import('../scripts/lib/vercel.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fake run(): records calls, answers from a queue (default: success, empty output). */
function fakeRun(replies = []) {
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return replies.shift() ?? { code: 0, stdout: '', stderr: '' };
  };
  return { fn, calls };
}
const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });
const bad = (stderr = 'boom', code = 1) => ({ code, stdout: '', stderr });

test('whoami goes through npx with the pinned Vercel CLI and parses the username', async () => {
  const r = fakeRun([ok('student\n', 'Vercel CLI 64.2.0\n')]);
  const out = await V.whoami({ run: r.fn });
  assert.deepEqual(out, { ok: true, user: 'student' });
  assert.equal(r.calls[0].cmd, 'npx');
  assert.deepEqual(r.calls[0].args.slice(0, 3), ['--yes', V.VERCEL_CLI, 'whoami']);
});

test('whoami reports logged-out', async () => {
  const out = await V.whoami({ run: fakeRun([bad('Error: No existing credentials found.')]).fn });
  assert.equal(out.ok, false);
  assert.equal(out.user, null);
  assert.match(out.error, /credentials/);
});

test('teams parses the table and skips headers', async () => {
  const stdout = '> 2 teams found\n  id          Team name\n  my-team     My Team\n  other       Other Co\n';
  const out = await V.teams({ run: fakeRun([ok(stdout)]).fn });
  assert.deepEqual(out.teams, [{ id: 'my-team', name: 'My Team' }, { id: 'other', name: 'Other Co' }]);
});

test('link passes project, --yes, scope and cwd', async () => {
  const r = fakeRun();
  const out = await V.link({ cwd: '/app', project: 'todo', scope: 'my-team', run: r.fn });
  assert.equal(out.ok, true);
  assert.deepEqual(r.calls[0].args, ['--yes', V.VERCEL_CLI, 'link', '--yes', '--project', 'todo', '--scope', 'my-team']);
  assert.equal(r.calls[0].opts.cwd, '/app');
  assert.deepEqual(await V.link({ cwd: '/app' }), { ok: false, error: 'link needs a project name.' });
});

test('envAdd sends the value by stdin only, one call per target, never in argv', async () => {
  const value = 'super-secret-value-xyz';
  const r = fakeRun();
  const out = await V.envAdd({ cwd: '/app', name: 'SUPABASE_SERVICE_ROLE_KEY', value, run: r.fn });
  assert.deepEqual(out, { ok: true, done: ['production', 'development'] });
  assert.equal(r.calls.length, 2);
  for (const c of r.calls) {
    assert.equal(c.opts.input, value);
    assert.ok(!JSON.stringify(c.args).includes(value));
    assert.ok(c.args.includes('--force'));
  }
  assert.ok(r.calls[0].args.includes('production') && r.calls[0].args.includes('--sensitive'));
  assert.ok(r.calls[1].args.includes('development') && r.calls[1].args.includes('--no-sensitive'));
});

test('envAdd: NEXT_PUBLIC_ names are not sensitive; preview is skipped; single target works', async () => {
  const r = fakeRun();
  await V.envAdd({ name: 'NEXT_PUBLIC_SITE_URL', value: 'https://x.vercel.app', target: ['production', 'preview'], run: r.fn });
  assert.equal(r.calls.length, 1);
  assert.ok(r.calls[0].args.includes('--no-sensitive'));
  assert.ok(!r.calls[0].args.includes('preview'));
});

test('envAdd retries without --sensitive when the CLI refuses it', async () => {
  const r = fakeRun([bad('unknown option --sensitive'), ok(), ok()]);
  const out = await V.envAdd({ name: 'RESEND_API_KEY', value: 'v', run: r.fn });
  assert.equal(out.ok, true);
  assert.equal(r.calls.length, 3);
  assert.ok(r.calls[1].args.includes('--no-sensitive'));
});

test('envAdd failure does not echo the value', async () => {
  const value = 'leaky-value-123';
  const r = fakeRun([bad(`could not set ${value}`), bad(`could not set ${value}`)]);
  const out = await V.envAdd({ name: 'RESEND_API_KEY', value, run: r.fn });
  assert.equal(out.ok, false);
  assert.ok(!out.error.includes(value));
});

test('envAdd rejects empty values and multi-line values', async () => {
  assert.equal((await V.envAdd({ name: 'A', value: '', run: fakeRun().fn })).ok, false);
  assert.equal((await V.envAdd({ name: 'A', value: 'a\nb', run: fakeRun().fn })).ok, false);
});

test('envLs parses names and environments', async () => {
  const stdout = [
    '> Environment Variables found for todo',
    ' name                       value      environments           created',
    ' NEXT_PUBLIC_SUPABASE_URL   Encrypted  Production, Development 2d ago',
    ' SUPABASE_SERVICE_ROLE_KEY  Encrypted  Production              2d ago',
  ].join('\n');
  const out = await V.envLs({ cwd: '/app', run: fakeRun([ok(stdout)]).fn });
  assert.deepEqual(out.names, ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  assert.deepEqual(out.envs[0].targets, ['production', 'development']);
});

test('deployProd returns the URL from stdout and the alias from stderr', async () => {
  const r = fakeRun([ok('https://todo-abc123-my-team.vercel.app\n', 'Inspect: https://vercel.com/x\nProduction: https://todo-abc123-my-team.vercel.app [3s]\nAliased: https://todo.vercel.app [3s]\n')]);
  const out = await V.deployProd({ cwd: '/app', run: r.fn });
  assert.equal(out.ok, true);
  assert.equal(out.url, 'https://todo-abc123-my-team.vercel.app');
  assert.equal(out.aliasUrl, 'https://todo.vercel.app');
  assert.ok(r.calls[0].args.includes('--prod'));
});

test('deployProd fails cleanly with no URL or a failing command', async () => {
  assert.equal((await V.deployProd({ run: fakeRun([ok('')]).fn })).ok, false);
  const out = await V.deployProd({ run: fakeRun([bad('Error: build failed')]).fn });
  assert.equal(out.ok, false);
  assert.match(out.error, /build failed/);
});

test('protectionDisable: ok, or a manual dashboard instruction', async () => {
  const r = fakeRun();
  assert.deepEqual(await V.protectionDisable({ cwd: '/app', project: 'todo', run: r.fn }), { ok: true });
  assert.deepEqual(r.calls[0].args.slice(1, 7), [V.VERCEL_CLI, 'project', 'protection', 'disable', 'todo', '--sso']);
  const out = await V.protectionDisable({ project: 'todo', run: fakeRun([bad('Unknown command')]).fn });
  assert.equal(out.ok, false);
  assert.equal(out.manual, true);
  assert.match(out.instruction, /Deployment Protection/);
});

test('gitConnect runs vercel git connect --yes', async () => {
  const r = fakeRun();
  assert.equal((await V.gitConnect({ cwd: '/app', run: r.fn })).ok, true);
  assert.deepEqual(r.calls[0].args.slice(1), [V.VERCEL_CLI, 'git', 'connect', '--yes']);
  assert.equal((await V.gitConnect({ run: fakeRun([bad('Failed to connect')]).fn })).ok, false);
});

test('gitConnect treats "already connected" as success and strips markup from errors', async () => {
  const ok = await V.gitConnect({ run: fakeRun([bad('philipposk/x is already connected to your project.')]).fn });
  assert.deepEqual(ok, { ok: true, already: true });
  const f = await V.gitConnect({ run: fakeRun([bad('Failed <claude-code-hint v="1" type="x" />to connect')]).fn });
  assert.equal(f.ok, false);
  assert.doesNotMatch(f.error, /</);
});

test('a missing npx gives a plain-English error', async () => {
  const out = await V.whoami({ run: fakeRun([bad('Command not found: npx', 127)]).fn });
  assert.match(out.error, /setup/);
});

test('VERCEL_CLI is one exact version, never latest', () => {
  assert.match(V.VERCEL_CLI, /^vercel@\d+\.\d+\.\d+$/);
});

test('every Vercel call uses VERCEL_CLI', async () => {
  const r = fakeRun();
  await V.whoami({ run: r.fn });
  await V.link({ cwd: '/app', project: 'todo', run: r.fn });
  await V.deployProd({ cwd: '/app', run: r.fn });
  await V.envLs({ cwd: '/app', run: r.fn });
  assert.ok(r.calls.length >= 4);
  for (const c of r.calls) assert.equal(c.args[1], V.VERCEL_CLI);
});

test('docs and scripts name the same pinned version (no @latest anywhere)', () => {
  const found = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next') continue;
      const next = path.join(rel, e.name);
      if (e.isDirectory()) walk(next);
      else if (/\.(md|mjs|json|ya?ml|txt)$/.test(e.name)) {
        for (const m of readFileSync(path.join(ROOT, next), 'utf8').matchAll(/\bvercel@[A-Za-z0-9.\-]+/g)) found.push([next, m[0]]);
      }
    }
  };
  for (const dir of ['skills', 'starter', 'scripts', 'template']) walk(dir);
  for (const ref of readFileSync(path.join(ROOT, 'README.md'), 'utf8').match(/\bvercel@[A-Za-z0-9.\-]+/g) ?? []) found.push(['README.md', ref]);
  assert.ok(found.length > 0, 'expected the setup docs to mention the CLI');
  for (const [file, ref] of found) assert.equal(ref, V.VERCEL_CLI, `${file} mentions ${ref}`);
});
