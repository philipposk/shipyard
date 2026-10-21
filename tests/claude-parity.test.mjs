// Claude Code users must see no change from the Codex and Cursor work. These tests pin what
// Claude Code runs: the hook file, the deny JSON, and the fast path in guard-secrets.mjs that never
// loads the new adapter for Claude Code's own payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { denyOutput, evaluate, isClaudeShaped, REASON } from '../scripts/guard-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'guard-secrets.mjs');

test('hooks/hooks.json is byte for byte the 0.5.4 file', () => {
  const text = readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8').replace(/\r\n/g, '\n');
  const sha = createHash('sha256').update(text).digest('hex');
  assert.equal(
    sha,
    '404010b03b762072f4902ab6ad6d14a1cd89bd5ead985c62077a6e92b3cd6aef',
    'hooks/hooks.json changed. That changes the Claude hook and the Codex plugin trust hash: put it back.',
  );
});

test('the deny JSON and the main reason are unchanged', () => {
  assert.equal(
    denyOutput('x'),
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}',
  );
  assert.equal(REASON, 'Shipyard keeps your keys out of the chat. Use the Shipyard scripts instead (they never show the values).');
  const grep = evaluate({ tool_name: 'Bash', tool_input: { command: 'grep -rn KEY .' }, cwd: '/work/app' });
  assert.equal(grep.reason, `${REASON} For a recursive search use the Grep tool, or add --exclude='.env*' (rg: -g '!.env*').`);
});

const CWD = '/work/app';
const CLAUDE_FIXTURES = [
  { tool_name: 'Read', tool_input: { file_path: '/work/app/.env.local' } },
  { tool_name: 'Edit', tool_input: { file_path: '/work/app/src/page.tsx', old_string: 'a', new_string: 'b' } },
  { tool_name: 'Write', tool_input: { file_path: '/work/app/.env', content: 'X=1' } },
  { tool_name: 'MultiEdit', tool_input: { file_path: '/work/app/README.md', edits: [] } },
  { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/work/app/n.ipynb', new_source: '' } },
  { tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '/work/app' } },
  { tool_name: 'Glob', tool_input: { pattern: '**/.env*' } },
  { tool_name: 'Bash', tool_input: { command: 'cat .env.local', description: 'x' } },
  { tool_name: 'Bash', tool_input: { command: 'bash' } },
  { tool_name: 'mcp__x__y', tool_input: { path: '/work/app/.env.local' } },
].map((f) => ({ session_id: 's', hook_event_name: 'PreToolUse', permission_mode: 'default', ...f, cwd: CWD }));

test('every Claude Code payload takes the fast path', () => {
  for (const f of CLAUDE_FIXTURES) assert.equal(isClaudeShaped(f), true, f.tool_name);
});

test('payloads from other agents do not take the fast path', () => {
  const others = [
    { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'ls'] }, cwd: CWD },
    { tool_name: 'Bash', tool_input: { command: 'ls', workdir: '/x' }, cwd: CWD },
    { tool_name: 'Bash', tool_input: { command: 'ls' } },
    { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '' },
    { tool_name: 'Shell', tool_input: { command: 'ls' }, cwd: CWD },
    { tool_name: 'exec_command', tool_input: { cmd: 'ls' }, cwd: CWD },
    { tool_name: 'Read', tool_input: { path: 'x' }, cwd: CWD, cursor_version: '2.0' },
    { tool_name: 'Read', tool_input: '{"path":"x"}', cwd: CWD },
    { tool_name: 'Read', tool_input: ['x'], cwd: CWD },
    null,
    'text',
  ];
  for (const o of others) assert.equal(isClaudeShaped(o), false, JSON.stringify(o));
});

/** A scripts/ folder with only guard-secrets.mjs, plus an optional stand-in adapter that leaves a mark when loaded. */
function lonelyGuard({ withSpyAdapter = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-parity-'));
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(GUARD, path.join(dir, 'scripts', 'guard-secrets.mjs'));
  const mark = path.join(dir, 'adapter-loaded');
  if (withSpyAdapter) {
    mkdirSync(path.join(dir, 'scripts', 'agents'));
    writeFileSync(
      path.join(dir, 'scripts', 'agents', 'guard-input.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(mark)}, 'x');\n` +
        `export const decide = () => ({ deny: false });\nexport const logShape = () => false;\nexport const looksLikeCursor = () => false;\n`,
    );
  }
  return { dir, script: path.join(dir, 'scripts', 'guard-secrets.mjs'), mark };
}

const run = (script, input) =>
  spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, SHIPYARD_HOME: path.join(os.tmpdir(), 'ship-parity-home-unused') },
    timeout: 15_000,
  });

test('a Claude Code payload never loads the adapter, and denies exactly as before', () => {
  const g = lonelyGuard({ withSpyAdapter: true });
  try {
    for (const f of CLAUDE_FIXTURES) {
      const r = run(g.script, f);
      assert.equal(r.status, 0, f.tool_name);
      const expected = evaluate(f);
      assert.equal(r.stdout, expected.deny ? `${denyOutput(expected.reason)}\n` : '', f.tool_name);
    }
    assert.equal(existsSync(g.mark), false, 'the adapter was loaded for a Claude Code payload');
    // A payload in another shape does load it (proves the spy works).
    run(g.script, { tool_name: 'Shell', tool_input: { command: 'ls' }, cwd: '' });
    assert.equal(existsSync(g.mark), true);
  } finally {
    rmSync(g.dir, { recursive: true, force: true });
  }
});

test('without the adapter folder the guard still works, falling back to the old check', () => {
  const g = lonelyGuard();
  try {
    const read = run(g.script, { tool_name: 'Read', tool_input: { file_path: '/work/app/.env' }, cwd: CWD });
    assert.equal(read.status, 0);
    assert.equal(read.stdout, `${denyOutput(REASON)}\n`);
    const cursor = run(g.script, { tool_name: 'Bash', tool_input: { command: 'cat .env.local' }, cwd: '', cursor_version: '2.0' });
    assert.equal(cursor.status, 0);
    assert.equal(cursor.stdout, `${denyOutput(REASON)}\n`);
  } finally {
    rmSync(g.dir, { recursive: true, force: true });
  }
});
