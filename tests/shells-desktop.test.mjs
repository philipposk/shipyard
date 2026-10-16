import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './shells-helpers.mjs';

const desktop = (...p) => readFile(path.join(ROOT, 'shells', 'desktop', ...p), 'utf8');

test('desktop window: a server redirect to another site never loads inside the window', async () => {
  const main = await desktop('main.js');
  assert.match(main, /on\("will-redirect", \(event, url, _isInPlace, isMainFrame\)/);
  assert.match(main, /will-redirect[\s\S]{0,200}!isAppUrl\(url\)[\s\S]{0,120}event\.preventDefault\(\)[\s\S]{0,80}openInBrowser\(url\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
});

test('desktop installer: Electron is built with the Node switches turned off', async () => {
  const pkg = JSON.parse(await desktop('package.json'));
  assert.equal(pkg.build.electronFuses.runAsNode, false);
  assert.equal(pkg.build.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(pkg.build.electronFuses.enableNodeCliInspectArguments, false);
});

test('release workflow: the build jobs that install packages only get a read token; only the release job can write', async () => {
  const yml = await desktop('workflows', 'desktop-release.yml');
  const top = yml.slice(yml.indexOf('\npermissions:'), yml.indexOf('\njobs:'));
  assert.match(top, /contents: read/);
  assert.doesNotMatch(top, /contents: write/);
  const release = yml.slice(yml.indexOf('\n  release:'));
  assert.match(release, /permissions:\n\s+contents: write/);
  const build = yml.slice(yml.indexOf('\n  build:'), yml.indexOf('\n  release:'));
  assert.doesNotMatch(build, /contents: write/);
  assert.match(yml, /npm ci/);
  assert.match(yml, /Open Anyway/);
  assert.doesNotMatch(yml, /right-click the app/);
});

test('workflows that go into a student\'s repo pin every action to a full commit with a version comment', async () => {
  for (const file of [path.join('shells', 'desktop', 'workflows', 'desktop-release.yml'), path.join('template', '.github', 'workflows', 'test.yml')]) {
    const yml = await readFile(path.join(ROOT, file), 'utf8');
    const uses = yml.split('\n').filter((l) => /^\s*(?:-\s+)?uses:/.test(l));
    assert.ok(uses.length > 0, file);
    for (const line of uses) assert.match(line, /uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/, `${file}: ${line.trim()}`);
  }
});
