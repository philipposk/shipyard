// The session-start update check: version compare, once-a-day cache, silent and fast when offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion, isNewer, checkForUpdate } from '../scripts/update-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;

function sandbox(version = '0.6.2') {
  const base = mkdtempSync(path.join(tmpdir(), 'shipyard-update-'));
  const root = path.join(base, 'plugin');
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'shipyard', version }));
  const home = path.join(base, 'home');
  return { base, root, home, cache: path.join(home, 'update-check.json'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

async function server(handler) {
  let hits = 0;
  const s = createServer((req, res) => { hits++; handler(req, res); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/latest`, hits: () => hits, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
}
const release = (tag) => (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag_name: tag })); };

test('parseVersion and isNewer', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('1.2.3-beta.1'), null);
  assert.ok(isNewer('0.6.10', '0.6.9'));
  assert.ok(isNewer('v1.0.0', '0.9.9'));
  assert.ok(!isNewer('0.6.2', '0.6.2'));
  assert.ok(!isNewer('0.6.1', '0.6.2'));
  assert.ok(!isNewer(null, '0.6.2'));
  assert.ok(!isNewer('garbage', '0.6.2'));
});

test('prints a one-line notice when a newer release exists, then caches for a day', async () => {
  const sb = sandbox(); const srv = await server(release('v0.7.0'));
  try {
    const env = { SHIPYARD_HOME: sb.home, SHIPYARD_UPDATE_URL: srv.url };
    const line = await checkForUpdate({ env, root: sb.root, now: 1000 });
    assert.match(line, /^Shipyard 0\.7\.0 is out \(you have 0\.6\.2\)\. To update: .*claude plugin update shipyard@shipyard/);
    assert.ok(!line.includes('\n'));
    assert.deepEqual(JSON.parse(readFileSync(sb.cache, 'utf8')), { checkedAt: 1000, latest: '0.7.0' });
    // Within the day: no network, same notice from the cache.
    assert.equal(await checkForUpdate({ env, root: sb.root, now: 1000 + DAY - 1 }), line);
    assert.equal(srv.hits(), 1);
    // After a day: checks again.
    await checkForUpdate({ env, root: sb.root, now: 1000 + DAY });
    assert.equal(srv.hits(), 2);
  } finally { await srv.close(); sb.cleanup(); }
});

test('says nothing when up to date or when the local copy is newer', async () => {
  for (const tag of ['v0.6.2', 'v0.6.1']) {
    const sb = sandbox(); const srv = await server(release(tag));
    try { assert.equal(await checkForUpdate({ env: { SHIPYARD_HOME: sb.home, SHIPYARD_UPDATE_URL: srv.url }, root: sb.root }), ''); }
    finally { await srv.close(); sb.cleanup(); }
  }
});

test('offline: silent, fast, and does not retry until tomorrow', async () => {
  const sb = sandbox();
  try {
    const env = { SHIPYARD_HOME: sb.home, SHIPYARD_UPDATE_URL: 'http://127.0.0.1:9/latest' };
    assert.equal(await checkForUpdate({ env, root: sb.root, now: 5 }), '');
    assert.deepEqual(JSON.parse(readFileSync(sb.cache, 'utf8')), { checkedAt: 5, latest: null });
  } finally { sb.cleanup(); }
});

test('a server that hangs is cut off by the short timeout', async () => {
  const sb = sandbox(); const srv = await server(() => { /* never answers */ });
  try {
    const t = Date.now();
    const line = await checkForUpdate({ env: { SHIPYARD_HOME: sb.home, SHIPYARD_UPDATE_URL: srv.url, SHIPYARD_UPDATE_TIMEOUT_MS: '200' }, root: sb.root });
    assert.equal(line, '');
    assert.ok(Date.now() - t < 1500, 'took too long');
  } finally { await srv.close(); sb.cleanup(); }
});

test('a failed lookup keeps the last known newer version', async () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.home, { recursive: true });
    writeFileSync(sb.cache, JSON.stringify({ checkedAt: 0, latest: '0.9.0' }));
    const line = await checkForUpdate({ env: { SHIPYARD_HOME: sb.home, SHIPYARD_UPDATE_URL: 'http://127.0.0.1:9/latest' }, root: sb.root, now: 2 * DAY });
    assert.match(line, /0\.9\.0 is out/);
  } finally { sb.cleanup(); }
});

test('bad responses, broken cache, a clock gone backwards and the opt-out are all quiet', async () => {
  const sb = sandbox(); const srv = await server((req, res) => { res.statusCode = 403; res.end('rate limited'); });
  try {
    mkdirSync(sb.home, { recursive: true });
    writeFileSync(sb.cache, '{not json');
    const env = { SHIPYARD_HOME: sb.home, SHIPYARD_UPDATE_URL: srv.url };
    assert.equal(await checkForUpdate({ env, root: sb.root, now: 10 }), '');
    // Cache from the "future" (clock moved back) is treated as stale, so it checks again.
    writeFileSync(sb.cache, JSON.stringify({ checkedAt: 10 * DAY, latest: null }));
    await checkForUpdate({ env, root: sb.root, now: DAY });
    assert.equal(srv.hits(), 2);
    assert.equal(await checkForUpdate({ env: { ...env, SHIPYARD_NO_UPDATE_CHECK: '1' }, root: sb.root, now: 100 * DAY }), '');
    assert.equal(srv.hits(), 2);
  } finally { await srv.close(); sb.cleanup(); }
});

test('the hook entry point exits 0 and prints a systemMessage JSON line only when newer', () => {
  const sb = sandbox();
  try {
    // A fresh cache means no network, so the script runs offline and deterministic.
    const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'update-check.mjs')], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: sb.root, SHIPYARD_HOME: sb.home, SHIPYARD_UPDATE_URL: 'http://127.0.0.1:9/latest' }, encoding: 'utf8' });
    mkdirSync(sb.home, { recursive: true });
    writeFileSync(sb.cache, JSON.stringify({ checkedAt: Date.now(), latest: '1.0.0' }));
    const r = run();
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^Shipyard 1\.0\.0 is out/);
    writeFileSync(sb.cache, JSON.stringify({ checkedAt: Date.now(), latest: '0.6.2' }));
    const quiet = run();
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, '');
  } finally { sb.cleanup(); }
});

// The update check lives in its own hooks file, so hooks/hooks.json (and the Codex trust hash) stays untouched.
test('plugin.json adds hooks/update-check.json, which runs the check on session start with a short timeout', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.hooks, './hooks/update-check.json');
  const h = JSON.parse(readFileSync(path.join(ROOT, 'hooks', 'update-check.json'), 'utf8'));
  assert.deepEqual(Object.keys(h.hooks), ['SessionStart']);
  const [entry] = h.hooks.SessionStart;
  assert.equal(entry.matcher, 'startup');
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/update-check\.mjs/);
  assert.ok(entry.hooks[0].timeout > 0 && entry.hooks[0].timeout <= 5);
  const base = JSON.parse(readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(base.hooks.SessionStart, undefined, 'hooks.json must not also run it (it would run twice)');
});
