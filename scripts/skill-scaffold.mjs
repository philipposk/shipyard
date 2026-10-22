#!/usr/bin/env node
// Scaffold and check a skill or plugin that works in Claude Code, Codex, Cursor and other agents that read
// `~/.agents/skills`. Built-ins only. Never overwrites a file that exists, never pushes, never publishes.
//
//   node scripts/skill-scaffold.mjs create <dir> --name <kebab-name> --description "<what. Use for ...>" [--plugin] [--author <name>] [--repo <url>] [--json]
//   node scripts/skill-scaffold.mjs check <dir> [--json]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HELP = `Usage:
  skill-scaffold.mjs create <dir> --name <kebab-name> --description "<what it does. Use for ...>" [--plugin] [--author <name>] [--repo <url>] [--json]
  skill-scaffold.mjs check <dir> [--json]
create writes a skill folder (SKILL.md, references/, tests/). With --plugin it also writes
.claude-plugin/plugin.json, .claude-plugin/marketplace.json, .cursor-plugin/plugin.json and README.md with publishing notes.
It never overwrites a file that already exists. check lints every SKILL.md under <dir>.`;

/** Front matter of a SKILL.md as { fields, body }. Only simple `key: value` lines (quoted or not). */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return { fields: null, body: String(text) };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { /* keep raw */ } }
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    fields[kv[1]] = v;
  }
  return { fields, body: m[2] };
}

/** Problems with one SKILL.md, worded for a person. Empty means fine. */
export function checkSkill(text, folderName) {
  const problems = [];
  const { fields, body } = frontmatter(text);
  if (!fields) return ['no front matter: the file must start with --- name/description ---'];
  const keys = Object.keys(fields);
  if (!fields.name) problems.push('no name');
  else {
    if (!NAME_RE.test(fields.name)) problems.push(`name "${fields.name}" must be lowercase words joined by dashes`);
    if (fields.name.length > 64) problems.push('name is longer than 64 characters');
    if (folderName && fields.name !== folderName && !fields.name.endsWith(`-${folderName}`)) problems.push(`name "${fields.name}" does not match its folder "${folderName}"`);
  }
  const d = fields.description ?? '';
  if (!d) problems.push('no description');
  else {
    if (d.length > 1024) problems.push('description is longer than 1024 characters');
    if (d.length < 40) problems.push('description is too short to tell an agent when to use it');
    if (!/\bUse (for|when)\b/i.test(d)) problems.push('description has no trigger sentence ("Use for ..." or "Use when ...")');
  }
  const extra = keys.filter((k) => !['name', 'description', 'license', 'metadata', 'allowed-tools'].includes(k));
  if (extra.length) problems.push(`front matter keys other agents may reject: ${extra.join(', ')}`);
  if (/—/.test(text)) problems.push('an em dash (use a colon or a comma)');
  if (/\{\{[A-Z_]+\}\}|\bTODO\b|lorem ipsum/i.test(body)) problems.push('a leftover placeholder (TODO, {{...}} or lorem ipsum)');
  if (body.split('\n').length > 500) problems.push('SKILL.md is over 500 lines: move detail into references/');
  if (!/^#\s/m.test(body)) problems.push('no heading in the body');
  return problems;
}

function skillFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === 'SKILL.md') out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

export function checkDir(dir) {
  return skillFiles(dir).map((file) => ({ file, problems: checkSkill(readFileSync(file, 'utf8'), path.basename(path.dirname(file))) }));
}

const json = (x) => `${JSON.stringify(x, null, 2)}\n`;

/** The files `create` writes, as [relative path, text]. Pure, for tests. */
export function plan({ name, description, plugin = false, author = 'you', repo = '' }) {
  if (!NAME_RE.test(name ?? '')) throw new Error('--name must be lowercase words joined by dashes, like "weekly-report"');
  if (!description) throw new Error('--description is required: say what it does, then "Use for ..." with the phrases people type');
  const base = plugin ? path.posix.join('skills', name) : '';
  const p = (rel) => (base ? path.posix.join(base, rel) : rel);
  const skill = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\nOne paragraph: who this is for and the outcome they get.\n\n## Rules (always)\n\n- You do the work. Never hand the person a command you could run.\n- Ask one question at a time, with your recommended answer.\n- Ask before anything that costs money, publishes, sends or deletes.\n- Verify before saying done. Say what was checked and what was not.\n\n## 1. Steps\n\n1. First step. Read \`references/details.md\` when you need the detail.\n2. Next step.\n\n## Done when\n\n- The outcome is checked, and the person was told what was checked.\n`;
  const files = [
    [p('SKILL.md'), skill],
    [p('references/details.md'), `# Details for ${name}\n\nLonger instructions, examples and lessons go here so SKILL.md stays short. One line per lesson; mark with a star the ones a test checks.\n`],
    [plugin ? 'tests/skill.test.mjs' : p('tests/skill.test.mjs'), `// Checks the skill files keep the shape every agent needs. Run: node --test tests/*.test.mjs\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nconst ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');\nconst skill = readFileSync(path.join(ROOT, ${JSON.stringify(plugin ? `skills/${name}/SKILL.md` : 'SKILL.md')}), 'utf8');\n\ntest('front matter has a kebab-case name and a description with triggers', () => {\n  const fm = /^---\\n([\\s\\S]*?)\\n---/.exec(skill)?.[1] ?? '';\n  assert.match(fm, /^name: ${name}$/m);\n  assert.match(fm, /^description: .*Use (for|when)/m);\n});\n\ntest('no placeholders or em dashes left', () => {\n  assert.doesNotMatch(skill, /\\bTODO\\b|\\{\\{[A-Z_]+\\}\\}|\\u2014/);\n});\n`],
  ];
  if (plugin) {
    const manifest = { name, version: '0.1.0', description, author: { name: author }, ...(repo ? { repository: repo } : {}), license: 'MIT', keywords: [] };
    files.push(
      ['.claude-plugin/plugin.json', json(manifest)],
      ['.claude-plugin/marketplace.json', json({ name, owner: { name: author }, plugins: [{ name, source: './', description }] })],
      ['.cursor-plugin/plugin.json', json({ ...manifest, displayName: name })],
      ['README.md', readme({ name, description, repo })],
      ['LICENSE', `MIT License\n\nCopyright (c) ${new Date().getFullYear()} ${author}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`],
    );
  }
  return files;
}

