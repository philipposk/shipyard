import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, REASON, splitCommand, isSensitiveName, mentionsSecretFile } from '../scripts/guard-secrets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'guard-secrets.mjs');
const ROOT = path.resolve(here, '..');
const ENV = { CLAUDE_PLUGIN_ROOT: ROOT, SHIPYARD_HOME: path.join(os.tmpdir(), 'guard-test-home', '.shipyard') };
const HOME_DIR = ENV.SHIPYARD_HOME.replace(/\\/g, '/');

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const tool = (tool_name, tool_input) => ({ tool_name, tool_input });
const denied = (input) => evaluate(input, ENV).deny === true;

// ---------- file tools ----------

const FILE_DENY = [
  ['Read', { file_path: '/Users/me/.shipyard/secrets.env' }],
  ['Read', { file_path: 'C:\\Users\\me\\.shipyard\\secrets.env' }],
  ['Read', { file_path: '/work/app/.env' }],
  ['Read', { file_path: '/work/app/.env.local' }],
  ['Read', { file_path: '/work/app/.env.production' }],
  ['Read', { file_path: '/work/app/.env.development.local' }],
  ['Read', { file_path: '/work/app/.ENV.LOCAL' }],
  ['Edit', { file_path: '/work/app/.env.local', old_string: 'a', new_string: 'b' }],
  ['Write', { file_path: '/work/app/.env.local', content: 'KEY=1' }],
  ['MultiEdit', { file_path: '/work/app/.env', edits: [] }],
  ['NotebookEdit', { notebook_path: '/work/.env', new_source: '' }],
  ['Read', { file_path: '/Users/me/.shipyard/secrets.env.bak' }],
  ['Grep', { pattern: 'KEY', path: '/work/app/.env.local' }],
  ['Grep', { pattern: 'KEY', path: '/work/app', glob: '.env*' }],
  ['Grep', { pattern: 'KEY', path: HOME_DIR }],
  ['Grep', { pattern: 'KEY', path: `${HOME_DIR}/secrets.env` }],
  ['Glob', { pattern: '**/.env*' }],
  ['Glob', { pattern: '**/.env.local' }],
  ['Glob', { pattern: '**/secrets.env' }],
  ['Glob', { pattern: 'secrets.*', path: '/Users/me/.shipyard' }],
  ['Glob', { pattern: '*', path: '/work/app/.env.local' }],
];

for (const [name, input] of FILE_DENY) {
  test(`deny ${name} ${JSON.stringify(input).slice(0, 70)}`, () => {
    const r = evaluate(tool(name, input), ENV);
    assert.equal(r.deny, true);
    assert.equal(r.reason, REASON);
  });
}

const FILE_ALLOW = [
  ['Read', { file_path: '/work/app/.env.example' }],
  ['Read', { file_path: '/work/app/.env.sample' }],
  ['Read', { file_path: '/work/app/src/app/page.tsx' }],
  ['Read', { file_path: '/Users/me/.shipyard/profile.json' }],
  ['Read', { file_path: '/work/app/.envrc.md' }],
  ['Edit', { file_path: '/work/app/.gitignore', old_string: 'a', new_string: 'b' }],
  ['Write', { file_path: '/work/app/environment.md', content: 'x' }],
  ['Write', { file_path: '/work/app/.env.example', content: 'KEY=' }],
  ['Grep', { pattern: 'process.env', path: '/work/app/src' }],
  ['Grep', { pattern: '\\.env\\.local', path: '/work/app/src' }],
  ['Grep', { pattern: 'KEY', path: '/work/app', glob: '*.ts' }],
  ['Glob', { pattern: '**/*.tsx' }],
  ['Glob', { pattern: '**/.env.example' }],
  ['Glob', { pattern: 'src/**/*.ts', path: '/work/app' }],
];

for (const [name, input] of FILE_ALLOW) {
  test(`allow ${name} ${JSON.stringify(input).slice(0, 70)}`, () => {
    assert.equal(denied(tool(name, input)), false);
  });
}

// ---------- Bash ----------

