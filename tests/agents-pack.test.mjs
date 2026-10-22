// The Codex and Cursor copy of the skills ("the pack"), generated from the real skills/ folder.
// It must hold no Claude Code only wording, run every script by its full quoted path, and every
// script command it holds must be one the key guard trusts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../scripts/guard-secrets.mjs';
import { decide } from '../scripts/agents/guard-input.mjs';
import { applyRewrites, checkRoot, lintPack, LINT_RULES, planPack, rewriteText, SKILLS, splitFrontmatter } from '../scripts/agents/core.mjs';
import { REWRITES } from '../scripts/agents/rewrites.mjs';
import { privateWordsRegex } from './private-words.mjs';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).replace(/\\/g, '/');
const SKILLS_DIR = '/home/jane/.agents/skills';
const VERSION = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const AT = '2026-10-21T08:00:00.000Z';
const HEADER = readFileSync(path.join(ROOT, 'scripts', 'agents', 'header.md'), 'utf8');

const realPack = () => planPack({ root: ROOT, skillsDir: SKILLS_DIR, version: VERSION, generatedAt: AT });
const texts = (pack) => pack.flatMap(({ name, files }) => [...files].filter(([, d]) => typeof d === 'string').map(([rel, d]) => [`${name}/${rel}`, d]));

test('every anchored rewrite still matches its source exactly once', () => {
  for (const row of REWRITES) {
    const file = path.join(ROOT, 'skills', row.file);
    assert.ok(existsSync(file), `${row.id}: skills/${row.file} is gone`);
    const { missing } = applyRewrites(readFileSync(file, 'utf8'), row.file, [row]);
    assert.deepEqual(missing, [], `${row.id} in skills/${row.file} no longer matches exactly once: update scripts/agents/rewrites.mjs`);
  }
  const ids = REWRITES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rewrite ids are unique');
});

test('a source change that breaks an anchor stops the pack instead of shipping old wording', () => {
  const row = { id: 'X1', file: 'demo/SKILL.md', find: 'Ask Claude here.', replace: 'Ask here.' };
  assert.equal(rewriteText('Ask Claude here.', { file: 'demo/SKILL.md', root: ROOT, skillsDir: SKILLS_DIR, rows: [row] }), 'Ask here.');
  assert.throws(() => rewriteText('Changed text.', { file: 'demo/SKILL.md', root: ROOT, skillsDir: SKILLS_DIR, rows: [row] }), /rewrites\.mjs is out of date.*X1/);
});

test('the generated pack passes the lint (no Claude Code only wording, no em dash, no placeholders)', () => {
  const problems = lintPack(realPack());
  assert.deepEqual(problems, [], problems.map((p) => `${p.file}:${p.line ?? ''} ${p.problem}: ${p.text ?? ''}`).join('\n'));
});

test('the lint catches each kind of leftover', () => {
  const samples = {
    'CLAUDE_PLUGIN_ROOT': 'run ${CLAUDE_PLUGIN_ROOT}/x',
    '/shipyard:': 'type /shipyard:setup',
    '~/.claude': 'edit ~/.claude/CLAUDE.md',
    Claude: 'ask Claude to do it',
    Anthropic: 'an Anthropic key',
    model: 'use Sonnet',
    'model: "': 'model: "x"',
    'Read tool': 'with the Read tool',
    '/plugin': 'type /plugin',
    '/usage': 'check /usage',
    '/code-review': 'run /code-review',
    '/install-github-app': 'run /install-github-app',
    'claude-code-action': 'uses claude-code-action',
    CLAUDE_CODE_OAUTH_TOKEN: 'set CLAUDE_CODE_OAUTH_TOKEN',
    'claude plugin': 'claude plugin install x',
    '--providers=claude': 'npx x --providers=claude',
    '--ai claude': 'uipro init --ai claude',
    'em dash': 'a \u2014 b',
    placeholder: 'at {{ROOT}}',
  };
  for (const [what, line] of Object.entries(samples)) {
    assert.ok(LINT_RULES.some(([re]) => re.test(line)), `the lint misses ${what}`);
  }
  for (const fine of ['(Claude Code only: skip this here.)', 'see CLAUDE.md', 'the app keeps its keys in .env.example form']) {
    assert.ok(!LINT_RULES.some(([re]) => re.test(fine)), fine);
  }
});

