// Messages name the student's coding agent. With no sign of Codex or Cursor they read exactly as
// before (Claude Code), so Claude Code users see no change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentName, agentNameStart, currentAgent, reviewHint, skillHint } from '../scripts/lib/agent.mjs';
import { renderSettingsHtml } from '../scripts/settings-page.mjs';
import { renderGalleryHtml } from '../scripts/design-gallery.mjs';
import { renderDirectionsHtml } from '../scripts/design-directions.mjs';
import { restoreSteps } from '../scripts/ops/backup-core.mjs';
import { MissingSecretError } from '../scripts/lib/secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function homeWith(record) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-agent-'));
  if (record !== undefined) writeFileSync(path.join(dir, 'install.json'), typeof record === 'string' ? record : JSON.stringify(record));
  return dir;
}

test('currentAgent: Claude Code first, then the install record, else Claude Code', () => {
  const cases = [
    [undefined, {}, 'claude'],
    ['{not json', {}, 'claude'],
    [{ agents: {} }, {}, 'claude'],
    [{ agents: { codex: { hooksFile: 'x' } } }, {}, 'codex'],
    [{ agents: { cursor: { hooksFile: 'x' } } }, {}, 'cursor'],
    [{ agents: { codex: {}, cursor: {} } }, {}, 'any'],
    [{ agents: { cursor: {}, other: {} } }, {}, 'cursor'],
    [{ agents: { cursor: {} } }, { CLAUDECODE: '1' }, 'claude'],
    [{ agents: { codex: {}, cursor: {} } }, { CLAUDECODE: '1' }, 'claude'],
  ];
  for (const [record, extra, want] of cases) {
    const home = homeWith(record);
    try {
      assert.equal(currentAgent({ ...extra }, home), want, JSON.stringify(record));
      assert.equal(currentAgent({ SHIPYARD_HOME: home, ...extra }), want, `via SHIPYARD_HOME: ${JSON.stringify(record)}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  assert.equal(currentAgent({}, path.join(os.tmpdir(), 'no-such-shipyard-home')), 'claude');
});

test('the hints for each agent', () => {
  assert.equal(skillHint('setup', 'claude'), '/shipyard:setup');
  assert.equal(skillHint('setup', 'codex'), '$shipyard-setup');
  assert.equal(skillHint('setup', 'cursor'), '/shipyard-setup');
  assert.equal(skillHint('setup', 'any'), 'Shipyard setup');
  assert.equal(skillHint('setup settings', 'claude'), '/shipyard:setup settings');
  assert.equal(skillHint('setup settings', 'codex'), '$shipyard-setup settings');
  assert.equal(skillHint('new-app', 'cursor'), '/shipyard-new-app');
  assert.deepEqual(['claude', 'codex', 'cursor', 'any'].map((a) => agentName(a)), ['Claude', 'Codex', 'Cursor', 'your coding agent']);
  assert.equal(agentNameStart('any'), 'Your coding agent');
  assert.equal(agentNameStart('cursor'), 'Cursor');
  assert.equal(reviewHint('codex'), 'ask your coding agent to review the branch before you merge');
});

test('the Claude Code default is exactly the old wording', () => {
  assert.equal(skillHint('setup', 'claude'), '/shipyard:setup');
  assert.equal(agentName('claude'), 'Claude');
  assert.equal(agentNameStart('claude'), 'Claude');
  assert.equal(reviewHint('claude'), 'run /code-review in Claude Code before you merge');
  assert.match(restoreSteps('/x', false)[0], /then ask Claude: "restore my backup of this app from this folder"\. Claude does not open the files/);
});

/** The inline script's hash in the page's CSP must match the script, or the browser blocks it. */
function cspMatchesScript(html) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = createHash('sha256').update(script).digest('base64');
  return html.replace(/&#39;/g, "'").includes(`script-src 'sha256-${hash}'`);
}

test('the settings page, look gallery and directions page name the agent, and their CSP still fits the script', () => {
  const profile = { version: 1, setup: { done: [] }, apps: [], accounts: {}, defaults: {} };
  const claude = renderSettingsHtml({ profile, agent: 'claude' });
  assert.match(claude, /Copied, paste it into Claude/);
  assert.match(claude, /Tell Claude what you want to build/);
  const cursor = renderSettingsHtml({ profile, agent: 'cursor' });
  assert.match(cursor, /Copied, paste it into Cursor/);
  assert.match(cursor, /Tell Cursor what you want to build/);
  assert.ok(!/Claude/.test(cursor));
  for (const html of [claude, cursor]) assert.ok(cspMatchesScript(html));

  const gallery = renderGalleryHtml({ agent: 'any' });
  assert.match(gallery, /paste the sentence into your coding agent/);
  assert.match(gallery, /paste it into your coding agent/);
  assert.ok(cspMatchesScript(gallery));
  assert.match(renderGalleryHtml({ agent: 'claude' }), /paste the sentence into Claude/);

  const directions = renderDirectionsHtml({ agent: 'codex' });
  assert.match(directions, /paste the sentence into Codex/);
  assert.match(directions, /paste it into Codex/);
  assert.ok(cspMatchesScript(directions));
});

function runScript(script, args, home) {
  const env = { ...process.env, SHIPYARD_HOME: home, NO_COLOR: '1' };
  delete env.CLAUDECODE;
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', env, timeout: 20_000 });
}

test('script messages: unchanged with no install record, Cursor wording with a Cursor-only record', () => {
  const empty = homeWith(undefined);
  const cursorOnly = homeWith({ schema: 1, agents: { cursor: { hooksFile: '/x/.cursor/hooks.json' } } });
  try {
    const before = runScript('setup-status.mjs', [], empty).stdout;
    assert.match(before, /Run \/shipyard:setup to continue\./);
    assert.match(before, /Good Claude habits/);
    const after = runScript('setup-status.mjs', [], cursorOnly).stdout;
    assert.match(after, /Run \/shipyard-setup to continue\./);
    assert.match(after, /Good habits for your coding agent/);
    assert.ok(!/Claude|\/shipyard:/.test(after), after);

    // An error from a script library, as a student would see it.
    const saved = { home: process.env.SHIPYARD_HOME, claude: process.env.CLAUDECODE };
    try {
      delete process.env.CLAUDECODE;
      process.env.SHIPYARD_HOME = cursorOnly;
      assert.match(new MissingSecretError('SUPABASE_ACCESS_TOKEN', 'supabase').message, /Run "\/shipyard-setup" and finish the "supabase" step/);
      process.env.SHIPYARD_HOME = empty;
      assert.match(new MissingSecretError('SUPABASE_ACCESS_TOKEN', 'supabase').message, /Run "\/shipyard:setup" and finish the "supabase" step/);
    } finally {
      if (saved.home === undefined) delete process.env.SHIPYARD_HOME;
      else process.env.SHIPYARD_HOME = saved.home;
      if (saved.claude !== undefined) process.env.CLAUDECODE = saved.claude;
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(cursorOnly, { recursive: true, force: true });
  }
});

test('no message helper adds an em dash', () => {
  for (const a of ['claude', 'codex', 'cursor', 'any']) {
    for (const s of [agentName(a), agentNameStart(a), skillHint('setup', a), reviewHint(a)]) assert.ok(!s.includes('—'));
  }
});
