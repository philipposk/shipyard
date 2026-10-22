// The hook entries install-agents.mjs adds to ~/.codex/hooks.json and ~/.cursor/hooks.json, and the
// optional Codex rules file. Pure functions: no files are touched here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexHookEntry,
  codexRules,
  cursorHookEntries,
  CURSOR_EVENTS,
  hookCommand,
  isShipyardRules,
  mergeCodexHooks,
  mergeCursorHooks,
  PlainError,
  removeShipyardHooks,
  ruleScripts,
  shipyardHookCommands,
} from '../scripts/agents/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'codex-hook-entry.json'), 'utf8'));

const NODE = '/usr/local/bin/node';
const R = '/Users/Jane Doe/.local/share/shipyard';
const entry = codexHookEntry({ node: NODE, root: R, platform: 'darwin' });
const cursor = cursorHookEntries({ node: NODE, root: R, platform: 'darwin' });

const USER_GROUP = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-check', timeout: 5 }] };

test('the Codex hook entry is byte for byte the snapshot', () => {
  const msg = 'changing this makes every Codex user trust the hook again';
  assert.equal(JSON.stringify(entry), JSON.stringify(FIXTURE.darwin), msg);
  const win = codexHookEntry({ node: 'C:/Program Files/nodejs/node.exe', root: 'C:/Users/Jane Doe/.local/share/shipyard', platform: 'win32' });
  assert.equal(JSON.stringify(win), JSON.stringify(FIXTURE.win32), msg);
});

test('commandWindows appears only on Windows, and Windows runs bare node', () => {
  assert.ok(!('commandWindows' in entry.hooks[0]));
  assert.equal(entry.matcher, '.*');
  assert.equal(entry.hooks[0].timeout, 10);
  assert.ok(!('statusMessage' in entry.hooks[0]));
  assert.equal(hookCommand({ node: NODE, root: R, script: 'guard-codex.mjs', platform: 'linux' }), `"${NODE}" "${R}/scripts/guard-codex.mjs"`);
  assert.equal(hookCommand({ node: 'C:/x/node.exe', root: 'C:/S', script: 'guard-cursor.mjs', platform: 'win32' }), 'node "C:/S/scripts/guard-cursor.mjs"');
  assert.equal(codexHookEntry({ node: 'C:/x/node.exe', root: 'C:/S', platform: 'win32' }).hooks[0].commandWindows, 'node "C:\\S\\scripts\\guard-codex.mjs"');
});

test('Codex: an empty or missing file gets one entry', () => {
  for (const before of [null, '', '  \n', '{}']) {
    const { text, changed } = mergeCodexHooks(before, entry);
    assert.deepEqual(JSON.parse(text), { hooks: { PreToolUse: [entry] } });
    assert.ok(text.endsWith('}\n'));
    if (before === '{}') assert.equal(changed, true);
  }
});

test('Codex: the student\'s own entries are kept, in place', () => {
  const mine = { model: 'x', hooks: { PreToolUse: [USER_GROUP], PostToolUse: [USER_GROUP] } };
  const data = JSON.parse(mergeCodexHooks(JSON.stringify(mine), entry).text);
  assert.equal(data.model, 'x');
  assert.deepEqual(data.hooks.PostToolUse, [USER_GROUP]);
  assert.deepEqual(data.hooks.PreToolUse, [USER_GROUP, entry]);
});

test('Codex: an older Shipyard entry is replaced where it was, never duplicated', () => {
  const old = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/old/place/scripts/guard-codex.mjs"', timeout: 10 }] };
  const shared = { matcher: '.*', hooks: [{ type: 'command', command: 'mine' }, { type: 'command', command: '"/n" "/x/scripts/guard-codex.mjs"' }] };
  const before = JSON.stringify({ hooks: { PreToolUse: [old, USER_GROUP, shared] } });
  const data = JSON.parse(mergeCodexHooks(before, entry).text);
  assert.deepEqual(data.hooks.PreToolUse, [entry, USER_GROUP, { matcher: '.*', hooks: [{ type: 'command', command: 'mine' }] }]);
  assert.equal(JSON.stringify(data).split('guard-codex.mjs').length - 1, 1);
});

test('Codex: a second merge is byte-identical and reports no change', () => {
  const once = mergeCodexHooks(JSON.stringify({ hooks: { PreToolUse: [USER_GROUP] } }), entry).text;
  const twice = mergeCodexHooks(once, entry);
  assert.equal(twice.text, once);
  assert.equal(twice.changed, false);
});

test('Codex: invalid JSON or odd shapes are refused in plain words', () => {
  assert.throws(() => mergeCodexHooks('{"hooks": ', entry, '~/.codex/hooks.json'), (e) => e instanceof PlainError && /~\/\.codex\/hooks\.json is not valid JSON, so Shipyard did not touch it/.test(e.message));
  assert.throws(() => mergeCodexHooks('[]', entry), PlainError);
  assert.throws(() => mergeCodexHooks('{"hooks": []}', entry), /not an object/);
  assert.throws(() => mergeCodexHooks('{"hooks": {"PreToolUse": {}}}', entry), /not a list/);
});

