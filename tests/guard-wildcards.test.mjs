import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { evaluate } from '../scripts/guard-secrets.mjs';

// A wildcard in the keys folder's own name (~/.shipyar?, ~/.s*, ~/.[s]hipyard) expands to ~/.shipyard.
const HOME_DIR = path.join(os.homedir(), '.shipyard').replace(/\\/g, '/');
const ENV = { SHIPYARD_HOME: path.join(os.homedir(), '.shipyard') };
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, ...(cwd ? { cwd } : {}) });
const denied = (input) => evaluate(input, ENV).deny === true;

const DENY = [
  'cat ~/.shipyar?/*',
  'cat ~/.s*/*',
  'cat ~/.shipyard*/*',
  'cat ~/.[s]hipyard/*',
  'cat ~/.ship*/secrets*',
  'cat ${HOME}/.shipyar?/*',
  'cat $HOME/.s*/*',
  "head -n 50 ~/.shipyar?/*",
  "grep '' ~/.shipyar?/*",
  'base64 ~/.shipyar?/*',
  'cd ~/.shipyar? && cat *',
  'cd ~/.ship* && cat *',
  'cd ~/.s*; cat *',
  'tar cf - ~/.shipyar? | tar xOf -',
  'cp -r ~/.shipyar? /tmp/sy',
  'ln -s ~/.shipyar? sy',
  'find ~/.shipyar? -type f | xargs cat',
  "find ~ -path '*shipyard*' -type f -exec cat {} +",
  'find ~ -type f -exec cat {} +',
  'find / -name secrets.env -exec cat {} +',
  'f=secrets; cat ~/.shipyard/$f.env',
  'cat ~/.{shipyard,x}/*',
];

for (const c of DENY) {
  test(`wildcard folder name: denied: ${c}`, () => assert.ok(denied(bash(c)), c));
}

test('wildcard folder name: the same in an absolute path', () => {
  assert.ok(denied(bash(`cat ${HOME_DIR.replace('.shipyard', '.shipyar?')}/*`)));
  assert.ok(denied(bash(`cat ${HOME_DIR.replace('.shipyard', '.s*')}/*`)));
});

test('wildcard folder name: relative from the home folder', () => {
  assert.ok(denied(bash('cat .shipyar?/*', os.homedir())));
  assert.ok(denied(bash('cd .s* && cat *', os.homedir())));
});

const ALLOW = [
  'ls ~/.shipyar?',
  'ls ~/.s*',
  'cd ~/.shipyar? && ls',
  'cat ~/*.txt',
  'cat ~/Documents/*',
  'cat ~/.zshrc',
  'ls ~/.s*/',
  'find ~/projects/app -name "*.js" -exec grep -l foo {} +',
  'find . -name "*.mjs"',
  'cat ~/.shipyard-notes/*',
];

for (const c of ALLOW) {
  test(`wildcard folder name: allowed: ${c}`, () => assert.ok(!denied(bash(c)), c));
}

test('MCP: a content search with hidden files on is denied, a plain one is not', () => {
  const mcp = (input) => ({ tool_name: 'mcp__desktop-commander__start_search', tool_input: input });
  assert.ok(denied(mcp({ path: os.homedir(), pattern: 'SUPABASE', searchType: 'content', includeHidden: true })));
  assert.ok(denied(mcp({ path: '/work/app', pattern: 'SUPABASE', searchType: 'content', includeHidden: true })));
  assert.ok(!denied(mcp({ path: '/work/app', pattern: 'SUPABASE', searchType: 'content', includeHidden: false })));
  assert.ok(!denied(mcp({ path: '/work/app', pattern: '*.js', searchType: 'files', includeHidden: true })));
  assert.ok(!denied(mcp({ path: '/work/app', pattern: 'SUPABASE', searchType: 'content' })));
});
