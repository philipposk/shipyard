import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatus, missingFor, STEP_INFO } from '../scripts/setup-status.mjs';
import { defaultProfile, STEP_IDS } from '../scripts/lib/profile.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-status.mjs');

const noKeys = [
  { name: 'SUPABASE_ACCESS_TOKEN', present: false, looksValid: false, required: true },
  { name: 'OPENAI_API_KEY', present: false, looksValid: false, required: false },
];

function runScript(home, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, SHIPYARD_HOME: home, NO_COLOR: '1' }, encoding: 'utf8' });
}

test('every step has info', () => {
  for (const id of STEP_IDS) assert.ok(STEP_INFO[id].title, id);
});

test('fresh profile: first step is next, nothing done', () => {
  const s = buildStatus(defaultProfile(), noKeys, { profileExists: false });
  assert.equal(s.doneCount, 0);
  assert.equal(s.total, 10);
  assert.equal(s.nextStep, 'tools');
  assert.equal(s.allDone, false);
  assert.equal(s.steps.find((x) => x.id === 'tools').next, true);
  assert.equal(s.profileExists, false);
});

test('next step skips done ones, even out of order', () => {
  const p = defaultProfile();
  p.setup.done = ['tools', 'vercel'];
  const s = buildStatus(p, noKeys);
  assert.equal(s.nextStep, 'github');
  assert.equal(s.doneCount, 2);
});

test('all done', () => {
  const p = defaultProfile();
  p.setup.done = [...STEP_IDS];
  const s = buildStatus(p, noKeys);
  assert.equal(s.allDone, true);
  assert.equal(s.nextStep, null);
});

test('supabase step lists exactly what is missing', () => {
  const p = defaultProfile();
  assert.deepEqual(missingFor('supabase', p, noKeys).length, 3);
  p.accounts.supabase = { orgId: 'o', orgName: 'O', ok: true };
  const keys = [{ name: 'SUPABASE_ACCESS_TOKEN', present: true, looksValid: true, required: true }];
  assert.deepEqual(missingFor('supabase', p, keys), []);
  const odd = [{ name: 'SUPABASE_ACCESS_TOKEN', present: true, looksValid: false, required: true }];
  assert.match(missingFor('supabase', p, odd)[0], /does not look right/);
});

test('profile step wants name, email, country', () => {
  const p = defaultProfile();
  assert.equal(missingFor('profile', p, noKeys).length, 3);
  p.owner = { name: 'A', email: 'a@b.c', country: 'GR', languages: ['en'] };
  assert.deepEqual(missingFor('profile', p, noKeys), []);
});

test('script: first run prints steps and exits 0; --json has no key values', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'status-'));
  try {
    const marker = ('sbp_' + 'MARKERVALUE1234567890abcdef');
    await writeFile(path.join(home, 'secrets.env'), `SUPABASE_ACCESS_TOKEN=${marker}\n`);
    const human = runScript(home);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /Setup: 0 of 10 steps done/);
    assert.match(human.stdout, /✗ Install the basic tools/);
    assert.ok(!human.stdout.includes(marker));
    const j = runScript(home, ['--json']);
    assert.equal(j.status, 0);
    const out = JSON.parse(j.stdout);
    assert.equal(out.nextStep, 'tools');
    assert.equal(out.keys.find((k) => k.name === 'SUPABASE_ACCESS_TOKEN').present, true);
    assert.ok(!j.stdout.includes(marker));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('script: reflects saved progress', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'status-'));
  try {
    const p = defaultProfile();
    p.setup.done = ['tools', 'github'];
    await writeFile(path.join(home, 'profile.json'), JSON.stringify(p));
    const out = JSON.parse(runScript(home, ['--json']).stdout);
    assert.equal(out.doneCount, 2);
    assert.equal(out.nextStep, 'vercel');
    assert.equal(out.profileExists, true);
    const human = runScript(home).stdout;
    assert.match(human, /✓ Install the basic tools/);
    assert.match(human, /✗ Connect Vercel.*next step/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('script: --help is 0, bad flag is 2', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--wat'], { encoding: 'utf8' }).status, 2);
});
