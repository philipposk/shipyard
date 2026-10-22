// The secrets guard reading Codex and Cursor tool calls (scripts/agents/guard-input.mjs).
// Pure tests: no process is started. Every folder the guard looks at points into a temp folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, REASON } from '../scripts/guard-secrets.mjs';
import {
  agentReason,
  decide,
  extraRoots,
  guardCheckCode,
  guardCode,
  joinArgv,
  logShape,
  looksLikeCursor,
  normalizeInput,
  OPEN_SHELL_REASON,
  unwrapCommand,
} from '../scripts/agents/guard-input.mjs';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).replace(/\\/g, '/');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ship-gagents-'));
const HOME_DIR = path.join(TMP, 'shipyard-home').replace(/\\/g, '/');
const AGENTS_HOME = path.join(TMP, 'agents-home');
mkdirSync(HOME_DIR, { recursive: true });
mkdirSync(AGENTS_HOME, { recursive: true });
const ENV = { SHIPYARD_HOME: HOME_DIR, SHIPYARD_AGENTS_HOME: AGENTS_HOME, CODEX_HOME: path.join(AGENTS_HOME, '.codex') };
after(() => rmSync(TMP, { recursive: true, force: true }));

const BACKUPS_REASON_START = "Backups hold your users' personal data";
const denied = (input, env = ENV, entry = 'codex') => decide(input, env, entry).deny;
const codexBash = (command, extra = {}) => ({
  session_id: 's1',
  turn_id: 't1',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/work/app',
  hook_event_name: 'PreToolUse',
  model: 'gpt-x',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command },
  ...extra,
});

// ---------- 1. Claude Code payloads: same verdicts as evaluate() ----------

test('Claude Code shaped calls without cwd get the same verdict as evaluate()', () => {
  const fixtures = [
    { tool_name: 'Read', tool_input: { file_path: '/work/app/.env.local' } },
    { tool_name: 'Read', tool_input: { file_path: '/work/app/src/page.tsx' } },
    { tool_name: 'Edit', tool_input: { file_path: '/work/app/.env' } },
    { tool_name: 'Write', tool_input: { file_path: '/work/app/README.md', content: 'copy .env.example to .env.local' } },
    { tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env*' } },
    { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } },
    { tool_name: 'Bash', tool_input: { command: 'cat ~/.shipyard/secrets.env' } },
    { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    { tool_name: 'Bash', tool_input: { command: 'grep -rn KEY .' } },
    { tool_name: 'mcp__fs__read', tool_input: { path: '/work/app/.env.local' } },
    { tool_name: 'mcp__fs__read', tool_input: { path: '/work/app/notes.md' } },
  ];
  for (const f of fixtures) {
    const want = evaluate(f, ENV);
    const got = decide(f, ENV, 'claude-hook');
    assert.equal(got.deny, want.deny, JSON.stringify(f));
    if (want.deny) assert.equal(got.reason, want.reason, JSON.stringify(f));
  }
});

// ---------- 2 and 3. Codex shell calls ----------

test('Codex: the full Bash payload reading the keys file is denied', () => {
  const r = decide(codexBash('cat ~/.shipyard/secrets.env'), ENV, 'codex');
  assert.equal(r.deny, true);
  assert.equal(r.reason, REASON);
});

test('Codex: every shell tool name is read as a shell command', () => {
  const calls = [
    { tool_name: 'exec_command', tool_input: { cmd: 'cat .env.local' }, cwd: '/work/app' },
    { tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'cat .env.local'] }, cwd: '/work/app' },
    { tool_name: 'local_shell', tool_input: { command: ['cat', '.env.local'] }, cwd: '/work/app' },
    { tool_name: 'unified_exec', tool_input: { cmd: 'cat .env.local' }, cwd: '/work/app' },
    { tool_name: 'Shell', tool_input: { command: 'cat .env.local' }, cwd: '/work/app' },
    { tool_name: 'container.exec', tool_input: { command: ['cat', '.env.local'] }, cwd: '/work/app' },
    { tool_name: 'run_terminal_cmd', tool_input: { command: 'cat .env.local' }, cwd: '/work/app' },
  ];
  for (const c of calls) assert.equal(denied(c), true, c.tool_name);
  for (const c of calls) {
    const safe = JSON.parse(JSON.stringify(c).replaceAll('cat .env.local', 'ls').replaceAll('"cat",".env.local"', '"ls","-la"'));
    assert.equal(denied(safe), false, `${c.tool_name} safe`);
  }
});

