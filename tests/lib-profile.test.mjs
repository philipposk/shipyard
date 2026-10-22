import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const home = await mkdtemp(path.join(os.tmpdir(), 'shipyard-profile-'));
process.env.SHIPYARD_HOME = home;
const paths = await import('../scripts/lib/paths.mjs');
const P = await import('../scripts/lib/profile.mjs');

after(() => rm(home, { recursive: true, force: true }));
beforeEach(() => rm(paths.PROFILE_PATH, { force: true }));

test('paths follow SHIPYARD_HOME', () => {
  assert.equal(paths.HOME_DIR, path.resolve(home));
  assert.equal(paths.PROFILE_PATH, path.join(paths.HOME_DIR, 'profile.json'));
  assert.equal(paths.SECRETS_PATH, path.join(paths.HOME_DIR, 'secrets.env'));
  // The plugin root is the folder holding the plugin manifest, whatever the checkout is called.
  assert.equal(paths.PLUGIN_ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  assert.ok(existsSync(path.join(paths.PLUGIN_ROOT, '.claude-plugin', 'plugin.json')));
  assert.equal(paths.TEMPLATE_DIR, path.join(paths.PLUGIN_ROOT, 'template'));
});

test('loadProfile returns defaults when no file exists', async () => {
  const p = await P.loadProfile();
  assert.equal(p.version, 1);
  assert.equal(p.setup.step, 'tools');
  assert.deepEqual(p.setup.done, []);
  assert.equal(p.defaults.layout, 'bottom-nav');
  assert.deepEqual(p.apps, []);
  assert.equal(p.accounts.stripe.mode, 'test');
});

test('loadProfile merges defaults under a partial file', async () => {
  await writeFile(paths.PROFILE_PATH, JSON.stringify({ owner: { name: 'Ana' }, defaults: { layout: 'sidebar' } }));
  const p = await P.loadProfile();
  assert.equal(p.owner.name, 'Ana');
  assert.deepEqual(p.owner.languages, ['en']);
  assert.equal(p.defaults.layout, 'sidebar');
  assert.equal(p.defaults.pwa, true);
});

test('corrupt profile is moved aside and defaults returned', async () => {
  await writeFile(paths.PROFILE_PATH, '{ not json');
  const p = await P.loadProfile();
  assert.equal(p.version, 1);
  const files = await readdir(home);
  assert.ok(files.some((f) => f.startsWith('profile.json.broken-')));
});

test('getPath / setPath work with dotted paths', () => {
  const p = P.defaultProfile();
  assert.equal(P.getPath(p, 'defaults.layout'), 'bottom-nav');
  assert.equal(P.getPath(p, 'defaults.nope'), undefined);
  assert.equal(P.getPath(p, 'nope.deeper.still'), undefined);
  P.setPath(p, 'defaults.layout', 'sidebar');
  P.setPath(p, 'brand.new.key', 'x');
  assert.equal(p.defaults.layout, 'sidebar');
  assert.equal(p.brand.new.key, 'x');
});

test('setPath parses booleans, numbers, arrays, null; keeps leading-zero numbers as text', () => {
  const p = P.defaultProfile();
  P.setPath(p, 'defaults.pwa', 'false');
  P.setPath(p, 'accounts.stripe.limit', '25');
  P.setPath(p, 'owner.languages', '["el","en"]');
  P.setPath(p, 'company.vatId', '012345678');
  P.setPath(p, 'owner.name', 'Maria Papadopoulou');
  P.setPath(p, 'owner.country', '"007"');
  P.setPath(p, 'domain.name', 'null');
  assert.equal(p.defaults.pwa, false);
  assert.equal(p.accounts.stripe.limit, 25);
  assert.deepEqual(p.owner.languages, ['el', 'en']);
  assert.equal(p.company.vatId, '012345678');
  assert.equal(p.owner.name, 'Maria Papadopoulou');
  assert.equal(p.owner.country, '007');
  assert.equal(p.domain.name, null);
});

test('setPath refuses prototype-polluting paths and plain-value parents', () => {
  const p = P.defaultProfile();
  assert.throws(() => P.setPath(p, '__proto__.polluted', 'yes'));
  assert.throws(() => P.setPath(p, 'a.constructor.b', 'yes'));
  assert.throws(() => P.setPath(p, 'version.inner', 'x'));
  assert.equal({}.polluted, undefined);
});

test('markStep walks the steps in order', async () => {
  let p = await P.markStep('tools');
  assert.deepEqual(p.setup.done, ['tools']);
  assert.equal(p.setup.step, 'github');
  assert.ok(p.setup.updatedAt);
  p = await P.markStep('github');
  assert.equal(p.setup.step, 'vercel');
  assert.equal((await P.loadProfile()).setup.step, 'vercel');
});

test('markStep is idempotent, skips ahead correctly, and ends at done', async () => {
  await P.markStep('tools');
  await P.markStep('vercel');
  let p = await P.markStep('vercel');
  assert.deepEqual(p.setup.done, ['tools', 'vercel']);
  assert.equal(p.setup.step, 'github');
  for (const id of P.STEP_IDS) p = await P.markStep(id);
  assert.equal(p.setup.step, 'done');
  assert.equal(p.setup.done.length, P.STEP_IDS.length);
});

test('markStep rejects unknown ids', async () => {
  await assert.rejects(() => P.markStep('bogus'), /Unknown setup step/);
});

test('step ids are exactly the spec order', () => {
  assert.deepEqual(P.STEP_IDS, ['tools', 'github', 'vercel', 'supabase', 'ai-keys', 'email', 'stripe', 'domain', 'profile', 'habits']);
});

test('upsertApp adds, then updates by slug without losing fields', async () => {
  const a = await P.upsertApp({ slug: 'todo', name: 'Todo', dir: '/x/todo', layout: 'sidebar', modules: ['items'] });
  assert.equal(a.status, 'scaffolded');
  assert.ok(a.createdAt);
  await P.upsertApp({ slug: 'other', name: 'Other' });
  const b = await P.upsertApp({ slug: 'todo', supabaseRef: 'abcdefghijklmnopqrst', status: 'provisioned' });
  assert.equal(b.name, 'Todo');
  assert.equal(b.layout, 'sidebar');
  assert.equal(b.status, 'provisioned');
  const p = await P.loadProfile();
  assert.equal(p.apps.length, 2);
  assert.equal((await P.getApp('todo')).supabaseRef, 'abcdefghijklmnopqrst');
  assert.equal(await P.getApp('missing'), null);
});

test('upsertApp needs a slug', async () => {
  await assert.rejects(() => P.upsertApp({ name: 'x' }), /slug/);
});

test('unknown keys survive a load, change and save round trip', async () => {
  await writeFile(paths.PROFILE_PATH, JSON.stringify({ futureThing: { a: 1 }, owner: { nickname: 'Z' } }));
  const p = await P.loadProfile();
  P.setPath(p, 'owner.name', 'Ana');
  await P.saveProfile(p);
  await P.markStep('tools');
  const onDisk = JSON.parse(await readFile(paths.PROFILE_PATH, 'utf8'));
  assert.deepEqual(onDisk.futureThing, { a: 1 });
  assert.equal(onDisk.owner.nickname, 'Z');
  assert.equal(onDisk.owner.name, 'Ana');
});

test('saveProfile is atomic: no temp files left, file is valid JSON', async () => {
  const p = P.defaultProfile();
  await Promise.all([1, 2, 3, 4, 5].map((n) => P.saveProfile({ ...p, owner: { ...p.owner, name: `n${n}` } })));
  const files = await readdir(home);
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
  const parsed = JSON.parse(await readFile(paths.PROFILE_PATH, 'utf8'));
  assert.match(parsed.owner.name, /^n[1-5]$/);
});
