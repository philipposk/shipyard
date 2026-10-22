// The release check (scripts/check-release.mjs) passes on this repo and catches drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-release.mjs');
const run = (env) => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, encoding: 'utf8' });

function copy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'shipyard-release-'));
  for (const p of ['.claude-plugin', '.cursor-plugin', 'skills']) cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  return dir;
}

test('passes on the repo as it is', () => {
  const r = run({ SHIPYARD_ROOT: ROOT, TAG: '' });
  assert.equal(r.status, 0, r.stderr);
});

test('fails when the tag does not match the version', () => {
  const r = run({ SHIPYARD_ROOT: ROOT, TAG: 'v99.0.0' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match/);
});

test('fails when the Cursor manifest version drifts', () => {
  const dir = copy();
  try {
    const f = path.join(dir, '.cursor-plugin', 'plugin.json');
    const j = JSON.parse(readFileSync(f, 'utf8')); j.version = '0.0.1';
    writeFileSync(f, JSON.stringify(j));
    const r = run({ SHIPYARD_ROOT: dir, TAG: '' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /versions differ/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fails when a skill folder name and SKILL.md name differ', () => {
  const dir = copy();
  try {
    const f = path.join(dir, 'skills', 'ops', 'SKILL.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^name: ops$/m, 'name: other'));
    const r = run({ SHIPYARD_ROOT: dir, TAG: '' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expected "ops"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
