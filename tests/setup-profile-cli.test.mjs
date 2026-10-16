import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeKey } from '../scripts/profile.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'profile.mjs');

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'profile-cli-'));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, SHIPYARD_HOME: home, NO_COLOR: '1' }, encoding: 'utf8' });
  const saved = async () => JSON.parse(await readFile(path.join(home, 'profile.json'), 'utf8'));
  try {
    await fn({ run, saved, home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('show prints the defaults as JSON', () =>
  withHome(({ run }) => {
    const r = run('show');
    assert.equal(r.status, 0);
    const p = JSON.parse(r.stdout);
    assert.equal(p.version, 1);
    assert.equal(p.defaults.layout, 'bottom-nav');
    assert.deepEqual(p.apps, []);
  }));

test('set then get: strings, booleans, numbers, lists', () =>
  withHome(async ({ run, saved }) => {
    assert.equal(run('set', 'defaults.layout', 'sidebar').status, 0);
    assert.equal(run('get', 'defaults.layout').stdout, 'sidebar\n');
    assert.equal(run('set', 'defaults.pwa', 'false').status, 0);
    assert.equal(run('get', 'defaults.pwa').stdout, 'false\n');
    assert.equal(run('set', 'owner.languages', '["en","el"]').status, 0);
    assert.deepEqual(JSON.parse(run('get', 'owner.languages').stdout), ['en', 'el']);
    assert.equal(run('set', 'company.vatId', '007').status, 0);
    const p = await saved();
    assert.equal(p.defaults.pwa, false);
    assert.equal(p.company.vatId, '007');
    assert.equal(p.defaults.layout, 'sidebar');
  }));

test('set keeps unknown keys and can clear a value', () =>
  withHome(async ({ run, saved, home }) => {
    await writeFile(path.join(home, 'profile.json'), JSON.stringify({ version: 1, futureThing: { a: 1 }, company: { legalName: 'Old' } }));
    assert.equal(run('set', 'company.legalName', '').status, 0);
    const p = await saved();
    assert.deepEqual(p.futureThing, { a: 1 });
    assert.equal(p.company.legalName, '');
  }));

test('get of a missing path exits 1', () =>
  withHome(({ run }) => {
    const r = run('get', 'nothing.here');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /nothing saved/i);
  }));

test('refuses values that look like keys and does not echo them', () =>
  withHome(async ({ run, home }) => {
    const key = ['sk_test_', 'abcdefghijklmnopqrstuvwxyz1234'].join('');
    const r = run('set', 'company.legalName', key);
    assert.equal(r.status, 1);
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key));
    assert.match(r.stdout, /secret key/);
    await assert.rejects(readFile(path.join(home, 'profile.json')));
  }));

test('looksLikeKey', () => {
  assert.equal(looksLikeKey('sbp_' + 'a'.repeat(20)), true);
  assert.equal(looksLikeKey('sk-or-v1-' + 'a'.repeat(20)), true);
  assert.equal(looksLikeKey('re_' + 'a'.repeat(20)), true);
  assert.equal(looksLikeKey('Jane Doe'), false);
  assert.equal(looksLikeKey('sidebar'), false);
  assert.equal(looksLikeKey('sk-learning'), false);
});

test('layout must be a real layout (exit 2)', () =>
  withHome(({ run }) => {
    assert.equal(run('set', 'defaults.layout', 'wide').status, 2);
  }));

test('step-done moves to the next step', () =>
  withHome(async ({ run, saved }) => {
    const r = run('step-done', 'tools');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Next step: github/);
    run('step-done', 'github');
    const p = await saved();
    assert.deepEqual(p.setup.done, ['tools', 'github']);
    assert.equal(p.setup.step, 'vercel');
    assert.equal(run('step-done', 'bogus').status, 2);
  }));

test('usage errors exit 2, help exits 0', () =>
  withHome(({ run }) => {
    assert.equal(run().status, 2);
    assert.equal(run('wat').status, 2);
    assert.equal(run('get').status, 2);
    assert.equal(run('set', 'only.one').status, 2);
    assert.equal(run('get', '__proto__.x').status, 2);
    assert.equal(run('--help').status, 0);
    assert.match(run('--help').stdout, /step-done/);
  }));
