import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthyLines, run } from '../scripts/supabase-health.mjs';
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