const BASH_DENY = [
  'cat ~/.shipyard/secrets.env',
  'cat "$HOME/.shipyard/secrets.env"',
  'head -n 3 secrets.env',
  'tail -f /Users/me/.shipyard/secrets.env',
  'grep SUPABASE ~/.shipyard/secrets.env',
  'sed -n 1p secrets.env',
  'awk -F= \'{print $2}\' secrets.env',
  'less .env.local',
  'more .env',
  'type .env.local',
  'type %USERPROFILE%\\.shipyard\\secrets.env',
  'cat .env.production',
  'cat apps/web/.env.local',
  'cat < .env.local',
  'echo hi > .env.local',
  'cp .env.local /tmp/x',
  'source .env.local',
  '. ./.env.local',
  'export $(grep -v "^#" .env.local | xargs)',
  'echo $(cat .env.local)',
  'echo `cat .env.local`',
  'cd app && cat .env.local',
  'npm run build && cat .env.local',
  'node -e "require(\'fs\').readFileSync(\'.env.local\',\'utf8\')"',
  'cat .e""nv.local',
  'cat .env\\.local',
  'cat ~/.shipyard/*',
  'cat ~/.shipyard/secrets*',
  'grep -r KEY ~/.shipyard',
  'cat /proc/self/environ',
  'printenv',
  'printenv SUPABASE_ACCESS_TOKEN',
  'env',
  'env | grep KEY',
  'env -0',
  'set',
  'set | grep KEY',
  'export -p',
  'export',
  'declare -x',
  'sudo env',
  'FOO=1 printenv',
  'npx vercel env pull -',
  'npx --yes vercel@latest env pull --yes /dev/stdout',
  'vercel env pull .env.local',
  'node ./scripts/other.mjs && cat .env.local',
  'node /somewhere/else/scripts/guard-secrets.mjs .env.local',
  `node "${ROOT}/scripts/../../evil.mjs" .env.local`,
  `node "${ROOT}/scripts/x.mjs" .env.local > out.txt`,
  `node "${ROOT}/scripts/x.mjs" && cat .env.local`,
  `node --require ./evil.js "${ROOT}/scripts/x.mjs" .env.local`,
  'git add .env.local',
  'git diff .env.local',
  'ls $(cat .env.local)',
];

for (const cmd of BASH_DENY) {
  test(`deny bash: ${cmd}`, () => {
    const r = evaluate(bash(cmd), ENV);
    assert.equal(r.deny, true, `should deny: ${cmd}`);
    assert.equal(r.reason, REASON);
  });
}

const BASH_ALLOW = [
  'ls',
  'ls -la',
  'pwd',
  'git status',
  'git commit -m "add .env.example"',
  'cat .env.example',
  'cp .env.example .env.sample',
  'cat package.json',
  'npm install',
  'npm run build',
  'npm test',
  'npx next build',
  'npx --yes next dev',
  'node --test tests/',
  'node scripts/secret-scan.mjs',
  'node -e "console.log(process.env.HOME)"',
  'echo "import.meta.env.MODE"',
  'ls .envrc',
  'env FOO=1 node build.mjs',
  'env -u FOO npm test',
  'set -e',
  'set -o pipefail',
  'export FOO=bar',
  'declare -a items',
  'FOO=1 npm run build',
  'ls -la ~/.shipyard',
  'ls ~/.shipyard/*',
  'chmod 700 ~/.shipyard',
  'chmod 600 ~/.shipyard/secrets.env',
  'cat ~/.shipyard/profile.json',
  'cat .shipyard/verify.json',
  'ls .env.local',
  'ls -la .env.local && git status',
  '[ -f .env.local ]',
  'test -f ~/.shipyard/secrets.env',
  'rm .env.local',
  'git check-ignore -v .env.local',
  'git ls-files .env.local',
  'echo "a" | grep a',
  'npm run build 2>&1 | tail -20',
  `node "${ROOT}/scripts/secrets-check.mjs" --live`,
  `node "${ROOT}/scripts/secrets-init.mjs"`,
  `node "${ROOT}/scripts/provision-supabase.mjs" ./my-app/.env.local`,
  `node "${ROOT}/scripts/profile.mjs" show`,
  'npm run dev -- --env-file .env.local',
  'npx next build .env.local',
  'git push origin feature/env-docs',
  'gh pr create --title "Document .env.example"',
  'curl -s https://example.com/api/environment',
  '',
];

for (const cmd of BASH_ALLOW) {
  test(`allow bash: ${cmd || '(empty)'}`, () => {
    assert.equal(denied(bash(cmd)), false, `should allow: ${cmd}`);
  });
}

