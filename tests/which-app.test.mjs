import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPack } from '../scripts/agents/core.mjs';
import { classifyApp } from '../scripts/which-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'which-app.mjs');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 15_000 });
}

test('a folder with no marker is a general app', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-which-gen-'));
  try {
    assert.deepEqual(await classifyApp(dir), { kind: 'general' });
    const r = run([dir, '--json']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).kind, 'general');
    assert.match(run([dir]).stdout, /general/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a valid marker is a Shipyard app', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-which-sy-'));
  try {
    writeFileSync(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug: 'umami-table' }));
    assert.deepEqual(await classifyApp(dir), { kind: 'shipyard', slug: 'umami-table' });
    const r = run([dir, '--json']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).kind, 'shipyard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken marker is not treated as a general app', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-which-bad-'));
  try {
    writeFileSync(path.join(dir, '.shipyard-app.json'), '{');
    assert.equal((await classifyApp(dir)).kind, 'damaged');
    const r = run([dir, '--json']);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).kind, 'damaged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gated skills send a general app to the full upgrade, and do not stop', () => {
  const files = ['design/SKILL.md', 'ops/SKILL.md', 'launch/SKILL.md', 'video/SKILL.md', 'new-app/SKILL.md'];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, 'skills', rel), 'utf8');
    assert.match(text, /which-app\.mjs/, rel);
    assert.match(text, /Do not stop/, rel);
    assert.doesNotMatch(text, /stop and explain/, rel);
  }
  const upgrade = readFileSync(path.join(ROOT, 'skills', 'new-app', 'references', 'upgrade.md'), 'utf8');
  assert.match(upgrade, /full Shipyard standard/);
  assert.match(upgrade, /three directions/);
  assert.match(upgrade, /Do not run `apply-design\.mjs`/);
  assert.match(upgrade, /A look-only pass is not this step/);
  assert.match(upgrade, /row level security/);
});

test('the Cursor and Codex copy keeps the upgrade switch', () => {
  const version = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const header = readFileSync(path.join(ROOT, 'scripts', 'agents', 'header.md'), 'utf8');
  const pack = planPack({
    root: ROOT,
    skillsDir: '/home/jane/.agents/skills',
    version,
    generatedAt: '2026-10-25T12:00:00.000Z',
    header,
  });
  for (const skill of ['design', 'ops', 'launch', 'video']) {
    const text = pack.find((p) => p.skill === skill).files.get('SKILL.md');
    assert.match(text, /\/home\/jane\/\.agents\/skills\/shipyard-new-app\/references\/upgrade\.md/, skill);
    assert.doesNotMatch(text, /stop and explain/, skill);
    assert.match(text, /Do not stop/, skill);
  }
});
