// plan-waves.mjs and voice-test.mjs from the review skill. No network, never plays sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normFile, planWaves } from '../scripts/review/plan-waves.mjs';
import { DEFAULT_SCRIPT, headphonesDefault, parseScript } from '../scripts/review/voice-test.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (name) => path.join(ROOT, 'scripts', 'review', name);
const run = (name, args) => spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', timeout: 15_000 });

function tmp(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------- plan-waves ----------

test('normFile: line numbers, notes and repo paths are stripped', () => {
  assert.equal(normFile('src/lib/a.ts:12'), 'src/lib/a.ts');
  assert.equal(normFile('src/lib/a.ts:12:4'), 'src/lib/a.ts');
  assert.equal(normFile('src/old.ts (deleted)'), 'src/old.ts');
  assert.equal(normFile('./src/a.ts'), 'src/a.ts');
  assert.equal(normFile('/work/my app/src/a.ts', '/work/my app'), 'src/a.ts');
  assert.equal(normFile('/work/my app/src/a.ts', '/work/my app/'), 'src/a.ts');
  assert.equal(normFile('C:\\work\\app\\src\\a.ts', 'C:/work/app'), 'src/a.ts');
  // Without --repo, an absolute path is cut at the first usual top-level folder.
  assert.equal(normFile('/home/jane/code/shop/supabase/migrations/0001.sql'), 'supabase/migrations/0001.sql');
  assert.equal(normFile(''), '');
  assert.equal(normFile(undefined), '');
});

const REVIEW = {
  repo: '/work/app',
  confirmed: [
    { area: 'auth', where: 'src/proxy.ts:10', files: ['/work/app/src/proxy.ts', 'src/lib/auth/cookie.ts'] },
    { area: 'ai', where: 'src/lib/ai.ts:5', files: [] },
    { area: 'ui', where: 'src/components/Menu.tsx:40', files: ['src/proxy.ts'] },
    { area: 'auth', where: 'src/app/api/auth/signup/route.ts:3' },
    { area: 'db', where: 'supabase/migrations/0004_x.sql:1', files: null },
  ],
};

test('planWaves: batches that share a file never land in the same wave', () => {
  const { batches, waves } = planWaves(REVIEW);
  assert.equal(batches.length, 4);
  const auth = batches.find((b) => b.k === 'auth');
  assert.deepEqual(auth.ids, [0, 3]);
  assert.deepEqual(auth.files, ['src/app/api/auth/signup/route.ts', 'src/lib/auth/cookie.ts', 'src/proxy.ts']);
  const waveOf = (k) => waves.findIndex((w) => w.includes(k));
  assert.notEqual(waveOf('auth'), waveOf('ui'), 'auth and ui both touch src/proxy.ts');
  assert.equal(waveOf('ai'), 0);
  assert.equal(waveOf('db'), 0);
  for (const w of waves) {
    const files = w.flatMap((k) => batches.find((b) => b.k === k).files);
    assert.equal(new Set(files).size, files.length, `wave ${w} shares a file`);
  }
  assert.equal(waves.flat().length, batches.length);
});

test('planWaves: --skip leaves findings out, --strong marks areas, bad input is refused', () => {
  const { batches, waves } = planWaves(REVIEW, { skip: [2, 4], strong: ['auth'] });
  assert.deepEqual(batches.map((b) => b.k).sort(), ['ai', 'auth']);
  assert.equal(batches.find((b) => b.k === 'auth').strong, true);
  assert.equal(batches.find((b) => b.k === 'ai').strong, false);
  assert.equal(waves.length, 1);
  assert.throws(() => planWaves({}), /no "confirmed" list/);
  assert.throws(() => planWaves(null), /no "confirmed" list/);
  assert.deepEqual(planWaves({ confirmed: [] }), { batches: [], waves: [] });
  // An explicit id wins over the position, so a re-ordered list still skips the right finding.
  const byId = planWaves({ confirmed: [{ id: 7, area: 'a', where: 'x.ts:1' }, { id: 3, area: 'a', where: 'y.ts:1' }] }, { skip: [3] });
  assert.deepEqual(byId.batches[0].ids, [7]);
});

test('plan-waves CLI: saves plan.json next to the review and reports the waves', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'review.json');
  writeFileSync(file, JSON.stringify(REVIEW));
  const r = run('plan-waves.mjs', [file, '--strong', 'auth,nope', '--json']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.out, path.join(dir, 'plan.json'));
  assert.deepEqual(out.unknownStrong, ['nope']);
  const plan = JSON.parse(readFileSync(out.out, 'utf8'));
  assert.ok(Array.isArray(plan.batches) && Array.isArray(plan.waves));
  assert.equal(plan.batches.find((b) => b.k === 'auth').strong, true);

  const human = run('plan-waves.mjs', [file, '--out', path.join(dir, 'p2.json')]);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /wave 1: /);
  assert.match(human.stdout, /4 batches in 2 waves/);
});