test('names and descriptions follow the skill rules', () => {
  for (const { name, skill, files } of realPack()) {
    assert.equal(name, `shipyard-${skill}`);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64);
    const text = files.get('SKILL.md');
    const { fields } = splitFrontmatter(text);
    assert.deepEqual(Object.keys(fields), ['name', 'description']);
    assert.equal(fields.name, name);
    assert.ok(fields.description.startsWith(`Shipyard ${skill}: `), fields.description);
    assert.ok(fields.description.length >= 1 && fields.description.length <= 1024);
    assert.match(text, /^---\nname: shipyard-[a-z-]+\ndescription: "/);
    assert.ok(!fields.description.includes('/shipyard:'));
  }
  assert.deepEqual(realPack().map((p) => p.skill), SKILLS);
});

test('the header appears once, in SKILL.md only, right after the frontmatter', () => {
  for (const { name, files } of realPack()) {
    for (const [rel, data] of files) {
      if (typeof data !== 'string') continue;
      const count = data.split('for Codex and Cursor, installed').length - 1;
      assert.equal(count, rel === 'SKILL.md' ? 1 : 0, `${name}/${rel}`);
    }
    assert.match(files.get('SKILL.md'), /\n---\n\n> Shipyard [0-9.]+ for Codex and Cursor, installed 2026-10-21 from `/);
  }
});

test('the pack is the source plus rewrites: other files are copied byte for byte, and a marker is added', () => {
  for (const { name, skill, files } of realPack()) {
    for (const [rel, data] of files) {
      if (rel === '.shipyard-generated.json') {
        assert.deepEqual(JSON.parse(data), { root: ROOT, version: VERSION, generatedAt: AT });
        continue;
      }
      const src = path.join(ROOT, 'skills', skill, rel);
      assert.ok(existsSync(src), `${name}/${rel} has no source`);
      if (!rel.endsWith('.md')) assert.ok(Buffer.compare(readFileSync(src), data) === 0, `${name}/${rel} is not a copy`);
    }
  }
});

test('every script and file path in the pack exists in this Shipyard folder', () => {
  const re = new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/((?:scripts|skills)/[A-Za-z0-9_./-]+\\.(?:mjs|md))`, 'g');
  let seen = 0;
  for (const [where, text] of texts(realPack())) {
    for (const m of text.matchAll(re)) {
      seen++;
      assert.ok(existsSync(path.join(ROOT, m[1])), `${where} names ${m[1]}, which does not exist`);
    }
  }
  assert.ok(seen > 30, `only ${seen} paths found`);
});

/** Every `node "<root>/scripts/..."` command in the pack, with <placeholders> filled in. */
function packCommands(pack, root) {
  const cmds = new Set();
  const prefix = `node "${root}/scripts/`;
  for (const [, text] of texts(pack)) {
    for (const m of text.matchAll(/`(node "[^`]*)`/g)) if (m[1].startsWith(prefix)) cmds.add(m[1].replace(/<[^>]*>/g, 'app').replace(/\[|\]/g, ''));
  }
  return [...cmds];
}

test('the key guard trusts every Shipyard command in the pack (plain, and as Codex wraps it)', () => {
  const cmds = packCommands(realPack(), ROOT);
  assert.ok(cmds.length > 30, `only ${cmds.length} commands found`);
  const env = { SHIPYARD_HOME: '/home/jane/.shipyard' };
  for (const command of cmds) {
    assert.equal(evaluate({ tool_name: 'Bash', tool_input: { command }, cwd: '/work/app' }, env).deny, false, command);
    const codex = { session_id: 's', turn_id: 't', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ['bash', '-lc', command] }, cwd: '/work/app' };
    assert.equal(decide(codex, env, 'codex').deny, false, `codex: ${command}`);
    const cursor = { hook_event_name: 'beforeShellExecution', command, cwd: '/work/app', cursor_version: '2.0' };
    assert.equal(decide(cursor, env, 'cursor').deny, false, `cursor: ${command}`);
  }
  // And the same command pointed at a keys file the other way round is still refused.
  assert.equal(evaluate({ tool_name: 'Bash', tool_input: { command: `node "${ROOT}/scripts/profile.mjs" show; cat .env.local` }, cwd: '/work/app' }, env).deny, true);
});

for (const root of ['/home/Jane Doe/.local/share/shipyard', 'C:/Users/Jane Doe/.local/share/shipyard']) {
  test(`a root with spaces stays inside quotes (${root})`, () => {
    const pack = planPack({ root, skillsDir: SKILLS_DIR, version: VERSION, generatedAt: AT, skillsSrc: path.join(ROOT, 'skills'), header: HEADER });
    assert.deepEqual(lintPack(pack), []);
    let count = 0;
    for (const [where, text] of texts(pack)) {
      let at = text.indexOf(root);
      while (at !== -1) {
        count++;
        const before = text[at - 1];
        assert.ok(before === '"' || before === '`', `${where}: the root is not quoted: ...${text.slice(Math.max(0, at - 20), at + root.length + 10)}`);
        const rest = text.slice(at + root.length);
        const close = rest.indexOf(before);
        assert.ok(close !== -1 && !rest.slice(0, close).includes('\n'), `${where}: the quote is not closed on the same line`);
        at = text.indexOf(root, at + 1);
      }
    }
    assert.ok(count > 30);
    if (root.startsWith('C:')) assert.ok(!texts(pack).some(([, t]) => t.includes('C:\\')), 'Windows roots use forward slashes');
  });
}