test('Codex: text typed into a running program is read like a command', () => {
  assert.equal(denied({ tool_name: 'write_stdin', tool_input: { session_id: 1, chars: 'cat .env.local\n' }, cwd: '/work/app' }), true);
  assert.equal(denied({ tool_name: 'write_stdin', tool_input: { session_id: 1, chars: 'y\n' }, cwd: '/work/app' }), false);
  assert.equal(denied({ tool_name: 'write_stdin', tool_input: { session_id: 1 }, cwd: '/work/app' }), false);
});

// ---------- 4. apply_patch ----------

const patch = (line) => `*** Begin Patch\n${line}\n+X=1\n*** End Patch\n`;

test('Codex: apply_patch that writes a keys file is denied, deleting one is allowed', () => {
  for (const line of ['*** Add File: .env.local', '*** Update File: app/.env.local', '*** Update File: src/a.ts\n*** Move to: .env.local']) {
    assert.equal(denied({ tool_name: 'apply_patch', tool_input: { input: patch(line) }, cwd: '/work/app' }), true, line);
    assert.equal(denied({ tool_name: 'ApplyPatch', tool_input: { patch: patch(line) }, cwd: '/work/app' }), true, line);
    assert.equal(denied({ tool_name: 'apply_patch', tool_input: { command: ['apply_patch', patch(line)] }, cwd: '/work/app' }), true, line);
  }
  assert.equal(denied({ tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Delete File: .env.local\n*** End Patch' }, cwd: '/work/app' }), false);
  assert.equal(denied({ tool_name: 'apply_patch', tool_input: { input: patch('*** Update File: src/app/page.tsx') }, cwd: '/work/app' }), false);
  // A patch whose text only mentions a keys file is fine (like the Write tool's content).
  assert.equal(
    denied({ tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Add File: README.md\n+Copy .env.example to .env.local\n*** End Patch' }, cwd: '/work/app' }),
    false,
  );
});

test('Codex: apply_patch into the backups folder gets the backups reason', () => {
  const r = decide({ tool_name: 'apply_patch', tool_input: { input: patch(`*** Add File: ${HOME_DIR}/backups/app/x.json`) }, cwd: '/work/app' }, ENV, 'codex');
  assert.equal(r.deny, true);
  assert.ok(r.reason.startsWith(BACKUPS_REASON_START), r.reason);
});

test('Codex: the shell form of apply_patch behaves the same', () => {
  const heredoc = (line) => `apply_patch <<'EOF'\n${patch(line)}EOF`;
  assert.equal(denied(codexBash(heredoc('*** Add File: .env.local'))), true);
  assert.equal(denied(codexBash(heredoc('*** Update File: src/app/page.tsx'))), false);
  assert.equal(denied(codexBash(`bash -lc "apply_patch <<'EOF'\n${patch('*** Add File: .env')}EOF"`)), true);
  // The command around the patch is still checked.
  assert.equal(denied(codexBash(`${heredoc('*** Update File: src/a.ts')}\ncat .env.local`)), true);
});

// ---------- 5. wrapped and array commands ----------

test('array and wrapped commands are unwrapped before checking', () => {
  assert.equal(denied({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'cat .env.local'] }, cwd: '/w' }), true);
  const trusted = `node "${ROOT}/scripts/provision-supabase.mjs" ./app/.env.local`;
  assert.equal(denied({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', trusted] }, cwd: '/w' }), false);
  assert.equal(denied(codexBash(`bash -lc '${trusted}'`)), false);
  assert.equal(denied(codexBash(`zsh -c "bash -lc '${trusted.replaceAll('"', '\\"')}'"`)), false);
  // The wrapped form alone (no unwrapping) would be denied: that is why it is unwrapped.
  assert.equal(evaluate({ tool_name: 'Bash', tool_input: { command: `bash -lc '${trusted}'` }, cwd: '/w' }).deny, true);
});

test('words with spaces survive joining an argument list', () => {
  assert.equal(joinArgv(['cat', '/work/my app/.env.local']), "cat '/work/my app/.env.local'");
  assert.equal(denied({ tool_name: 'shell', tool_input: { command: ['cat', '/work/my app/.env.local'] }, cwd: '/w' }), true);
  assert.equal(denied({ tool_name: 'shell', tool_input: { command: ['ls', '/work/my app'] }, cwd: '/w' }), false);
  assert.equal(denied({ tool_name: 'shell', tool_input: { command: ['node', `${ROOT}/scripts/setup-status.mjs`] }, cwd: '/w' }), false);
  assert.equal(joinArgv(['echo', "it's"]), `echo 'it'\\''s'`);
});

test('unwrapCommand stops after two levels and leaves chains alone', () => {
  assert.equal(unwrapCommand("bash -lc 'ls'"), 'ls');
  assert.equal(unwrapCommand(`sh -c "bash -lc 'ls'"`), 'ls');
  assert.equal(unwrapCommand(`sh -c "sh -c \\"bash -lc 'ls'\\""`), "bash -lc 'ls'");
  assert.equal(unwrapCommand("bash -lc 'ls' && cat x"), "bash -lc 'ls' && cat x");
});

// ---------- 6. open shells and interpreters ----------

test('an open shell or interpreter is denied, a finished command is not', () => {
  for (const cmd of ['bash', 'python3', 'node', 'zsh -l', '/bin/sh', 'sudo bash', 'cd app && python', 'pwsh -NoLogo', "bash -lc 'node'"]) {
    const r = decide(codexBash(cmd), ENV, 'codex');
    assert.equal(r.deny, true, cmd);
    assert.equal(r.reason, OPEN_SHELL_REASON, cmd);
  }
  assert.equal(denied({ tool_name: 'shell', tool_input: { command: ['bash'] }, cwd: '/w' }), true);
  for (const cmd of [`node "${ROOT}/scripts/x.mjs"`, "bash -lc 'ls'", 'psql -h x', 'node --version', 'python3 -m http.server', 'bash <<EOF\nls\nEOF', 'echo hi | node', 'node -e "1"', 'cmd /c dir']) {
    assert.equal(denied(codexBash(cmd)), false, cmd);
  }
});

// ---------- 7. which folder a command runs in ----------

test('the call folder comes before the session folder', () => {
  assert.equal(denied({ tool_name: 'exec_command', tool_input: { cmd: 'cat *', workdir: HOME_DIR }, cwd: '/proj' }), true);
  assert.equal(denied({ tool_name: 'exec_command', tool_input: { cmd: 'cat *', workdir: '~/.shipyard' }, cwd: '/proj' }), true);
  assert.equal(denied({ tool_name: 'exec_command', tool_input: { cmd: 'cat *', workdir: 'sub' }, cwd: HOME_DIR }), true);
  assert.equal(denied({ tool_name: 'exec_command', tool_input: { cmd: 'cat *' }, cwd: '/proj' }), false);
  assert.equal(denied({ tool_name: 'exec_command', tool_input: { cmd: 'cat *', workdir: '/proj' }, cwd: HOME_DIR }), false);
});

test('an empty session folder falls back to the workspace, then the project folders', () => {
  const shell = (extra) => ({ tool_name: 'Shell', tool_input: { command: 'cat *' }, cwd: '', ...extra });
  assert.equal(denied(shell({ workspace_roots: [HOME_DIR] })), true);
  assert.equal(denied(shell({ workspace_roots: ['/proj'] })), false);
  assert.equal(denied(shell({}), { ...ENV, CURSOR_PROJECT_DIR: HOME_DIR }), true);
  assert.equal(denied(shell({}), { ...ENV, CLAUDE_PROJECT_DIR: HOME_DIR }), true);
  assert.equal(denied(shell({}), { ...ENV, CURSOR_PROJECT_DIR: '/proj', CLAUDE_PROJECT_DIR: HOME_DIR }), false);
  assert.equal(normalizeInput(shell({}), ENV).calls[0].cwd, undefined);
});

// ---------- 8. Cursor tool names ----------

test('Cursor: file reads under any field name', () => {
  for (const tool_name of ['Read', 'ReadFile']) {
    for (const key of ['path', 'file_path', 'target_file']) {
      assert.equal(denied({ tool_name, tool_input: { [key]: '/w/.env.local' }, cursor_version: '2.0' }, ENV, 'cursor'), true, `${tool_name} ${key}`);
      assert.equal(denied({ tool_name, tool_input: { [key]: '/w/src/a.ts' }, cursor_version: '2.0' }, ENV, 'cursor'), false, `${tool_name} ${key}`);
    }
  }
});

test('Cursor: searches of the keys folder and keys files', () => {
  assert.equal(denied({ tool_name: 'Grep', tool_input: { pattern: 'KEY', target_directory: HOME_DIR } }, ENV, 'cursor'), true);
  assert.equal(denied({ tool_name: 'Grep', tool_input: { query: 'KEY', include: '.env*' } }, ENV, 'cursor'), true);
  assert.equal(denied({ tool_name: 'Grep', tool_input: { pattern: 'KEY', target_directory: '/w/src' } }, ENV, 'cursor'), false);
  assert.equal(denied({ tool_name: 'Glob', tool_input: { glob_pattern: '**/.env*' } }, ENV, 'cursor'), true);
});

test('Cursor: MCP tools, with the input as a JSON string or plain text', () => {
  assert.equal(denied({ tool_name: 'MCP:read_file', tool_input: JSON.stringify({ path: '/w/.env.local' }) }, ENV, 'cursor'), true);
  assert.equal(denied({ tool_name: 'MCP:read_file', tool_input: JSON.stringify({ path: '/w/notes.md' }) }, ENV, 'cursor'), false);
  assert.equal(denied({ tool_name: 'MCP:run', tool_input: 'cat .env.local' }, ENV, 'cursor'), true);
  assert.equal(normalizeInput({ tool_name: 'MCP:x', tool_input: '{}' }).calls[0].tool_name, 'mcp__cursor__x');
});

test("Cursor's own events reaching the guard are read too", () => {
  assert.equal(denied({ hook_event_name: 'beforeShellExecution', command: 'cat .env.local', cwd: '/w', cursor_version: '2' }), true);
  assert.equal(denied({ hook_event_name: 'beforeShellExecution', command: 'ls', cwd: '/w', cursor_version: '2' }), false);
  assert.equal(denied({ hook_event_name: 'beforeReadFile', file_path: '/w/a.ts', attachments: [{ file_path: '/w/.env' }] }), true);
  assert.equal(denied({ hook_event_name: 'beforeMCPExecution', mcp_server_name: 'fs', tool_name: 'read', tool_input: '{"path":"/w/.env.local"}' }), true);
  assert.equal(denied({ hook_event_name: 'afterFileEdit', file_path: '/w/.env' }), false);
});

// ---------- 9. names the guard does not know ----------

test('unknown tools: read-like, search-like, and anything with a path', () => {
  assert.equal(denied({ tool_name: 'read_file', tool_input: { path: '.env' }, cwd: '/w' }), true);
  assert.equal(denied({ tool_name: 'view_image', tool_input: { path: '/w/.env.local' }, cwd: '/w' }), true);
  assert.equal(denied({ tool_name: 'grep_files', tool_input: { pattern: 'x', path: HOME_DIR }, cwd: '/w' }), true);
  assert.equal(denied({ tool_name: 'frobnicate', tool_input: { files: ['/w/a.ts', '/w/.env.production'] }, cwd: '/w' }), true);
  assert.equal(denied({ tool_name: 'update_plan', tool_input: { plan: [{ step: 'read .env.local', status: 'pending' }] }, cwd: '/w' }), false);
  assert.equal(denied({ tool_name: 'web_search', tool_input: { query: 'nextjs .env.local not loading' }, cwd: '/w' }), false);
  assert.equal(denied({ tool_name: 'read_file', tool_input: { path: '/w/src/a.ts' }, cwd: '/w' }), false);
});

test('odd input never throws and is allowed', () => {
  for (const x of [null, undefined, 'x', 1, [], {}, { tool_name: 5 }, { tool_name: 'Bash', tool_input: 7 }, { tool_name: 'Bash', tool_input: '[1,2' }]) {
    assert.equal(decide(x, ENV, 'codex').deny, false, JSON.stringify(x));
  }
});

// ---------- 10. a second Shipyard install is trusted too ----------

test('extra roots: the Codex/Cursor clone and Claude Code plugin copies are trusted', () => {
  const other = '/opt/other-shipyard';
  const cmd = `node "${other}/scripts/provision-supabase.mjs" ./app/.env.local`;
  const env = { ...ENV, SHIPYARD_HOME: path.join(TMP, 'roots-home'), SHIPYARD_AGENTS_HOME: path.join(TMP, 'roots-agents'), CODEX_HOME: path.join(TMP, 'roots-codex') };
  // Without a record of the other install, the call is denied (it names a keys file).
  assert.equal(denied(codexBash(cmd), env), true);
  assert.deepEqual(extraRoots(env), []);

  mkdirSync(env.SHIPYARD_HOME, { recursive: true });
  writeFileSync(path.join(env.SHIPYARD_HOME, 'install.json'), JSON.stringify({ schema: 1, root: other }));
  assert.deepEqual(extraRoots(env), [other]);
  assert.equal(denied(codexBash(cmd), env), false);
  // Only node scripts in that folder: anything else still needs to pass on its own.
  assert.equal(denied(codexBash(`cat ${other}/.env.local`), env), true);

  const claudeCopy = path.join(env.SHIPYARD_AGENTS_HOME, '.claude', 'plugins', 'cache', 'shipyard', 'shipyard', '0.5.4');
  const codexCopy = path.join(env.CODEX_HOME, 'plugins', 'cache', 'shipyard', 'shipyard', '0.6.0');
  mkdirSync(claudeCopy, { recursive: true });
  mkdirSync(codexCopy, { recursive: true });
  assert.deepEqual(extraRoots(env), [other, claudeCopy, codexCopy]);
  for (const root of [claudeCopy, codexCopy]) {
    const c = `node "${root.replace(/\\/g, '/')}/scripts/provision-vercel.mjs" ./app/.env.local`;
    assert.equal(denied(codexBash(c), env), false, root);
  }
});

test('extra roots: at most 8, and a broken record is ignored', () => {
  const env = { ...ENV, SHIPYARD_HOME: path.join(TMP, 'many-home'), SHIPYARD_AGENTS_HOME: path.join(TMP, 'many-agents'), CODEX_HOME: path.join(TMP, 'many-codex') };
  mkdirSync(env.SHIPYARD_HOME, { recursive: true });
  writeFileSync(path.join(env.SHIPYARD_HOME, 'install.json'), '{not json');
  for (let i = 0; i < 12; i++) mkdirSync(path.join(env.SHIPYARD_AGENTS_HOME, '.claude', 'plugins', 'cache', 'shipyard', 'shipyard', `0.${i}.0`), { recursive: true });
  assert.equal(extraRoots(env).length, 8);
});

// ---------- 11. messages ----------

test('agentReason drops the Grep tool tip outside Claude Code', () => {
  const r = evaluate({ tool_name: 'Bash', tool_input: { command: 'grep -rn KEY .' }, cwd: '/w' }).reason;
  assert.equal(agentReason(r, 'claude-hook'), r);
  for (const entry of ['codex', 'cursor']) {
    const a = agentReason(r, entry);
    assert.ok(!a.includes('Grep tool'), a);
    assert.ok(a.includes(" For a recursive search add --exclude='.env*'"), a);
  }
  assert.equal(decide(codexBash('grep -rn KEY .'), ENV, 'codex').reason, agentReason(r, 'codex'));
});

test('guard check code: shell for shell commands, read for everything else', () => {
  const nonce = '0123456789abcdef';
  const code = (kind) => createHash('sha256').update(`${nonce}:${kind}`).digest('hex').slice(0, 8);
  assert.equal(guardCode(nonce, 'shell'), code('shell'));
  const file = `/tmp/shipyard-guard-check-${nonce}/.env.shipyard-guard-check-${nonce}`;
  const shell = decide(codexBash(`cat "${file}"`), ENV, 'codex');
  assert.equal(shell.reason, `${REASON} Guard check code (shell): ${code('shell')}.`);
  const read = decide({ tool_name: 'Read', tool_input: { path: file }, cursor_version: '2' }, ENV, 'cursor');
  assert.equal(read.reason, `${REASON} Guard check code (read): ${code('read')}.`);
  assert.equal(guardCheckCode([{ tool_name: 'Bash', tool_input: { command: 'ls' } }], 'R'), 'R');
  // The plain file next to it is readable.
  assert.equal(denied(codexBash(`cat "/tmp/shipyard-guard-check-${nonce}/plain.txt"`)), false);
});

test('looksLikeCursor', () => {
  assert.equal(looksLikeCursor({ cursor_version: '2' }), true);
  assert.equal(looksLikeCursor({ workspace_roots: [] }), true);
  assert.equal(looksLikeCursor({ cwd: '/w' }), false);
  assert.equal(looksLikeCursor(null), false);
});

// ---------- 12. the debug shape log ----------

test('the debug shape log is off by default and never records values', () => {
  const logDir = path.join(TMP, 'logdir');
  mkdirSync(logDir);
  const logFile = path.join(logDir, 'shipyard-guard-shapes.log');
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    cwd: '/Users/someone/secret-project',
    tool_input: { cmd: 'echo sk_live_ABCDEF123 > /tmp/x', workdir: '/Users/someone' },
  };
  assert.equal(logShape(input, ENV, 'codex', logDir), false);
  assert.equal(existsSync(logFile), false);
  writeFileSync(path.join(HOME_DIR, 'guard-debug'), '');
  try {
    assert.equal(logShape(input, ENV, 'codex', logDir), true);
    assert.equal(logShape({ tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'ls'] } }, ENV, 'codex', logDir), true);
    const text = readFileSync(logFile, 'utf8');
    for (const value of ['sk_live', 'ABCDEF', 'someone', 'secret-project', '/tmp/x', 'echo']) assert.ok(!text.includes(value), value);
    const [first, second] = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(first), ['t', 'entry', 'event', 'tool_name', 'keys', 'tool_input_keys', 'command_type']);
    assert.equal(first.tool_name, 'exec_command');
    assert.deepEqual(first.tool_input_keys, ['cmd', 'workdir']);
    assert.equal(first.command_type, 'string');
    assert.equal(second.command_type, 'array');
  } finally {
    rmSync(path.join(HOME_DIR, 'guard-debug'), { force: true });
  }
});
