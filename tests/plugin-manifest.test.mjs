// The plugin's own wiring: hooks.json exists, parses and runs the guard; the manifests parse.
// `claude plugin validate` does not look at hooks, so a missing or broken hooks.json would otherwise go unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

test('hooks/hooks.json exists and parses', () => {
  assert.ok(existsSync(path.join(ROOT, 'hooks', 'hooks.json')));
  assert.equal(typeof read('hooks/hooks.json'), 'object');
});

test('the PreToolUse hook runs the guard from CLAUDE_PLUGIN_ROOT on every file and shell tool', () => {
  const hooks = read('hooks/hooks.json').hooks.PreToolUse;
  assert.ok(Array.isArray(hooks) && hooks.length === 2);
  const matcher = new RegExp(`^(?:${hooks[0].matcher})$`);
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'Bash', 'NotebookEdit']) {
    assert.ok(matcher.test(tool), `${tool} is not covered by the matcher`);
  }
  const [hook] = hooks[0].hooks;
  assert.equal(hook.type, 'command');
  assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard-secrets\.mjs/);
  assert.ok(existsSync(path.join(ROOT, 'scripts', 'guard-secrets.mjs')));
  assert.ok(hook.timeout > 0 && hook.timeout <= 30);
});

test('a second PreToolUse entry runs the same guard on every MCP tool', () => {
  const hooks = read('hooks/hooks.json').hooks.PreToolUse;
  const entry = hooks.find((h) => h.matcher === 'mcp__.*');
  assert.ok(entry, 'no entry with matcher mcp__.*');
  // Claude Code reads a matcher with characters like . and * as a regular expression.
  const matcher = new RegExp(entry.matcher);
  for (const tool of ['mcp__Desktop_Commander__read_file', 'mcp__plugin_x_y__tool', 'mcp__server__a']) {
    assert.ok(matcher.test(tool), `${tool} is not covered by the matcher`);
  }
  assert.ok(!matcher.test('Read') && !matcher.test('Bash'));
  const [hook] = entry.hooks;
  assert.equal(hook.type, 'command');
  assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard-secrets\.mjs/);
  assert.ok(hook.timeout > 0 && hook.timeout <= 30);
});

test('plugin.json and marketplace.json parse and agree on the name', () => {
  const plugin = read('.claude-plugin/plugin.json');
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'shipyard');
  assert.ok(market.plugins.some((p) => p.name === plugin.name));
});

test('the root .gitignore keeps the private build notes out of the published plugin', () => {
  const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const entry of ['BUILD-SPEC.md', 'node_modules/', '.DS_Store']) assert.ok(ignore.includes(entry), `${entry} should be ignored`);
});

test('the plugin has its own CI gate that runs the tests on pull requests', () => {
  const yml = readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(yml, /pull_request:/);
  assert.match(yml, /contents: read/);
  assert.match(yml, /node --test tests\/\*\.test\.mjs/);
  assert.match(yml, /node --test template\/tests\/\*\.test\.mjs/);
  assert.match(yml, /Only merge a pull request when it is green/);
});

// The maker's GitHub handle is allowed in exactly two places, on purpose: the plugin's own repository (the install
// command and the issue link need it) and the public video engine it downloads (a pinned commit of that repository).
// Anything else with the handle in it, in a shipped file, is a leak.
test('the maker\'s GitHub handle only appears as the plugin repository and the video engine repository', async () => {
  const { readdir } = await import('node:fs/promises');
  const handle = ['philip', 'posk'].join('');
  const allowed = new RegExp(`(?:github\\.com/|^|[\\s"'(])${handle}/(?:shipyard|demo-pipeline)(?![\\w-])`);
  const skipDirs = new Set(['node_modules', '.git', '.next', 'tests']);
  const hits = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) await walk(full);
      } else if (e.name !== 'BUILD-SPEC.md' && /\.(?:mjs|js|ts|tsx|json|md|yml|yaml|html|css|txt|sh|toml)$/.test(e.name)) {
        const text = readFileSync(full, 'utf8');
        text.split('\n').forEach((line, i) => {
          if (!line.toLowerCase().includes(handle)) return;
          const rest = line.replace(new RegExp(`(?:github\\.com/|[\\s"'(])${handle}/(?:shipyard|demo-pipeline)(?![\\w-])`, 'gi'), ' ');
          if (rest.toLowerCase().includes(handle)) hits.push(`${path.relative(ROOT, full)}:${i + 1}`);
          else if (!allowed.test(line)) hits.push(`${path.relative(ROOT, full)}:${i + 1}`);
        });
      }
    }
  }
  await walk(ROOT);
  assert.deepEqual(hits, []);
});