test('roots the hooks or the guard cannot use are refused', () => {
  for (const bad of ['/home/a"b/shipyard', '/home/a`b/shipyard', '/home/$USER/shipyard', '/home/100%/shipyard', '/home/a\nb/shipyard']) {
    assert.match(checkRoot(bad), /character/, JSON.stringify(bad));
  }
  assert.match(checkRoot('/home/jane/.shipyard/shipyard'), /\.shipyard/);
  assert.match(checkRoot('/data/keys/shipyard', { shipyardHome: '/data/keys' }), /inside your keys folder/);
  assert.match(checkRoot('/data/keys', { shipyardHome: '/data/keys' }), /inside your keys folder/);
  assert.equal(checkRoot('/data/keys-other/shipyard', { shipyardHome: '/data/keys' }), null);
  assert.equal(checkRoot('/home/jane/.local/share/shipyard', { shipyardHome: '/home/jane/.shipyard' }), null);
  assert.equal(checkRoot('C:/Users/Jane Doe/.local/share/shipyard'), null);
});

test('header.md and habits.md are agent-neutral', () => {
  const words = privateWordsRegex();
  for (const file of ['header.md', 'habits.md']) {
    const text = readFileSync(path.join(ROOT, 'scripts', 'agents', file), 'utf8');
    assert.ok(!/claude/i.test(text), `${file} mentions Claude`);
    assert.ok(!/\b(Opus|Sonnet|Haiku|GPT-?\d)\b/i.test(text), `${file} names a model`);
    assert.ok(!text.includes('\u2014'), `${file} has an em dash`);
    if (words) assert.ok(!words.test(text), `${file} has a private word`);
  }
  const header = readFileSync(path.join(ROOT, 'scripts', 'agents', 'header.md'), 'utf8');
  assert.deepEqual([...new Set(header.match(/\{\{[A-Z_]+\}\}/g))].sort(), ['{{DATE}}', '{{ROOT}}', '{{VERSION}}']);
  assert.match(header, /guard-check\.mjs" start/);
  assert.match(header, /\$shipyard-<name>` in Codex or `\/shipyard-<name>` in Cursor/);
});

test('the habits match the Claude Code starter apart from agent wording', () => {
  const habits = readFileSync(path.join(ROOT, 'scripts', 'agents', 'habits.md'), 'utf8').split('\n');
  const starter = readFileSync(path.join(ROOT, 'starter', 'CLAUDE.md'), 'utf8').split('\n');
  assert.equal(habits.length, starter.length, 'same number of lines as starter/CLAUDE.md');
  assert.equal(habits[0], starter[0]);
});

test('the lint skips the paths filled in from this computer (a home folder named Claude is fine)', () => {
  const root = 'C:/Users/Claude/Opus/shipyard';
  const skillsDir = 'C:/Users/Claude/.agents/skills';
  const pack = planPack({ root, skillsDir, version: VERSION, generatedAt: AT, skillsSrc: path.join(ROOT, 'skills'), header: HEADER });
  assert.ok(lintPack(pack).length > 0, 'the paths alone trip the rules');
  assert.deepEqual(lintPack(pack, { ignore: [root, skillsDir] }), []);
  const bad = [{ name: 'x', files: new Map([['SKILL.md', 'Use Claude and Opus here.\n']]) }];
  assert.ok(lintPack(bad, { ignore: [root, skillsDir] }).length > 0, 'real leftovers are still caught');
});