test('Cursor: version 1, the four events, the tool matcher, no failClosed', () => {
  const data = JSON.parse(mergeCursorHooks(null, cursor).text);
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.hooks), CURSOR_EVENTS);
  assert.deepEqual(CURSOR_EVENTS, ['beforeShellExecution', 'beforeReadFile', 'beforeMCPExecution', 'preToolUse']);
  for (const event of CURSOR_EVENTS) {
    const [e] = data.hooks[event];
    assert.equal(e.command, `"${NODE}" "${R}/scripts/guard-cursor.mjs"`);
    assert.equal(e.timeout, 10);
    assert.ok(!('failClosed' in e));
    if (event === 'preToolUse') assert.equal(e.matcher, 'Read|ReadFile|Grep|Write|Edit');
    else assert.ok(!('matcher' in e));
  }
  const win = cursorHookEntries({ node: 'C:/n/node.exe', root: 'C:/S', platform: 'win32' });
  assert.equal(win.beforeReadFile.command, 'node "C:/S/scripts/guard-cursor.mjs"');
});

test('Cursor: the student\'s entries are kept, an old Shipyard entry replaced, and a re-run is identical', () => {
  const mine = { command: './my-audit.sh' };
  const old = { command: 'node "/old/scripts/guard-cursor.mjs"', timeout: 3 };
  const before = JSON.stringify({ version: 1, hooks: { beforeShellExecution: [mine, old], afterFileEdit: [mine] } });
  const once = mergeCursorHooks(before, cursor);
  const data = JSON.parse(once.text);
  assert.deepEqual(data.hooks.beforeShellExecution, [mine, cursor.beforeShellExecution]);
  assert.deepEqual(data.hooks.afterFileEdit, [mine]);
  assert.deepEqual(data.hooks.beforeReadFile, [cursor.beforeReadFile]);
  const twice = mergeCursorHooks(once.text, cursor);
  assert.equal(twice.text, once.text);
  assert.equal(twice.changed, false);
});

test('Cursor: another hooks version is refused, and invalid JSON too', () => {
  assert.throws(() => mergeCursorHooks('{"version": 2, "hooks": {}}', cursor), (e) => e instanceof PlainError && /version 2/.test(e.message));
  assert.throws(() => mergeCursorHooks('nope', cursor), /not valid JSON/);
  assert.equal(JSON.parse(mergeCursorHooks('{"hooks": {}}', cursor).text).version, 1);
});

test('removing takes out only Shipyard\'s entries', () => {
  const codex = mergeCodexHooks(JSON.stringify({ hooks: { PreToolUse: [USER_GROUP] } }), entry).text;
  const codexAfter = removeShipyardHooks(codex, 'codex');
  assert.equal(codexAfter.changed, true);
  assert.deepEqual(JSON.parse(codexAfter.text), { hooks: { PreToolUse: [USER_GROUP] } });
  assert.deepEqual(JSON.parse(removeShipyardHooks(mergeCodexHooks(null, entry).text, 'codex').text), { hooks: {} });

  const mine = { command: './my-audit.sh' };
  const cur = mergeCursorHooks(JSON.stringify({ version: 1, hooks: { beforeReadFile: [mine] } }), cursor).text;
  const curAfter = removeShipyardHooks(cur, 'cursor');
  assert.deepEqual(JSON.parse(curAfter.text), { version: 1, hooks: { beforeReadFile: [mine] } });
  assert.equal(removeShipyardHooks(curAfter.text, 'cursor').changed, false);
});

test('the Shipyard hook commands can be found again (for --check)', () => {
  const codex = mergeCodexHooks(JSON.stringify({ hooks: { PreToolUse: [USER_GROUP] } }), entry).text;
  assert.deepEqual(shipyardHookCommands(codex, 'codex'), [{ event: 'PreToolUse', matcher: '.*', command: entry.hooks[0].command }]);
  const cur = mergeCursorHooks(null, cursor).text;
  assert.deepEqual(shipyardHookCommands(cur, 'cursor').map((h) => h.event), CURSOR_EVENTS);
  assert.deepEqual(shipyardHookCommands('not json', 'codex'), []);
});

test('the Codex rules file is marked, lists Shipyard\'s own scripts only, and is recognised', () => {
  const scripts = ruleScripts(ROOT);
  assert.ok(scripts.includes('setup-status.mjs'));
  assert.ok(scripts.includes('provision-supabase.mjs'));
  assert.ok(!scripts.includes('install-agents.mjs'));
  assert.ok(!scripts.some((s) => s.startsWith('guard-')));
  const text = codexRules({ root: R, scripts: ['a.mjs', 'b.mjs'] });
  assert.equal(text.split('\n')[0], '# shipyard');
  assert.ok(text.includes(`prefix_rule(pattern=["node", "${R}/scripts/a.mjs"], decision="allow")`));
  assert.equal(text.match(/prefix_rule/g).length, 2);
  assert.equal(isShipyardRules(text), true);
  assert.equal(isShipyardRules('prefix_rule(pattern=["git"], decision="allow")\n'), false);
  assert.equal(isShipyardRules(null), false);
  assert.ok(!text.includes('\u2014'));
});
