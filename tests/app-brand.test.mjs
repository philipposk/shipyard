// The app's name is set once, in src/lib/constants.ts. A rename there must reach the app's own files
// (manifest, llms.txt) and every Shipyard script that reads the app (through readAppConfig).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-brand-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));

const S = await import('../scripts/provision/scaffold-core.mjs');
const { readAppConfig } = await import('../scripts/provision/common.mjs');
const { parseBrand, withBrand } = await import('../scripts/lib/brand.mjs');
const { resolveAppName } = await import('../scripts/verify/util.mjs');

const noGit = async () => ({ code: 1, stdout: '', stderr: '' });

test('parseBrand: reads the identity constants and treats placeholders as missing', () => {
  const text = 'export const SITE_NAME = "Tom\'s \\"Box\\"";\nexport const SITE_SHORT_NAME = "<APP_SHORT_NAME>";\nexport const SITE_DESCRIPTION = "Saves things.";';
  assert.deepEqual(parseBrand(text), { name: 'Tom\'s "Box"', shortName: null, description: 'Saves things.', tagline: null });
  assert.deepEqual(withBrand({ slug: 'a', name: 'Old', description: 'Old.' }, { name: 'New', description: null }), { slug: 'a', name: 'New', description: 'Old.' });
  assert.deepEqual(withBrand({ slug: 'a', name: 'Old' }, null), { slug: 'a', name: 'Old' });
});

test('a rename in constants.ts reaches the manifest, llms.txt, design check and Shipyard scripts', async () => {
  const r = await S.scaffold({ slug: 'recipe-box', name: 'Recipe Box', description: 'Save recipes and find them again.', parent: tmp }, { run: noGit });
  const dir = r.dir;
  const constantsPath = path.join(dir, 'src', 'lib', 'constants.ts');
  const node = (...args) => spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });

  // Freshly made: everything already agrees.
  assert.equal(node('scripts/sync-brand.mjs', '--check').status, 0);
  assert.equal(node('scripts/design-check.mjs').status, 0, 'the template never types the app name');

  // The one-line rename.
  const before = await readFile(constantsPath, 'utf8');
  await writeFile(constantsPath, before.replace('export const SITE_NAME = "Recipe Box";', 'export const SITE_NAME = "Cookbook Club";'));

  const stale = node('scripts/sync-brand.mjs', '--check');
  assert.equal(stale.status, 1, 'the check notices the manifest is out of date');
  assert.match(stale.stderr, /npm run sync:brand/);
  assert.equal(node('scripts/sync-brand.mjs').status, 0);
  const manifest = JSON.parse(await readFile(path.join(dir, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Cookbook Club');
  assert.ok(manifest.icons.length > 0, 'icons are kept');
  assert.match(await readFile(path.join(dir, 'public', 'llms.txt'), 'utf8'), /^# Cookbook Club\n/);
  assert.equal(node('scripts/sync-brand.mjs', '--check').status, 0);

  // Shipyard's own scripts read the new name, even though .shipyard-app.json still has the old one.
  const raw = JSON.parse(await readFile(path.join(dir, '.shipyard-app.json'), 'utf8'));
  assert.equal(raw.name, 'Recipe Box');
  assert.equal((await readAppConfig(dir)).name, 'Cookbook Club');
  assert.equal(await resolveAppName({ appDir: dir, app: { name: 'Recipe Box' } }), 'Cookbook Club');

  // Typing the new name into a page is caught by the design check.
  await writeFile(path.join(dir, 'src', 'app', 'about', 'extra.tsx'), 'export const A = () => <h1>About Cookbook Club</h1>;\n');
  const check = node('scripts/design-check.mjs');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /hard-coded-brand/);
});
