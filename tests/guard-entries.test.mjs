// The Codex and Cursor hook files as real processes: what they print, and their exit codes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { denyOutput, REASON } from '../scripts/guard-secrets.mjs';
import { guardCode, OPEN_SHELL_REASON } from '../scripts/agents/guard-input.mjs';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).replace(/\\/g, '/');
const CODEX = path.join(ROOT, 'scripts', 'guard-codex.mjs');
const CURSOR = path.join(ROOT, 'scripts', 'guard-cursor.mjs');
const SECRETS = path.join(ROOT, 'scripts', 'guard-secrets.mjs');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ship-gentries-'));
const HOME_DIR = path.join(TMP, 'home');
mkdirSync(HOME_DIR);
after(() => rmSync(TMP, { recursive: true, force: true }));

const ENV = { ...process.env, SHIPYARD_HOME: HOME_DIR, SHIPYARD_AGENTS_HOME: path.join(TMP, 'agents'), CODEX_HOME: path.join(TMP, 'codex') };
delete ENV.CLAUDE_PLUGIN_ROOT;
delete ENV.CURSOR_PROJECT_DIR;
delete ENV.CLAUDE_PROJECT_DIR;

const run = (script, stdin, args = []) =>
  spawnSync(process.execPath, [script, ...args], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: ENV,
    timeout: 15_000,
  });

// ---------- Codex ----------