function readme({ name, description, repo }) {
  const slug = repo ? repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : '<owner>/<repo>';
  return `# ${name}\n\n${description}\n\n## Install\n\n- **Claude Code:** \`/plugin marketplace add ${slug}\`, then \`/plugin install ${name}@${name}\`.\n- **Codex, Cursor and other agents that read \`~/.agents/skills\`:** \`npx skills add ${slug}\` (skills.sh), or copy \`skills/${name}\` to \`~/.agents/skills/${name}\`.\n- **Cursor plugin:** the \`.cursor-plugin/plugin.json\` manifest is ready for the Cursor marketplace.\n\n## Publishing checklist\n\n- skills.sh: listed from installs of \`npx skills add ${slug}\`; nothing to submit.\n- ClawHub (OpenClaw): \`clawhub publish skills/${name}\` after \`clawhub login\`.\n- Hermes: add the repo as a tap; pushing to the default branch updates it.\n- Claude Code marketplace: this repo is the marketplace (\`.claude-plugin/marketplace.json\`); pushing a new \`version\` updates users.\n- Cursor marketplace and the Anthropic plugin directory: a one-time submission form for the first listing, then updates come from git.\n- Awesome lists: open one pull request per list, following its own format.\n\nBump \`version\` in both plugin.json files on every release and add a line to "What changed".\n\n## What changed in 0.1.0\n\n- First release.\n\n## Tests\n\n\`node --test tests/*.test.mjs\`\n`;
}

export function create(dir, opts) {
  const written = [];
  const skipped = [];
  for (const [rel, text] of plan(opts)) {
    const full = path.join(dir, rel);
    if (existsSync(full)) { skipped.push(rel); continue; }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    written.push(rel);
  }
  return { dir: path.resolve(dir), written, skipped };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--plugin' || a === '--help' || a === '-h') out[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
      i++;
    }
    else out._.push(a);
  }
  return out;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`✗ ${e.message}`); return 1; }
  const [cmd, dir] = args._;
  if (args.help || args.h || !cmd) { console.log(HELP); return cmd || args.help || args.h ? 0 : 1; }
  if (!dir) { console.error('Say which folder. ' + HELP); return 1; }
  try {
    if (cmd === 'create') {
      const r = create(dir, { name: args.name, description: args.description, plugin: !!args.plugin, author: args.author, repo: args.repo });
      if (args.json) console.log(JSON.stringify(r));
      else {
        for (const f of r.written) console.log(`✓ wrote ${f}`);
        for (const f of r.skipped) console.log(`- kept your ${f} (already there)`);
      }
      return 0;
    }
    if (cmd === 'check') {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
      const results = checkDir(dir);
      const bad = results.filter((r) => r.problems.length);
      if (args.json) console.log(JSON.stringify({ ok: !bad.length && results.length > 0, results }));
      else if (!results.length) console.log('✗ no SKILL.md found');
      else for (const r of results) console.log(r.problems.length ? `✗ ${r.file}\n  - ${r.problems.join('\n  - ')}` : `✓ ${r.file}`);
      return bad.length || !results.length ? 1 : 0;
    }
    console.error(`Unknown command "${cmd}". ${HELP}`);
    return 1;
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
