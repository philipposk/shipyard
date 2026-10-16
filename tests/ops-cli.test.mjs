// The three ops commands as programs: --help, wrong options, --json errors, and starting through a symlink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './ops-helpers.mjs';

const SCRIPTS = ['ops-setup.mjs', 'ops-status.mjs', 'backup-export.mjs'];

function runScript(script, args, extraEnv = {}, cwd) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'shipyard-opscli-'));
  try {
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8', cwd, timeout: 30_000,
      env: { ...process.env, SHIPYARD_HOME: path.join(home, 'home'), ...extraEnv },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const script of SCRIPTS) {
  test(`${script} --help explains itself and exits 0`, () => {
    const r = runScript(script, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /Exit code: 0/);
    assert.match(r.stdout, /--json/);
  });

  test(`${script} with a wrong option exits 2, in plain words`, () => {
    const r = runScript(script, ['somewhere', '--nope']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /Unknown option --nope/);
  });

  test(`${script} with --json prints errors as JSON`, () => {
    const r = runScript(script, ['--json']);
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /app folder/);
  });

  test(`${script} with a folder that does not exist exits 1 with a plain message`, () => {
    const r = runScript(script, ['/definitely/not/here', '--json']);
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error, /does not exist/);
  });

  test(`${script} prints output when started through a symlinked folder`, { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-opslink-'));
    try {
      const link = path.join(dir, 'scripts-link');
      symlinkSync(path.join(ROOT, 'scripts'), link, 'dir');
      const r = spawnSync(process.execPath, [path.join(link, script), '--help'], { encoding: 'utf8', env: { ...process.env, SHIPYARD_HOME: path.join(dir, 'home') } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Usage:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('ops-setup refuses an unknown part in --only before touching anything', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-opsonly-'));
  try {
    mkdirSync(path.join(dir, 'app'));
    const r = runScript('ops-setup.mjs', [path.join(dir, 'app'), '--only', 'health,nope', '--json']);
    assert.equal(r.status, 2);
    assert.match(JSON.parse(r.stdout).error, /nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup-export checks --page-size', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-opspage-'));
  try {
    for (const bad of ['10', 'abc', '99999', '1.5']) {
      const r = runScript('backup-export.mjs', [dir, '--page-size', bad, '--json']);
      assert.equal(r.status, 2, bad);
      assert.match(JSON.parse(r.stdout).error, /page-size/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder that is not a Shipyard app gets a plain message from every command', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-opsnot-'));
  try {
    for (const script of SCRIPTS) {
      const r = runScript(script, [dir, '--json']);
      assert.equal(r.status, 1, script);
      assert.match(JSON.parse(r.stdout).error, /not made by Shipyard/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
