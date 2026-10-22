#!/usr/bin/env node
// Release check: every publishing manifest names the same version (and the tag, when given),
// the Cursor manifest is well formed, and skills/ is a valid skill tap
// (one folder per skill, each with a SKILL.md whose frontmatter has name and description).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SHIPYARD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const problems = [];

const claude = read('.claude-plugin/plugin.json');
const cursor = read('.cursor-plugin/plugin.json');
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(cursor.name || '')) problems.push('.cursor-plugin name must be lowercase kebab-case');
if (cursor.name !== claude.name) problems.push(`plugin names differ: claude=${claude.name} cursor=${cursor.name}`);
if (cursor.version !== claude.version) problems.push(`versions differ: claude=${claude.version} cursor=${cursor.version}`);
const tag = (process.env.TAG || '').replace(/^v/, '');
if (tag && tag !== claude.version) problems.push(`tag v${tag} does not match plugin version ${claude.version}`);

const skillsDir = path.join(ROOT, 'skills');
const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^[._]/.test(d.name));
if (skills.length === 0) problems.push('skills/ has no skill folders');
for (const d of skills) {
  const file = path.join(skillsDir, d.name, 'SKILL.md');
  if (!existsSync(file)) { problems.push(`skills/${d.name} has no SKILL.md`); continue; }
  const fm = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { problems.push(`skills/${d.name}/SKILL.md has no frontmatter`); continue; }
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  if (name !== d.name) problems.push(`skills/${d.name}/SKILL.md name is "${name}", expected "${d.name}"`);
  if (!/^description:\s*\S/m.test(fm[1])) problems.push(`skills/${d.name}/SKILL.md has no description`);
}

if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
console.log(`release check ok: v${claude.version}, ${skills.length} skills`);
