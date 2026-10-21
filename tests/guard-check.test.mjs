// The guard check (scripts/guard-check.mjs): proof, checked by the script, that the key guard runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFileName, startCheck, startSteps, verifyCheck } from '../scripts/guard-check.mjs';
import { guardCode } from '../scripts/agents/guard-input.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'guard-check.mjs');
const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ship-gcheck-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const NONCE = '0123456789abcdef';

test('start makes the plain file and the check file, neither holds a key', () => {
  const made = startCheck({ tmp: TMP, nonce: NONCE });
  assert.equal(made.dir, path.join(TMP, `shipyard-guard-check-${NONCE}`));
  assert.equal(readFileSync(made.plainFile, 'utf8'), `Shipyard guard check: safe to read. PLAIN-${NONCE}\n`);
  assert.equal(path.basename(made.checkFile), checkFileName(NONCE));
  assert.equal(readFileSync(made.checkFile, 'utf8'), `SHIPYARD_GUARD_CHECK=not-a-key-${NONCE}\n`);
  const codex = startSteps(made, 'codex').join('\n');
  assert.match(codex, /cat ".*plain\.txt"/);
  assert.match(codex, /--agent codex/);
  assert.ok(!codex.includes('--read'));
  const cursor = startSteps(made, 'cursor').join('\n');
  assert.match(cursor, /file-reading tool/);
  assert.match(cursor, /--read/);
  for (const text of [codex, cursor]) assert.ok(!text.includes('—'), 'no em dash');
});

test('verify: ON only with the right plain value and the right codes', () => {
  const base = { dir: path.join(TMP, `shipyard-guard-check-${NONCE}`), plain: `PLAIN-${NONCE}`, tmp: TMP };
  const shell = guardCode(NONCE, 'shell');
  const read = guardCode(NONCE, 'read');
  const cases = [
    [{ agent: 'codex' }, 'OFF', 1],
    [{ agent: 'codex', shell: 'deadbeef' }, 'OFF', 1],
    [{ agent: 'codex', shell, sawContent: true }, 'OFF', 1],
    [{ agent: 'codex', shell: read }, 'OFF', 1],
    [{ agent: 'cursor', shell }, 'OFF', 1],
    [{ agent: 'cursor', shell, read: shell }, 'OFF', 1],
    [{ agent: 'codex', shell, plain: 'PLAIN-wrong' }, 'inconclusive', 3],
    [{ agent: 'codex', shell, plain: undefined }, 'inconclusive', 3],
    [{ agent: 'other', shell }, 'inconclusive', 3],
    [{ agent: 'codex', shell, dir: path.join(TMP, 'not-a-check') }, 'inconclusive', 3],
  ];
  for (const [extra, status, exit] of cases) {
    const r = verifyCheck({ ...base, ...extra });
    assert.equal(r.status, status, JSON.stringify(extra));
    assert.equal(r.exit, exit, JSON.stringify(extra));
  }
  const off = verifyCheck({ ...base, agent: 'codex' }).lines.join('\n');
  assert.match(off, /\/hooks/);
  assert.match(off, /install-agents\.mjs" --check/);
  assert.match(verifyCheck({ ...base, agent: 'cursor', shell }).lines.join('\n'), /Reload Window/);
  // Still there: nothing above said ON.
  assert.equal(existsSync(base.dir), true);
});

test('verify ON deletes the check folder (Codex needs the shell code, Cursor both)', () => {
  for (const [agent, codes] of [
    ['codex', { shell: guardCode(NONCE, 'shell') }],
    ['cursor', { shell: guardCode(NONCE, 'shell'), read: guardCode(NONCE, 'read') }],
  ]) {
    const made = startCheck({ tmp: TMP, nonce: NONCE });
    const r = verifyCheck({ dir: made.dir, agent, plain: `PLAIN-${NONCE}`, tmp: TMP, ...codes });
    assert.equal(r.status, 'ON', agent);
    assert.equal(r.exit, 0);
    assert.equal(existsSync(made.dir), false, agent);
  }
});

test('the command line: start in TMPDIR, then verify with exit codes', () => {
  const env = { ...process.env, TMPDIR: TMP, TMP, TEMP: TMP };
  const start = spawnSync(process.execPath, [SCRIPT, 'start', '--json'], { encoding: 'utf8', env, timeout: 15_000 });
  assert.equal(start.status, 0, start.stderr);
  const made = JSON.parse(start.stdout);
  assert.equal(realpathSync(path.dirname(made.dir)), TMP);
  const nonce = /shipyard-guard-check-([0-9a-f]{16})$/.exec(made.dir)[1];
  assert.equal(existsSync(made.checkFile), true);

  const verify = (args) => spawnSync(process.execPath, [SCRIPT, 'verify', '--dir', made.dir, ...args], { encoding: 'utf8', env, timeout: 15_000 });
  assert.equal(verify(['--agent', 'codex']).status, 3);
  assert.equal(verify(['--agent', 'codex', '--plain', `PLAIN-${nonce}`]).status, 1);
  const on = verify(['--agent', 'codex', '--plain', `PLAIN-${nonce}`, '--shell', guardCode(nonce, 'shell')]);
  assert.equal(on.status, 0, on.stdout);
  assert.match(on.stdout, /Guard check: ON in Codex/);
  assert.equal(existsSync(made.dir), false);

  const steps = spawnSync(process.execPath, [SCRIPT, 'start', '--agent', 'cursor'], { encoding: 'utf8', env, timeout: 15_000 });
  assert.match(steps.stdout, /Guard check code \(read\)/);
  assert.ok(!steps.stdout.includes('—'));
  assert.match(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).stdout, /Usage/);
});
