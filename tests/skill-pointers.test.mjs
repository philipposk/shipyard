import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'skills');
const skills = readdirSync(skillsDir).filter((name) => readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'));

test('every skill orders a read of the shared rules and links the install doc', () => {
  for (const name of skills) {
    const text = readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(text, /https:\/\/github\.com\/philipposk\/shipyard\/blob\/main\/INSTALL\.md/, name);
    assert.match(text, /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/new-app\/references\/working-rules\.md` now, before any other step/, name);
  }
});

test('video still offers a real screen recording, and email keeps its registrar and notify triggers', () => {
  const video = readFileSync(path.join(skillsDir, 'video/SKILL.md'), 'utf8');
  assert.doesNotMatch(video, /no screen recording/);
  assert.match(video, /three ways/);
  assert.match(video, /Real run/);
  const email = readFileSync(path.join(skillsDir, 'email/SKILL.md'), 'utf8');
  assert.match(email, /Papaki DNS/);
  assert.match(email, /notify me when deployed/);
  const domain = readFileSync(path.join(skillsDir, 'email/references/email-domain.md'), 'utf8');
  assert.doesNotMatch(domain, /5\.7\/10|10\/10/);
});

test('a look does not silently change the menu, and review security helpers stay on the strongest model', () => {
  const presets = readFileSync(path.join(skillsDir, 'design/references/presets.md'), 'utf8');
  assert.match(presets, /--keep-layout` unless the student asked for that look's menu/);
  assert.doesNotMatch(presets, /applying one changes the structure as well as the colours/);
  const apply = readFileSync(path.join(skillsDir, 'design/references/apply-design.md'), 'utf8');
  assert.match(apply, /design skill passes `--keep-layout` unless the student asked/);
  const header = readFileSync(path.join(root, 'scripts/agents/header.md'), 'utf8');
  assert.match(header, /review skill assigns its sign-in, data-rules, live-audio, AI-cost and database helpers your strongest model/);
  assert.doesNotMatch(header, /helpers there only do mechanical work/);
  const facts = readFileSync(path.join(skillsDir, 'setup/references/checked-facts.md'), 'utf8');
  assert.doesNotMatch(facts, /Left for a future agent/);
  assert.match(facts, /2\.5\.8 Target Size \(Minimum\) is 24/);
  assert.match(facts, /2\.5\.5 Target Size \(Enhanced\) is 44/);
});
