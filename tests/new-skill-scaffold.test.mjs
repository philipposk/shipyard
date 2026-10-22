// The new-skill skill and its scaffold script: the skill keeps Shipyard's shape, and what the script writes passes its own check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDir, checkSkill, create, plan } from '../scripts/skill-scaffold.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'skill-scaffold.mjs');
const DESC = 'Write the weekly team report from merged pull requests. Use for "weekly report" or "what did we ship".';
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'skill-scaffold-'));

test('the new-skill skill passes its own check and names every reference it ships', () => {
  const skill = readFileSync(path.join(ROOT, 'skills', 'new-skill', 'SKILL.md'), 'utf8');
  assert.deepEqual(checkSkill(skill, 'new-skill'), []);
  assert.match(skill, /\/shipyard:new-skill/);
  for (const ref of ['interview', 'pushback', 'build-or-extend', 'anatomy', 'in-shipyard', 'publish']) {
    assert.ok(skill.includes(`references/${ref}.md`), `SKILL.md does not point to ${ref}.md`);
    assert.ok(existsSync(path.join(ROOT, 'skills', 'new-skill', 'references', `${ref}.md`)), `${ref}.md is missing`);
  }
});

test('the skill pushes back on weak specs and asks before publishing', () => {
  const skill = readFileSync(path.join(ROOT, 'skills', 'new-skill', 'SKILL.md'), 'utf8');
  assert.match(skill, /push back/i);
  assert.match(skill, /ask which they prefer/i);
  assert.match(skill, /Publishing[^\n]*ask first/i);
  assert.match(skill, /Never read `~\/\.shipyard\/secrets\.env`/);
});

test('a plugin scaffold has both manifests, a test, a README with publishing notes, and passes the check', () => {
  const dir = tmp();
  try {
    const r = create(dir, { name: 'weekly-report', description: DESC, plugin: true, author: 'Jane', repo: 'https://github.com/jane/weekly-report' });
    for (const f of ['skills/weekly-report/SKILL.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.cursor-plugin/plugin.json', 'README.md', 'LICENSE', 'tests/skill.test.mjs']) assert.ok(r.written.includes(f), f);
    const claude = JSON.parse(readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8'));
    const cursor = JSON.parse(readFileSync(path.join(dir, '.cursor-plugin/plugin.json'), 'utf8'));
    const market = JSON.parse(readFileSync(path.join(dir, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(claude.name, 'weekly-report');
    assert.equal(cursor.version, claude.version);
    assert.equal(market.plugins[0].name, claude.name);
    const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
    for (const w of ['skills.sh', 'ClawHub', 'Hermes', 'Cursor marketplace', 'jane/weekly-report']) assert.ok(readme.includes(w), w);
    assert.ok(checkDir(dir).every((x) => x.problems.length === 0));
    const t = spawnSync(process.execPath, ['--test', 'tests/skill.test.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(t.status, 0, t.stdout + t.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create never overwrites a file that is there', () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'SKILL.md'), 'mine');
    const r = create(dir, { name: 'weekly-report', description: DESC });
    assert.ok(r.skipped.includes('SKILL.md'));
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'mine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bad names and missing descriptions are refused', () => {
  assert.throws(() => plan({ name: 'Weekly Report', description: DESC }), /lowercase/);
  assert.throws(() => plan({ name: 'weekly-report' }), /description/);
});

test('the check finds each kind of problem', () => {
  const cases = [
    ['no front matter', '# hi', /no front matter/],
    ['no trigger', '---\nname: x\ndescription: Does a thing that is long enough to read well.\n---\n# x\n', /trigger/],
    ['bad name', '---\nname: X_y\ndescription: Does a thing. Use for "x" and other long phrases.\n---\n# x\n', /lowercase/],
    ['em dash', '---\nname: x\ndescription: Does a thing. Use for "x" and other long phrases.\n---\n# x\nA \u2014 B\n', /em dash/],
    ['placeholder', '---\nname: x\ndescription: Does a thing. Use for "x" and other long phrases.\n---\n# x\nTODO\n', /placeholder/],
  ];
  for (const [what, text, re] of cases) assert.ok(checkSkill(text, 'x').some((p) => re.test(p)), what);
});

test('the CLI: --help, check with --json, and a failing check exits 1', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  const ok = spawnSync(process.execPath, [SCRIPT, 'check', path.join(ROOT, 'skills'), '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, 'bad'));
    writeFileSync(path.join(dir, 'bad', 'SKILL.md'), '# nothing');
    assert.equal(spawnSync(process.execPath, [SCRIPT, 'check', dir], { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