// ---------- other tools and bad input ----------

test('tools it does not watch are allowed', () => {
  assert.equal(denied(tool('WebFetch', { url: 'https://example.com/.env' })), false);
});

test('bad input fails open', () => {
  for (const input of [null, undefined, {}, 'text', 42, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: null }, { tool_name: 'Bash', tool_input: { command: 5 } }, { tool_name: 'Read', tool_input: { file_path: 7 } }]) {
    assert.equal(denied(input), false);
  }
});

// ---------- MCP tools (Desktop Commander and other servers) ----------

const DC = (name) => `mcp__Desktop_Commander__${name}`;

const MCP_DENY = [
  [DC('read_file'), { path: '~/.shipyard/secrets.env' }],
  [DC('read_file'), { path: `${HOME_DIR}/secrets.env` }],
  [DC('read_file'), { path: `${HOME_DIR}/profile.json` }], // anything inside the Shipyard folder
  [DC('read_file'), { path: HOME_DIR }],
  [DC('read_file'), { path: '/Users/me/.shipyard/secrets.env', offset: 0, length: 50 }],
  [DC('read_file'), { path: 'C:\\Users\\me\\.shipyard\\secrets.env' }],
  [DC('read_file'), { path: '/work/app/.env.local' }],
  [DC('read_file'), { path: '/work/My Docs/app/.env' }],
  [DC('read_file'), { path: 'file:///work/app/.env.production' }],
  [DC('read_multiple_files'), { paths: ['/work/app/README.md', '/work/app/.env.local'] }],
  [DC('write_file'), { path: '/work/app/.env.local', content: 'KEY=1' }],
  [DC('edit_block'), { file_path: '/work/app/.env', old_string: 'a', new_string: 'b' }],
  [DC('start_process'), { command: 'cat .env.local', timeout_ms: 5000 }],
  [DC('start_process'), { command: 'cat ~/.shipyard/secrets.env' }],
  [DC('start_process'), { command: 'grep KEY $HOME/.shipyard/secrets.env' }],
  [DC('start_process'), { command: 'cat .e*' }],
  [DC('start_process'), { command: 'env' }],
  [DC('start_process'), { command: 'printenv' }],
  [DC('start_process'), { command: 'ls && cat .env.local' }],
  [DC('interact_with_process'), { pid: 4, input: 'cat .env.local' }],
  [DC('list_directory'), { path: '~/.shipyard' }],
  [DC('list_directory'), { path: HOME_DIR }],
  [DC('start_search'), { path: '/work/app', pattern: '**/.env*' }],
  ['mcp__fs__read', { options: { files: [{ src: '/work/app/.env.local' }] } }], // nested objects and arrays
  ['mcp__fs__read', { uri: 'file:///Users/me/.shipyard/secrets.env' }],
  ['mcp__fs__run', { command: 'cat', args: ['-n', '/work/app/.env.local'] }],
  ['mcp__fs__run', { command: 'sh', args: ['-c', 'cat .env.production'] }],
  ['mcp__fs__run', { command: 'env', args: [] }],
  ['mcp__fs__copy', { source: '/work/app/README.md', destination: '/work/.env.local' }],
  ['mcp__fs__move', { '/work/app/.env': '/tmp/x' }], // a path used as a name
  ['mcp__plugin_x_y__open', { target: 'secrets.env' }],
];

for (const [name, input] of MCP_DENY) {
  test(`deny mcp ${name} ${JSON.stringify(input).slice(0, 70)}`, () => {
    const r = evaluate(tool(name, input), ENV);
    assert.equal(r.deny, true);
    assert.equal(r.reason, REASON);
  });
}

