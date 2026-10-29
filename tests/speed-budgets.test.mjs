// The template runs its server next to the default database region, and the review's speed check is wired in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('template vercel.json pins functions to fra1 (next to the default eu-central-1 database)', () => {
  assert.deepEqual(JSON.parse(read('template/vercel.json')).regions, ['fra1']);
  assert.match(read('scripts/provision-supabase.mjs'), /default eu-central-1/);
});

test('the review skill measures every main screen with the speed reference', () => {
  assert.match(read('skills/review/SKILL.md'), /references\/speed\.md/);
  const speed = read('skills/review/references/speed.md');
  for (const s of ['under 100 ms', 'under 300 ms', '4x CPU', 'tap-timing.mjs']) assert.ok(speed.includes(s), s);
});

test('tap-timing.mjs parses', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'skills/review/references/tap-timing.mjs')]);
});

test('the speed guide covers per-row privacy rules and new-app runs the check', () => {
  const speed = read('skills/review/references/speed.md');
  for (const s of ['(select auth.uid())', 'allowed_ids()', 'rls-speed.mjs', 'explain analyze']) assert.ok(speed.includes(s), s);
  assert.match(read('skills/new-app/SKILL.md'), /rls-speed\.mjs/);
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'skills/review/references/rls-speed.mjs')]);
});
