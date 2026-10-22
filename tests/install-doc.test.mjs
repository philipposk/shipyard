// INSTALL.md is what an agent follows for the one-prompt install. These tests keep it honest:
// every command it shows must match the installer, and it must never tell an agent to approve Codex's hook trust itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexTrustRecorded } from '../scripts/agents/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(path.join(ROOT, 'INSTALL.md'), 'utf8');
const installer = readFileSync(path.join(ROOT, 'scripts', 'install-agents.mjs'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const sections = (text) => {
  const out = {};
  let name = '';
  for (const line of text.split('\n')) {
    const h = /^## (.+)/.exec(line);
    if (h) name = h[1];
    out[name] = (out[name] ?? '') + line + '\n';
  }
  return out;
};

test('the one-prompt line and the pointer for agents are in the README', () => {
  assert.match(readme, /Install Shipyard: github\.com\/philipposk\/shipyard/);
  assert.match(readme, /\[INSTALL\.md\]\(INSTALL\.md\)/);
});

test('every installer flag INSTALL.md uses exists in install-agents.mjs', () => {
  const spec = /boolean: \[([^\]]*)\],\s*string: \[([^\]]*)\]/.exec(installer);
  const known = new Set([...spec[1].matchAll(/'([^']+)'/g), ...spec[2].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const used = [...doc.matchAll(/install-agents\.mjs"?[^`\n]*?(--[a-z-]+)/g)].map((m) => m[1].slice(2));
  assert.ok(used.length >= 4);
  for (const flag of used) assert.ok(known.has(flag), `--${flag} is not a flag of install-agents.mjs`);
});

test('every script INSTALL.md runs exists', () => {
  for (const m of doc.matchAll(/scripts\/([a-z-]+\.mjs)/g)) assert.ok(existsSync(path.join(ROOT, 'scripts', m[1])), m[1]);
});

test('Codex and Cursor install without a question, Codex with the agent named', () => {
  const s = sections(doc);
  assert.match(s['A. Codex'], /--agent codex --yes/);
  assert.match(s['B. Cursor'], /--agent cursor --yes/);
  assert.match(s['A. Codex'], /git clone --depth 1 https:\/\/github\.com\/philipposk\/shipyard\.git/);
});

test('the Codex hook trust is left to the user, in one smallest step', () => {
  const s = sections(doc);
  assert.match(s['A. Codex'], /codex '\$shipyard-setup'/);
  assert.match(s['A. Codex'], /Trust all and continue/);
  assert.match(s['A. Codex'], /only the user can do/i);
  const never = s['What you must never do'];
  assert.match(never, /hooks\.state/);
  assert.match(never, /--dangerously-bypass-hook-trust/);
  // No instruction anywhere else may use them.
  const rest = doc.replace(never, '');
  assert.ok(!/hooks\.state|dangerously-bypass/.test(rest), 'only the "never" section may mention them');
  assert.ok(!/writeAtomic\([^)]*codexConfig/.test(installer));
});

test('Claude Code uses its own plugin commands', () => {
  const s = sections(doc);
  assert.match(s['C. Claude Code'], /claude plugin marketplace add philipposk\/shipyard/);
  assert.match(s['C. Claude Code'], /claude plugin install shipyard@shipyard/);
  assert.match(s['C. Claude Code'], /\/reload-plugins/);
});

test('the Codex setup skill starts with the guard check', () => {
  const rewrites = readFileSync(path.join(ROOT, 'scripts', 'agents', 'rewrites.mjs'), 'utf8');
  assert.match(rewrites, /id: 'S1'/);
  assert.match(rewrites, /guard-check\.mjs" start/);
});

// ---------- reading Codex's trust record (never writing it) ----------

const hooks = (cmd = '"/n" "/s/scripts/guard-codex.mjs"') => JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo hi' }] }, { matcher: '.*', hooks: [{ type: 'command', command: cmd }] }] } });
const file = '/h/.codex/hooks.json';

test('codexTrustRecorded: finds the table for the Shipyard hook position', () => {
  const cfg = `[hooks.state]\n\n[hooks.state."${file}:pre_tool_use:1:0"]\ntrusted_hash = "sha256:abc"\n`;
  assert.equal(codexTrustRecorded({ hooksText: hooks(), configText: cfg, hooksFile: file }), 'yes');
});

test('codexTrustRecorded: another hook trusted in the same file does not count', () => {
  const cfg = `[hooks.state."${file}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`;
  assert.equal(codexTrustRecorded({ hooksText: hooks(), configText: cfg, hooksFile: file }), 'no');
});

test('codexTrustRecorded: no config, other file, or no Shipyard hook', () => {
  assert.equal(codexTrustRecorded({ hooksText: hooks(), configText: null, hooksFile: file }), 'no');
  const other = `[hooks.state."/x/hooks.json:pre_tool_use:1:0"]\ntrusted_hash = "sha256:abc"\n`;
  assert.equal(codexTrustRecorded({ hooksText: hooks(), configText: other, hooksFile: file }), 'no');
  assert.equal(codexTrustRecorded({ hooksText: hooks('echo hi'), configText: '', hooksFile: file }), 'unknown');
  assert.equal(codexTrustRecorded({ hooksText: null, configText: '', hooksFile: file }), 'unknown');
  assert.equal(codexTrustRecorded({ hooksText: '{bad', configText: '', hooksFile: file }), 'unknown');
});
