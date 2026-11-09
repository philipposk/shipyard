import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthyLines, run, triggerReport } from '../scripts/supabase-health.mjs';
const harness = (argv, extra = {}) => {
  const said = [];
  return run(argv, {
    say: (line) => said.push(line),
    getSecret: async () => 'sbp_test_token_not_real',
    projectHealth: extra.projectHealth ?? (async () => [{ name: 'db', healthy: true, status: 'ACTIVE_HEALTHY' }]),
    restartProject: extra.restartProject ?? (async () => ({})),
    ...extra.deps,
  }).then((code) => ({ code, said }));
};

test('healthyLines keeps name, healthy and status', () => {
  assert.deepEqual(healthyLines([{ name: 'db', healthy: false, status: 'UNHEALTHY' }, null]), [
    { name: 'db', healthy: false, status: 'UNHEALTHY' },
    { name: 'unknown', healthy: false, status: '' },
  ]);
  assert.deepEqual(healthyLines({}), []);
});

test('--help prints usage and does not ask for a token', async () => {
  let asked = false;
  const { code, said } = await harness(['--help'], { deps: { getSecret: async () => { asked = true; return ''; } } });
  assert.equal(code, 0);
  assert.equal(asked, false);
  assert.match(said.join('\n'), /project-ref/);
});

test('a healthy project exits 0 and names each service', async () => {
  const { code, said } = await harness(['abcdefghijklmnopqrst']);
  assert.equal(code, 0);
  assert.match(said.join('\n'), /db: up \(ACTIVE_HEALTHY\)/);
});

test('a down database exits 1', async () => {
  const { code, said } = await harness(['abcdefghijklmnopqrst'], {
    projectHealth: async () => [{ name: 'db', healthy: false, status: 'UNHEALTHY' }, { name: 'auth', healthy: true, status: 'ACTIVE_HEALTHY' }],
  });
  assert.equal(code, 1);
  assert.match(said.join('\n'), /db: DOWN/);
  assert.ok(!said.join('\n').includes('sbp_test_token_not_real'));
});

test('--restart calls restart and says the budget does not refill', async () => {
  let restarted = '';
  const { code, said } = await harness(['abcdefghijklmnopqrst', '--restart'], {
    restartProject: async (_auth, ref) => { restarted = ref; },
  });
  assert.equal(code, 0);
  assert.equal(restarted, 'abcdefghijklmnopqrst');
  assert.match(said.join('\n'), /does not refill/);
});

test('a missing ref exits 2', async () => {
  const { code } = await harness([]);
  assert.equal(code, 2);
});

test('triggerReport flags a definition that writes encrypted_password and ignores other columns', () => {
  const rows = triggerReport([
    { tgname: 'clear_password_on_first_confirm', def: "BEFORE UPDATE BEGIN new.encrypted_password := ''; RETURN new; END" },
    { tgname: 'on_auth_user_created', def: 'AFTER INSERT BEGIN INSERT INTO public.profiles (id) VALUES (new.id); RETURN new; END' },
  ]);
  assert.deepEqual(rows, [
    { name: 'clear_password_on_first_confirm', touchesPassword: true },
    { name: 'on_auth_user_created', touchesPassword: false },
  ]);
});

test('--auth-triggers prints names only and does not select emails', async () => {
  let query = '';
  const said = [];
  const code = await run(['abcdefghijklmnopqrst', '--auth-triggers'], {
    say: (line) => said.push(line),
    getSecret: async () => 'sbp_test_token_not_real',
    runSql: async (_auth, _ref, sql) => {
      query = sql;
      return [{ tgname: 'on_auth_user_created', def: 'insert into profiles (id) values (new.id)' }];
    },
  });
  assert.equal(code, 0);
  assert.match(query, /pg_trigger/);
  assert.match(query, /::regclass/);
  assert.doesNotMatch(query, /select email/i);
  const text = said.join('\n');
  assert.match(text, /on_auth_user_created: does not touch encrypted_password/);
  assert.doesNotMatch(text, /@/);
});