const MCP_ALLOW = [
  [DC('read_file'), { path: '/work/app/README.md' }],
  [DC('read_file'), { path: 'README.md' }],
  [DC('read_file'), { path: '/Users/me/My Docs/notes.txt' }],
  [DC('read_file'), { path: '/work/app/.env.example' }],
  [DC('read_multiple_files'), { paths: ['/work/app/README.md', '/work/app/src/page.tsx'] }],
  [DC('list_directory'), { path: '/work/app' }],
  [DC('start_process'), { command: 'ls -la', timeout_ms: 5000 }],
  [DC('start_process'), { command: 'npm test' }],
  [DC('start_process'), { command: 'git status && git diff' }],
  [DC('start_process'), { command: 'git check-ignore .env.local' }], // same rule as the Bash tool: only the name is touched
  [DC('start_process'), { command: `node ${ROOT}/scripts/secrets-check.mjs --live` }], // Shipyard's own scripts handle keys themselves
  [DC('start_process'), { command: 'cat src/app/page.tsx', cwd: '/work/app' }],
  [DC('write_file'), { path: '/work/app/README.md', content: 'Copy .env.example to .env.local, then edit secrets.env.' }], // file text is not a path
  [DC('edit_block'), { file_path: '/work/app/README.md', old_string: 'open .env.local', new_string: 'open .env.local now' }],
  [DC('start_search'), { path: '/work/app/src', pattern: 'process.env' }],
  ['mcp__fs__run', { command: 'cat', args: ['README.md'] }],
  ['mcp__x__tool', { mode: 'set', action: 'env', flag: 'export' }], // plain words that are only commands when they run as one
  ['mcp__slack__post', { channel: 'general', message: 'remember to keep .env.local private' }],
  ['mcp__x__tool', {}],
  ['mcp__x__tool', { n: 5, on: true, none: null, list: [1, 2, { a: 3 }] }],
];

for (const [name, input] of MCP_ALLOW) {
  test(`allow mcp ${name} ${JSON.stringify(input).slice(0, 70)}`, () => {
    assert.equal(denied(tool(name, input)), false);
  });
}

test('mcp: a deeply nested path is still found, and a huge input stays fast', () => {
  let deep = { path: '/work/app/.env.local' };
  for (let i = 0; i < 10; i++) deep = { wrap: [deep] };
  assert.equal(denied(tool('mcp__x__tool', deep)), true);
  const big = { items: Array.from({ length: 5000 }, (_, i) => `/work/app/file-${i}.txt`) };
  const t = Date.now();
  assert.equal(denied(tool('mcp__x__tool', big)), false);
  assert.ok(Date.now() - t < 2000);
});

test('mcp: a tool name that only contains mcp__ is not an MCP tool', () => {
  assert.equal(denied(tool('NotMcp__x', { path: '/work/app/.env.local' })), false);
});

test('mcp: the guard\'s own errors fail open', () => {
  const broken = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  assert.equal(denied(tool('mcp__x__tool', broken)), false);
});

test('hook process: an MCP tool reading the keys file is denied with the documented JSON', () => {
  const r = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: DC('read_file'), tool_input: { path: '~/.shipyard/secrets.env' } }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, REASON);
});

