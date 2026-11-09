import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipe = readFileSync(path.join(root, 'skills/design/references/shadcn-theme-packs.md'), 'utf8');
const skill = readFileSync(path.join(root, 'skills/design/SKILL.md'), 'utf8');

test('the shadcn recipe uses the template variable names and is linked from design', () => {
  assert.match(recipe, /var\(--accent-contrast\)/);
  assert.doesNotMatch(recipe, /--on-accent|--sidebar-bg|MindScope|Studio|Calm blue|Soft pastel/);
  assert.match(recipe, /extend the existing `@theme inline`/i);
  assert.match(recipe, /do not set `--font-sans` again/);
  assert.match(skill, /shadcn-theme-packs\.md/);
  assert.equal(existsSync(path.join(root, 'docs/lessons-2026-11-09.md')), false);
});