test('plan-waves CLI: wrong input gets a plain message', (t) => {
  const dir = tmp(t);
  assert.equal(run('plan-waves.mjs', []).status, 2);
  assert.equal(run('plan-waves.mjs', [path.join(dir, 'review.json'), '--skip', 'two']).status, 2);
  const missing = run('plan-waves.mjs', [path.join(dir, 'nope.json'), '--json']);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error, /does not exist/);
  writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.match(JSON.parse(run('plan-waves.mjs', [path.join(dir, 'bad.json'), '--json']).stdout).error, /not valid JSON/);
  assert.match(run('plan-waves.mjs', ['--help']).stdout, /--strong/);
});

// ---------- voice-test ----------

test('parseScript: A and B turns, comments and blank lines skipped, other lines refused', () => {
  assert.deepEqual(parseScript('# a test\nA: Hello there.\n\nB:  Hi.\r\n'), [{ who: 'A', text: 'Hello there.' }, { who: 'B', text: 'Hi.' }]);
  assert.throws(() => parseScript('A: ok\nC: who?'), /Line 2/);
  assert.throws(() => parseScript('just text'), /Line 1/);
  assert.throws(() => parseScript('\n# nothing\n'), /no turns/);
});

test('the built-in script has two voices and an action item with a deadline', () => {
  const turns = parseScript(DEFAULT_SCRIPT);
  assert.equal(turns.length, 5);
  assert.deepEqual([...new Set(turns.map((t) => t.who))].sort(), ['A', 'B']);
  assert.match(DEFAULT_SCRIPT, /by Friday/);
});

const PROFILER = (airpodsDefault) => `Audio:

    Devices:

        MacBook Pro Speakers:

          Manufacturer: Apple Inc.
          Output Channels: 2
          Current SampleRate: 48000
          Transport: Built-in
          Output Source: MacBook Pro Speakers
${airpodsDefault ? '' : '          Default Output Device: Yes\n'}          Default System Output Device: Yes

        Jane's AirPods Pro:

          Input Channels: 1
          Manufacturer: Apple Inc.
          Output Channels: 2
          Current SampleRate: 24000
          Transport: Bluetooth
${airpodsDefault ? '          Default Output Device: Yes\n' : ''}
        External Headphones:

          Output Channels: 2
`;

test('headphonesDefault: only when the default output device is headphones or AirPods', () => {
  assert.equal(headphonesDefault(PROFILER(true)), true);
  assert.equal(headphonesDefault(PROFILER(false)), false);
  assert.equal(headphonesDefault(''), false);
});

test('voice-test CLI: --dry-run shows the turns and plays nothing', (t) => {
  const r = run('voice-test.mjs', ['--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual({ ok: out.ok, dryRun: out.dryRun, turns: out.turns }, { ok: true, dryRun: true, turns: 5 });
  assert.deepEqual(out.voices, { A: 'Samantha', B: 'Daniel' });

  const dir = tmp(t);
  const file = path.join(dir, 's.txt');
  writeFileSync(file, 'A: One.\nB: Two.\n');
  const own = run('voice-test.mjs', ['--script', file, '--voice-b', 'Alex', '--dry-run']);
  assert.equal(own.status, 0);
  assert.match(own.stdout, /B \(Alex\): Two\./);
  assert.match(own.stdout, /2 turns, nothing played/);

  assert.equal(run('voice-test.mjs', ['--pause', 'soon', '--dry-run']).status, 2);
  assert.match(JSON.parse(run('voice-test.mjs', ['--script', path.join(dir, 'nope.txt'), '--json']).stdout).error, /does not exist/);
  assert.match(run('voice-test.mjs', ['--help']).stdout, /headphones off/);
});

test('voice-test CLI: playback outside macOS explains what to do instead', { skip: process.platform === 'darwin' }, () => {
  const r = run('voice-test.mjs', ['--json']);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /needs macOS/);
});