test('hook process: an MCP tool reading README.md prints nothing', () => {
  const r = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: DC('read_file'), tool_input: { path: 'README.md' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// ---------- helpers ----------

test('isSensitiveName', () => {
  for (const n of ['.env', '.env.local', '.env.production', '.env.test.local', 'secrets.env', 'SECRETS.ENV']) assert.equal(isSensitiveName(n), true, n);
  for (const n of ['.env.example', '.env.sample', '.env.template', '.envrc', 'env.ts', 'page.tsx', 'secrets.md']) assert.equal(isSensitiveName(n), false, n);
});

test('mentionsSecretFile ignores look-alikes', () => {
  assert.equal(mentionsSecretFile('process.env.HOME'), false);
  assert.equal(mentionsSecretFile('foo.env'), false);
  assert.equal(mentionsSecretFile('.environment'), false);
  assert.equal(mentionsSecretFile('x .env.local y'), true);
  assert.equal(mentionsSecretFile('"./.env"'), true);
});

test('splitCommand splits chains, pipes and substitutions', () => {
  assert.deepEqual(splitCommand('a b && c | d; e').map((s) => s.words), [['a', 'b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(splitCommand('echo "a b" \'c d\'')[0].words, ['echo', 'a b', 'c d']);
  const subst = splitCommand('ls $(cat x)');
  assert.equal(subst[0].unsafe, true);
  assert.deepEqual(subst[1].words, ['cat', 'x']);
  assert.equal(splitCommand('ls > out')[0].unsafe, true);
  assert.deepEqual(splitCommand('npm test 2>&1')[0].words.slice(0, 2), ['npm', 'test']);
});

// ---------- the real hook process ----------

function runHook(stdin, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, ...env },
    timeout: 15_000,
  });
}

test('hook process: deny prints the documented JSON and exits 0', () => {
  const r = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat ~/.shipyard/secrets.env' } }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, REASON);
});

test('hook process: allow prints nothing and exits 0', () => {
  const r = runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/work/app/src/page.tsx' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook process: garbage or empty input fails open', () => {
  for (const input of ['not json', '', '{"tool_name":']) {
    const r = runHook(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('hook process: --help works', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /secrets guard/i);
});

test('hook process is fast', () => {
  const t = Date.now();
  runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.ok(Date.now() - t < 2000);
});

// ---------- folder the shell is in, wildcards, recursive searches, token printers ----------

const bashIn = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const APP = '/work/app';

const CWD_DENY = [
  ['cat *', HOME_DIR],
  ['cat s*', HOME_DIR],
  ['cat secrets.env', HOME_DIR],
  ['head -n 2 profile.json', HOME_DIR],
  ['grep KEY .', HOME_DIR],
  ['cat *', `${HOME_DIR}/`],
  ['cd ~/.shipyard && cat s*', APP],
  [`cd ${HOME_DIR} && cat s*`, APP],
  ['cd .shipyard && cat *', '/Users/me'],
  ['cd "$HOME/.shipyard" && cat *', APP],
  ['pushd ~/.shipyard && cat *', APP],
  ['cd .. && cd .shipyard && cat *', `${HOME_DIR}/sub`],
];
for (const [cmd, cwd] of CWD_DENY) {
  test(`deny bash in ${cwd}: ${cmd}`, () => {
    assert.equal(evaluate(bashIn(cmd, cwd), ENV).deny, true);
  });
}

const CWD_ALLOW = [
  ['ls', HOME_DIR],
  ['ls -la', HOME_DIR],
  ['pwd', HOME_DIR],
  ['cd /work/app', HOME_DIR],
  ['cd .. && cat package.json', HOME_DIR],
  ['cd /work/app && cat *', HOME_DIR],
  ['cat *', APP],
  ['cat package.json', APP],
  ['cd ~/.shipyard', APP],
  ['cd ~/.shipyard && ls', APP],
  [`node "${ROOT}/scripts/profile.mjs" show`, HOME_DIR],
];
for (const [cmd, cwd] of CWD_ALLOW) {
  test(`allow bash in ${cwd}: ${cmd}`, () => {
    assert.equal(evaluate(bashIn(cmd, cwd), ENV).deny, false);
  });
}

test('Grep and Glob with no path are denied while the shell sits in the keys folder', () => {
  assert.equal(evaluate({ tool_name: 'Grep', tool_input: { pattern: 'KEY' }, cwd: HOME_DIR }, ENV).deny, true);
  assert.equal(evaluate({ tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '.' }, cwd: HOME_DIR }, ENV).deny, true);
  assert.equal(evaluate({ tool_name: 'Glob', tool_input: { pattern: '*' }, cwd: HOME_DIR }, ENV).deny, true);
  assert.equal(evaluate({ tool_name: 'Grep', tool_input: { pattern: 'KEY' }, cwd: APP }, ENV).deny, false);
  assert.equal(evaluate({ tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '/work/app/src' }, cwd: HOME_DIR }, ENV).deny, false);
  assert.equal(evaluate({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, cwd: APP }, ENV).deny, false);
});

const WILDCARD_DENY = ['cat .e*', 'cat .en[v].local', 'cat .*', 'cat .env.l*', 'cat .{env,x}.local', 'cat .e?v.local', 'head .env.*', 'cat ~/.shipyard/s*', 'cat ./.e*', 'tail -n 5 apps/web/.en*'];
for (const cmd of WILDCARD_DENY) {
  test(`deny wildcard: ${cmd}`, () => {
    assert.equal(evaluate(bashIn(cmd, APP), ENV).deny, true);
  });
}
const WILDCARD_ALLOW = ['cat *', 'cat *.ts', 'cat src/*.tsx', 'ls .e*', 'ls -a .*', 'rm .env.l*', 'cat .gitignore', 'cat .g*', 'grep foo "src/**/*.ts"', 'echo "${HOME}/x"', '[ -f package.json ]', 'cat package.json README*'];
for (const cmd of WILDCARD_ALLOW) {
  test(`allow wildcard: ${cmd}`, () => {
    assert.equal(evaluate(bashIn(cmd, APP), ENV).deny, false, cmd);
  });
}

const SEARCH_DENY = [
  'grep -rn SUPABASE_SERVICE_ROLE_KEY .',
  'grep -r KEY',
  'grep -R KEY src',
  'grep --recursive KEY .',
  'grep -nri key .',
  'grep -d recurse KEY .',
  'egrep -r "KEY|TOKEN" .',
  'grep -r KEY . --exclude=*.md',
  'grep -r KEY . --exclude-dir=node_modules',
  'rg --hidden KEY',
  'rg -uu KEY',
  'rg -u KEY',
  'rg -nuuu KEY',
  'rg --no-ignore KEY',
  'rg --no-ignore-vcs KEY',
  'rg --unrestricted KEY',
  'rg --hidden KEY -g "!node_modules"',
  'ag -u KEY',
  'ag --hidden KEY',
  'git grep --no-exclude-standard KEY',
];
for (const cmd of SEARCH_DENY) {
  test(`deny recursive search: ${cmd}`, () => {
    const r = evaluate(bashIn(cmd, APP), ENV);
    assert.equal(r.deny, true, cmd);
    assert.ok(r.reason.startsWith(REASON));
  });
}
const SEARCH_ALLOW = [
  'grep -rn KEY . --exclude=".env*"',
  "grep -rn KEY src --exclude='.env*'",
  'grep -rn KEY . --exclude ".env*" --exclude-dir=node_modules',
  'grep -rn KEY --exclude=.env* .',
  'rg KEY',
  'rg -n KEY src',
  'rg -i "foo" -g "*.ts"',
  "rg --hidden KEY -g '!.env*'",
  "rg -uu KEY --glob '!.env*'",
  'rg --hidden KEY --glob=!.env*',
  'ag KEY',
  'ag KEY src',
  'grep -n KEY package.json',
  'grep -ie KEY package.json',
  'grep -e rrr package.json',
  'git grep KEY',
  'git grep -n KEY -- src',
];
for (const cmd of SEARCH_ALLOW) {
  test(`allow search: ${cmd}`, () => {
    assert.equal(evaluate(bashIn(cmd, APP), ENV).deny, false, cmd);
  });
}

const TOKEN_DENY = [
  'npm run env',
  'npm run --silent env',
  'npm run-script env',
  'npm run env | grep KEY',
  'gh auth token',
  'gh auth token --hostname github.com',
  'gh auth status --show-token',
  'gh auth status -t',
  'vercel env pull',
  'vercel env pull --yes',
  'vercel env pull --environment production',
  'npx vercel@latest env pull',
  'npx --yes vercel@latest env pull --environment=production --yes',
];
for (const cmd of TOKEN_DENY) {
  test(`deny token printer: ${cmd}`, () => {
    assert.equal(evaluate(bashIn(cmd, APP), ENV).deny, true, cmd);
  });
}
const TOKEN_ALLOW = ['npm run build', 'npm run dev -- --port 3001', 'npm run envcheck', 'gh auth status', 'gh auth login --web', 'gh pr list', 'gh auth setup-git', 'vercel env ls', 'vercel env add FOO production', 'vercel pull'];
for (const cmd of TOKEN_ALLOW) {
  test(`allow token-related: ${cmd}`, () => {
    assert.equal(evaluate(bashIn(cmd, APP), ENV).deny, false, cmd);
  });
}

test('npm run env is not trusted even though other npm run commands are', () => {
  assert.equal(denied(bash('npm run env')), true);
  assert.equal(denied(bash('npm run lint')), false);
});

test('hook process: the cwd field in the input is read', () => {
  const r = runHook(JSON.stringify({ tool_name: 'Bash', cwd: HOME_DIR, tool_input: { command: 'cat *' } }), { SHIPYARD_HOME: HOME_DIR });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('hook process: recursive-search denial tells the agent what to do instead', () => {
  const r = runHook(JSON.stringify({ tool_name: 'Bash', cwd: APP, tool_input: { command: 'grep -rn KEY .' } }));
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith(REASON));
  assert.match(reason, /--exclude/);
});

// ---------- the hook must still work when the plugin folder is behind a symlink ----------

test('hook process: still denies when started through a symlinked folder', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guard-link-'));
  try {
    const link = path.join(dir, 'plugin-link');
    symlinkSync(path.join(ROOT, 'scripts'), link, 'dir');
    const r = spawnSync(process.execPath, [path.join(link, 'guard-secrets.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat .env.local' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: link },
      timeout: 15_000,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook process: a symlink to the script file itself also works', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guard-link-'));
  try {
    mkdirSync(path.join(dir, 'x'));
    // Copy so relative imports are not needed (the guard only imports built-ins), then link to the copy.
    copyFileSync(SCRIPT, path.join(dir, 'x', 'guard-secrets.mjs'));
    symlinkSync(path.join(dir, 'x'), path.join(dir, 'y'), 'dir');
    const r = spawnSync(process.execPath, [path.join(dir, 'y', 'guard-secrets.mjs')], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/work/app/.env.local' } }),
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the video folder inside an app (video-setup.mjs puts the engine in <app>/video/) ----------

test('video folder: key files in <app>/video/ are blocked, the example and the video scripts are not', () => {
  const VIDEO_DENY = [
    tool('Read', { file_path: '/work/app/video/.env' }),
    tool('Read', { file_path: '/work/app/video/.env.local' }),
    tool('Write', { file_path: '/work/app/video/.env', content: 'OPENAI_API_KEY=x' }),
    tool('Edit', { file_path: '/work/app/video/.env.production', old_string: 'a', new_string: 'b' }),
    tool('Grep', { pattern: 'KEY', path: '/work/app/video', glob: '.env*' }),
    tool('Glob', { pattern: 'video/.env*', path: '/work/app' }),
    bash('cat video/.env'),
    bash('cat ./video/.env.local'),
    bash('grep OPENAI_API_KEY video/.env'),
    bash('cd video && cat .env'),
    bash('cp video/.env /tmp/x'),
  ];
  for (const input of VIDEO_DENY) assert.equal(denied(input), true, `should deny: ${JSON.stringify(input)}`);
  const VIDEO_ALLOW = [
    tool('Read', { file_path: '/work/app/video/.env.example' }),
    tool('Read', { file_path: '/work/app/video/src/scripts/launch.json' }),
    tool('Read', { file_path: '/work/app/video/README.md' }),
    tool('Write', { file_path: '/work/app/video/src/scripts/launch.json', content: '[]' }),
    bash('ls video'),
    bash('cat video/package.json'),
    bash(`node "${ROOT}/scripts/video-setup.mjs" ./my-app`),
    bash(`node "${ROOT}/scripts/video-voice.mjs" ./my-app --tag launch`),
    bash(`node "${ROOT}/scripts/video-render.mjs" ./my-app launch:light`),
    bash(`node "${ROOT}/scripts/video-publish.mjs" ./my-app launch-light-nomusic`),
  ];
  for (const input of VIDEO_ALLOW) assert.equal(denied(input), false, `should allow: ${JSON.stringify(input)}`);
});

// ---------- backups (users' personal data): never read in the chat ----------

test('backups: reading, searching, copying or printing the files is blocked everywhere', () => {
  const B = `${HOME_DIR}/backups/my-app/2026-10-16T14-03-09Z`;
  const DENY = [
    tool('Read', { file_path: `${B}/profiles.json` }),
    tool('Read', { file_path: `${B}/manifest.json` }),
    tool('Read', { file_path: '~/.shipyard/backups/my-app/2026-10-16T14-03-09Z/profiles.json' }),
    tool('Read', { file_path: `${HOME_DIR}/backups/../backups/my-app/x/profiles.json` }),
    tool('Edit', { file_path: `${B}/profiles.json`, old_string: 'a', new_string: 'b' }),
    tool('Grep', { pattern: 'email', path: B }),
    tool('Grep', { pattern: 'email', path: `${HOME_DIR}/backups` }),
    tool('Grep', { pattern: 'email', path: '/Users/me', glob: '**/.shipyard/backups/**' }),
    tool('Glob', { pattern: '**/*.json', path: B }),
    tool('Glob', { pattern: `${HOME_DIR}/backups/**/*.json` }),
    { ...tool('Glob', { pattern: '*.json', path: 'backups/my-app' }), cwd: HOME_DIR },
    bash(`cat ${B}/profiles.json`),
    bash('cat ~/.shipyard/backups/my-app/2026-10-16T14-03-09Z/profiles.json'),
    bash('cat "$HOME/.shipyard/backups/my-app/x/profiles.json"'),
    bash('cat ${HOME}/.shipyard/backups/my-app/x/profiles.json'),
    bash('head -c 500 ~/.shipyard/backups/my-app/x/profiles.json'),
    bash('tail ~/.shipyard/backups/my-app/x/profiles.json'),
    bash('less ~/.shipyard/backups/my-app/x/profiles.json'),
    bash('grep jane ~/.shipyard/backups/my-app/x/profiles.json'),
    bash('grep -r jane ~/.shipyard/backups'),
    bash('rg jane ~/.shipyard/backups'),
    bash("jq '.[0]' ~/.shipyard/backups/my-app/x/profiles.json"),
    bash('jq . < ~/.shipyard/backups/my-app/x/profiles.json'),
    bash(`node -e "console.log(require('fs').readFileSync('${B}/profiles.json','utf8'))"`),
    bash(`node -p "require('${B}/profiles.json')[0]"`),
    bash(`python3 -c "print(open('${B}/profiles.json').read())"`),
    bash(`cp ${B}/profiles.json /tmp/leak.json`),
    bash(`tar czf /tmp/b.tgz ${HOME_DIR}/backups`),
    bash(`cat ${HOME_DIR}/backups/my-app/*/profiles.json`),
    bash(`cd ${B} && cat profiles.json`),
    bash(`cd ${HOME_DIR}/backups && cat my-app/*/profiles.json`),
    bash(`bash -c "cat ~/.shipyard/backups/my-app/x/profiles.json"`),
    bash(`echo $(cat ~/.shipyard/backups/my-app/x/profiles.json)`),
    bash(`git -C ~/.shipyard/backups/my-app log`),
    bash(`find ~/.shipyard/backups -name '*.json' -exec cat {} +`),
    bash(`node -e "x" ~/.shipyard/backups/my-app/x/profiles.json`),
    tool('mcp__fs__read_file', { path: `${B}/profiles.json` }),
  ];
  for (const input of DENY) {
    const r = evaluate(input, ENV);
    assert.equal(r.deny, true, `should deny: ${JSON.stringify(input)}`);
  }
  const reasons = [evaluate(tool('Read', { file_path: `${B}/profiles.json` }), ENV), evaluate(bash('cat ~/.shipyard/backups/a/b/c.json'), ENV)].map((r) => r.reason);
  for (const reason of reasons) assert.match(reason, /personal data/);
});

test('backups: listing folder names, sizes, deleting old ones, and a script that reads them without printing are fine', () => {
  const B = `${HOME_DIR}/backups/my-app/2026-10-16T14-03-09Z`;
  const ALLOW = [
    bash('ls ~/.shipyard/backups'),
    bash(`ls -la ${HOME_DIR}/backups/my-app`),
    bash(`ls ${B}`),
    bash(`du -sh ${HOME_DIR}/backups/my-app`),
    bash(`stat ${B}`),
    bash(`rm -r ${HOME_DIR}/backups/my-app/2026-01-01T00-00-00Z`),
    bash(`rm -rf ~/.shipyard/backups/my-app/2026-01-01T00-00-00Z`),
    bash(`test -d ${B} && echo yes`),
    bash(`cd ${HOME_DIR}/backups && ls`),
    bash(`node "${ROOT}/scripts/backup-export.mjs" ./my-app`),
    bash(`node "${ROOT}/scripts/ops-status.mjs" ./my-app`),
    // a restore script that Claude wrote on the student's computer, given the folder to read
    bash(`node /tmp/restore-my-app.mjs ${B}`),
    bash(`node ./restore.mjs --from ${B}`),
    // other files in the shipyard folder and files that only have the word in their name
    tool('Read', { file_path: `${HOME_DIR}/profile.json` }),
    tool('Read', { file_path: '/work/app/docs/backups.md' }),
    tool('Read', { file_path: '/work/app/backups/notes.md' }),
    tool('Grep', { pattern: 'backup', path: '/work/app/src' }),
    tool('Glob', { pattern: '**/*.md', path: '/work/app/docs' }),
    bash('cat /work/app/docs/backups.md'),
    bash('grep -n backup /work/app/src/app/page.tsx'),
  ];
  for (const input of ALLOW) assert.equal(denied(input), false, `should allow: ${JSON.stringify(input)}`);
});
