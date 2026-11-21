// /shipyard:idea: files an idea as a GitHub issue labelled `idea`, or saves it locally when gh cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(path.join(os.tmpdir(), 'ship-idea-home-'));
process.env.SHIPYARD_HOME = home;
const idea = await import('../scripts/idea.mjs');
(await import('../scripts/lib/log.mjs')).setQuiet(true);
const ideasFile = path.join(home, idea.IDEAS_FILE);
test.after(() => rmSync(home, { recursive: true, force: true }));

/** A fake `run` that answers git and gh from a script of replies, and records every call. */
function fakeRun(gh) {
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    if (cmd === 'git') {
      if (args[0] === 'remote') return { code: 0, stdout: 'https://someone:secret-token@github.com/acme/salon-app.git\n', stderr: '' };
      return { code: 0, stdout: 'feature/booking\n', stderr: '' };
    }
    const next = gh.shift();
    return typeof next === 'function' ? next(args) : next;
  };
  fn.calls = calls;
  return fn;
}
const created = { code: 0, stdout: 'https://github.com/philipposk/shipyard/issues/77\n', stderr: '' };
const appDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-idea-app-'));
  writeFileSync(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug: 'salon-app' }));
  return dir;
};
const ghCalls = (run) => run.calls.filter((c) => c.cmd === 'gh');

test('files an issue labelled idea with the app, branch and context, and no login from the remote', async () => {
  const dir = appDir();
  try {
    const run = fakeRun([created]);
    const r = await idea.main({ _: ['Let', 'design', 'import a Figma link'], context: 'Adding a booking calendar.', dir }, { run, now: new Date('2026-11-21T10:00:00Z') });
    assert.deepEqual(r, { ok: true, filed: true, url: 'https://github.com/philipposk/shipyard/issues/77', title: 'Let design import a Figma link' });
    const [call] = ghCalls(run);
    assert.deepEqual(call.args.slice(0, 4), ['issue', 'create', '--repo', 'philipposk/shipyard']);
    assert.ok(call.args.includes('--label') && call.args.includes('idea'));
    assert.match(call.input, /^Let design import a Figma link\n/);
    assert.match(call.input, /\*\*From:\*\* salon-app \(https:\/\/github\.com\/acme\/salon-app\), branch `feature\/booking`/);
    assert.match(call.input, /\*\*Working on:\*\* Adding a booking calendar\./);
    assert.match(call.input, /2026-11-21/);
    assert.doesNotMatch(call.input, /secret-token|someone/);
    assert.ok(!existsSync(ideasFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creates the idea label when the repository lacks it, then files', async () => {
  const run = fakeRun([{ code: 1, stdout: '', stderr: "could not add label: 'idea' not found" }, { code: 0, stdout: '', stderr: '' }, created]);
  const r = await idea.main({ _: ['An idea'], dir: os.tmpdir() }, { run });
  assert.equal(r.filed, true);
  const calls = ghCalls(run);
  assert.deepEqual(calls[1].args.slice(0, 3), ['label', 'create', 'idea']);
  assert.ok(calls[2].args.includes('--label'));
});

test('files without the label when it still cannot be added (no rights on the repository)', async () => {
  const missing = { code: 1, stdout: '', stderr: "could not add label: 'idea' not found" };
  const run = fakeRun([missing, { code: 1, stdout: '', stderr: 'HTTP 403' }, missing, created]);
  const r = await idea.main({ _: ['An idea'], dir: os.tmpdir() }, { run });
  assert.equal(r.filed, true);
  assert.ok(!ghCalls(run)[3].args.includes('--label'));
});

test('without gh, or signed out, the idea is saved locally and --send-saved files it later', async () => {
  rmSync(ideasFile, { force: true });
  const a = await idea.main({ _: ['First idea'], dir: os.tmpdir() }, { run: fakeRun([{ code: 127, stdout: '', stderr: 'Command not found: gh' }]) });
  assert.equal(a.ok, true);
  assert.equal(a.filed, false);
  assert.match(a.reason, /not installed/);
  const b = await idea.main({ _: ['Second idea'], dir: os.tmpdir() }, { run: fakeRun([{ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }]) });
  assert.match(b.reason, /not signed in/);
  const saved = readFileSync(ideasFile, 'utf8');
  assert.match(saved, /## \d{4}-\d{2}-\d{2}: First idea/);
  assert.equal(idea.parseSaved(saved).length, 2);

  // One goes through, one fails again: only the failed one stays in the file.
  const run = fakeRun([created, { code: 124, stdout: '', stderr: 'Timed out.' }]);
  const r = await idea.main({ _: [], 'send-saved': true }, { run });
  assert.deepEqual(r, { ok: false, sent: ['https://github.com/philipposk/shipyard/issues/77'], left: 1 });
  assert.match(ghCalls(run)[0].input, /^First idea\n/);
  const left = idea.parseSaved(readFileSync(ideasFile, 'utf8'));
  assert.deepEqual(left.map((e) => e.title), ['Second idea']);
});

test('a saved idea containing an HTML comment end still reads back intact', () => {
  const body = 'Use <!-- markers --> in docs\n';
  const [entry] = idea.parseSaved(idea.savedEntry({ title: 't', body, date: '2026-11-21' }));
  assert.equal(entry.body, body);
});

test('titles are one line and cut at a word; bad input is a usage error', async () => {
  assert.equal(idea.ideaTitle('Short one\nmore detail'), 'Short one');
  const long = idea.ideaTitle('word '.repeat(40));
  assert.ok(long.length <= 80 && long.endsWith('…') && !long.includes('  '));
  await assert.rejects(idea.main({ _: [] }, { run: fakeRun([]) }), /Give the idea/);
  await assert.rejects(idea.main({ _: ['x'], repo: 'not a repo' }, { run: fakeRun([]) }), /not a GitHub repository/);
});

test('the CLI prints help and the skill points at the script', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'idea.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /labelled "idea"/);
  const skill = readFileSync(path.join(ROOT, 'skills', 'idea', 'SKILL.md'), 'utf8');
  assert.match(skill, /scripts\/idea\.mjs/);
  assert.match(skill, /Never open a pull request/);
});
