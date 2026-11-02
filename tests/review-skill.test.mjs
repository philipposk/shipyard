// The review skill's files: the which-app first step, references that exist, a generic example, no private words,
// and a Codex and Cursor copy without Claude Code only wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPack } from '../scripts/agents/core.mjs';
import { privateWordsRegex } from './private-words.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'review');
const skill = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const OWN_FILES = [...walk(SKILL_DIR), ...walk(path.join(ROOT, 'scripts', 'review'))];

test('the review skill starts with the which-app step and never stops on a general app', () => {
  assert.match(skill, /^## First: which app is this\?/m);
  assert.match(skill, /which-app\.mjs/);
  assert.match(skill, /`general`[^\n]*Do not stop/);
  assert.match(skill, /`damaged`/);
  assert.match(skill, /INSTALL\.md/);
  assert.match(skill, /\/shipyard:review/);
});

test('every reference, workflow and script the skill names exists', () => {
  const texts = OWN_FILES.filter((f) => f.endsWith('.md')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const named = [...new Set([...texts.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.(?:json|mjs|js|md))(?!\w)/g)].map((m) => m[1]))];
  assert.ok(named.length >= 6, `only ${named.length} paths named`);
  for (const rel of named) assert.ok(existsSync(path.join(ROOT, rel)), `${rel} does not exist`);
  // Bare references/... names are this skill's own, or new-app's when the text says so.
  for (const m of texts.matchAll(/`(references\/[\w.-]+\.md)`/g)) {
    assert.ok(existsSync(path.join(SKILL_DIR, m[1])) || existsSync(path.join(ROOT, 'skills', 'new-app', m[1])), `${m[1]} does not exist`);
  }
  for (const wf of ['review.js', 'content-gaps.js', 'fix-waves.js', 'diff-review.js']) assert.match(texts, new RegExp(wf.replace('.', '\\.')));
});

test('the example areas are generic and complete', () => {
  const areas = JSON.parse(readFileSync(path.join(SKILL_DIR, 'examples', 'nextjs-supabase-areas.json'), 'utf8'));
  assert.equal(areas.length, 18);
  assert.equal(new Set(areas.map((a) => a.key)).size, 18);
  for (const a of areas) {
    assert.match(a.key, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof a.strong, 'boolean', a.key);
    assert.ok(a.scope.length > 80, `${a.key} scope is too thin`);
    assert.doesNotMatch(a.scope, /\/Users\/|\/home\/|~\/\.claude|—/, a.key);
  }
  for (const key of ['auth-signin', 'api-routes', 'db-rls', 'ai-llm', 'api-keys-mcp', 'realtime-live']) assert.equal(areas.find((a) => a.key === key)?.strong, true, key);
});

test('no private words, machine paths or em dashes in the skill and its scripts', () => {
  const words = privateWordsRegex();
  for (const f of OWN_FILES) {
    const text = readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    if (words) assert.ok(!words.test(text), `${rel} has a private word`);
    assert.doesNotMatch(text, /\/Users\/[a-z]|~\/\.claude\/skills/, rel);
    if (f.endsWith('.md') || f.endsWith('.json')) assert.doesNotMatch(text, /—/, rel);
  }
});

test('the Codex and Cursor copy drops the Workflow tool section and keeps the do-it-yourself one', () => {
  const header = readFileSync(path.join(ROOT, 'scripts', 'agents', 'header.md'), 'utf8');
  const pack = planPack({ root: ROOT, skillsDir: '/home/jane/.agents/skills', version: '0.0.0', generatedAt: '2026-10-28T00:00:00.000Z', header });
  const review = pack.find((p) => p.skill === 'review');
  assert.ok(review, 'review is in the pack');
  const wf = review.files.get('references/workflows.md');
  assert.doesNotMatch(wf, /scriptPath|Opus|Sonnet|resumeFromRunId/);
  assert.match(wf, /## Without a workflow tool/);
  assert.match(review.files.get('SKILL.md'), /^name: shipyard-review$/m);
  for (const f of ['workflows/review.js', 'examples/nextjs-supabase-areas.json']) assert.ok(review.files.has(f), f);
});