test('guard-codex: deny prints the documented JSON and exits 0', () => {
  const r = run(CODEX, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat ~/.shipyard/secrets.env' }, cwd: '/w', turn_id: 't' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${denyOutput(REASON)}\n`);
  assert.equal(r.stderr, '');
});

test('guard-codex: allow prints nothing, garbage fails open', () => {
  for (const input of [
    { tool_name: 'exec_command', tool_input: { cmd: 'npm test' }, cwd: '/w' },
    { tool_name: 'update_plan', tool_input: { plan: [] }, cwd: '/w' },
    'not json',
    '',
    '{"tool_name":',
  ]) {
    const r = run(CODEX, input);
    assert.equal(r.status, 0, JSON.stringify(input));
    assert.equal(r.stdout, '', JSON.stringify(input));
  }
});

test('guard-codex: an open shell is denied with its own reason', () => {
  const r = run(CODEX, { tool_name: 'exec_command', tool_input: { cmd: 'bash', tty: true }, cwd: '/w' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, OPEN_SHELL_REASON);
});

// ---------- Cursor ----------

const cursorBase = { cursor_version: '2.0.0', workspace_roots: ['/w'], conversation_id: 'c', generation_id: 'g' };
const CURSOR_DENY = {
  beforeReadFile: { ...cursorBase, hook_event_name: 'beforeReadFile', file_path: '/w/.env.local', content: 'SECRET_VALUE=abc123' },
  beforeShellExecution: { ...cursorBase, hook_event_name: 'beforeShellExecution', command: 'cat .env.local', cwd: '/w' },
  beforeMCPExecution: { ...cursorBase, hook_event_name: 'beforeMCPExecution', mcp_server_name: 'fs', tool_name: 'read_file', tool_input: '{"path":"/w/.env"}' },
  preToolUse: { ...cursorBase, hook_event_name: 'preToolUse', tool_name: 'Read', tool_input: { target_file: '/w/.env.production' } },
};
const CURSOR_ALLOW = {
  beforeReadFile: { ...cursorBase, hook_event_name: 'beforeReadFile', file_path: '/w/src/page.tsx', content: 'export default 1' },
  beforeShellExecution: { ...cursorBase, hook_event_name: 'beforeShellExecution', command: 'npm test', cwd: '/w' },
  beforeMCPExecution: { ...cursorBase, hook_event_name: 'beforeMCPExecution', mcp_server_name: 'fs', tool_name: 'read_file', tool_input: '{"path":"/w/a.md"}' },
  preToolUse: { ...cursorBase, hook_event_name: 'preToolUse', tool_name: 'Grep', tool_input: { pattern: 'x', target_directory: '/w/src' } },
};

test('guard-cursor: a deny is flat JSON, the reason on stderr, and exit 2, for every event', () => {
  for (const [event, input] of Object.entries(CURSOR_DENY)) {
    const r = run(CURSOR, input);
    assert.equal(r.status, 2, event);
    assert.deepEqual(JSON.parse(r.stdout), { permission: 'deny', user_message: REASON, agent_message: REASON }, event);
    assert.equal(r.stderr, `${REASON}\n`, event);
  }
});

test('guard-cursor: an explicit allow only for file reads, nothing for the rest', () => {
  for (const [event, input] of Object.entries(CURSOR_ALLOW)) {
    const r = run(CURSOR, input);
    assert.equal(r.status, 0, event);
    assert.equal(r.stdout, event === 'beforeReadFile' ? '{"permission":"allow"}\n' : '', event);
    assert.equal(r.stderr, '', event);
  }
  for (const input of [{ ...cursorBase, hook_event_name: 'afterFileEdit', file_path: '/w/.env' }, { hook_event_name: 'stop' }, 'garbage', '']) {
    const r = run(CURSOR, input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('guard-cursor: attachments to a read are checked too', () => {
  const r = run(CURSOR, { ...CURSOR_ALLOW.beforeReadFile, attachments: [{ type: 'file', file_path: '/w/.env' }] });
  assert.equal(r.status, 2);
});

test('guard-cursor: a cut-off read body naming the keys file is still denied', () => {
  const full = JSON.stringify({ ...cursorBase, hook_event_name: 'beforeReadFile', file_path: path.join(HOME_DIR, 'secrets.env'), content: 'SECRET_VALUE=' + 'x'.repeat(5000) });
  const r = run(CURSOR, full.slice(0, 2000));
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).permission, 'deny');
  const ok = JSON.stringify({ ...cursorBase, hook_event_name: 'beforeReadFile', file_path: '/w/src/a.ts', content: 'y'.repeat(5000) });
  const r2 = run(CURSOR, ok.slice(0, 2000));
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '{"permission":"allow"}\n');
  // A cut-off shell event is not a read: nothing is printed.
  const r3 = run(CURSOR, JSON.stringify(CURSOR_ALLOW.beforeShellExecution).slice(0, 40));
  assert.equal(r3.stdout, '');
});

test('guard-cursor: the file content never reaches the output', () => {
  for (const input of [CURSOR_DENY.beforeReadFile, { ...CURSOR_ALLOW.beforeReadFile, content: 'SECRET_VALUE=abc123' }]) {
    const r = run(CURSOR, input);
    assert.ok(!r.stdout.includes('abc123') && !r.stderr.includes('abc123'));
    assert.ok(!r.stdout.includes('SECRET_VALUE') && !r.stderr.includes('SECRET_VALUE'));
  }
});

// ---------- the guard check through both entries ----------

test('the guard-check file is denied with a code through both entries', () => {
  const nonce = 'aaaabbbbccccdddd';
  const file = path.join(os.tmpdir(), `shipyard-guard-check-${nonce}`, `.env.shipyard-guard-check-${nonce}`).replace(/\\/g, '/');
  const codex = run(CODEX, { tool_name: 'exec_command', tool_input: { cmd: `cat "${file}"` }, cwd: '/w' });
  assert.match(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecisionReason, new RegExp(`Guard check code \\(shell\\): ${guardCode(nonce, 'shell')}\\.$`));
  const shell = run(CURSOR, { ...cursorBase, hook_event_name: 'beforeShellExecution', command: `cat "${file}"`, cwd: '/w' });
  assert.match(JSON.parse(shell.stdout).agent_message, new RegExp(`\\(shell\\): ${guardCode(nonce, 'shell')}\\.$`));
  const read = run(CURSOR, { ...cursorBase, hook_event_name: 'beforeReadFile', file_path: file, content: 'SHIPYARD_GUARD_CHECK=not-a-key' });
  assert.match(JSON.parse(read.stdout).agent_message, new RegExp(`\\(read\\): ${guardCode(nonce, 'read')}\\.$`));
});

// ---------- importing never runs a hook ----------

test('importing an entry file runs nothing', () => {
  for (const file of [CODEX, CURSOR, path.join(ROOT, 'scripts', 'guard-check.mjs')]) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)});`], {
      input: JSON.stringify(CURSOR_DENY.beforeShellExecution),
      encoding: 'utf8',
      env: ENV,
      timeout: 15_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', file);
    assert.equal(r.stderr, '', file);
  }
});

test('guard-codex prints one decision, not a second one from guard-secrets', () => {
  const r = run(CODEX, { tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: '/w' });
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

// ---------- guard-secrets.mjs run by Cursor (an imported Claude Code plugin) ----------

test('guard-secrets.mjs given a Cursor payload: nested deny, reason on stderr, exit 2', () => {
  const r = run(SECRETS, { tool_name: 'Shell', tool_input: { command: 'cat .env.local' }, cwd: '', cursor_version: '2.0.0', hook_event_name: 'preToolUse' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, `${denyOutput(REASON)}\n`);
  assert.equal(r.stderr, `${REASON}\n`);
  const allow = run(SECRETS, { tool_name: 'Shell', tool_input: { command: 'ls' }, cwd: '', cursor_version: '2.0.0' });
  assert.equal(allow.status, 0);
  assert.equal(allow.stdout, '');
});

test('guard-secrets.mjs given a Claude Code payload: unchanged', () => {
  const r = run(SECRETS, { tool_name: 'Read', tool_input: { file_path: '/w/.env.local' }, cwd: '/w', hook_event_name: 'PreToolUse' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${denyOutput(REASON)}\n`);
  assert.equal(r.stderr, '');
});

test('--help works for both entries', () => {
  assert.match(run(CODEX, '', ['--help']).stdout, /secrets guard for Codex/);
  assert.match(run(CURSOR, '', ['--help']).stdout, /secrets guard for Cursor/);
});
