import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, inspectScript } from '../scripts/video-voice.mjs';
import { run as realRun } from '../scripts/lib/run.mjs';
import { tempDir, removeDir, makeFakeApp, put, fakeRun } from './video-helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'video-voice.mjs');
const OPENAI = 'sk-test-FAKE-openai-0123456789abcdef';
const DEEPGRAM = 'dg-test-FAKE-deepgram-0123456789';
const GEMINI = 'gm-test-FAKE-gemini-0123456789ab';

// A stand-in for the engine's scripts/voice.mjs: reports what it was given, then writes the files the real one would.
const CHILD = `
import { writeFileSync, mkdirSync } from 'node:fs';
const tag = process.argv.find((a) => a.startsWith('--tag=')).split('=')[1];
const script = process.argv.find((a) => a.startsWith('--script=')).split('=')[1];
const names = ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY'];
writeFileSync('child-report.json', JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])),
  provider: process.env.VOICE_PROVIDER ?? null, voice: process.env.VOICE ?? null, pace: process.env.PACE ?? null,
}));
mkdirSync('src/timelines', { recursive: true });
mkdirSync('out', { recursive: true });
writeFileSync('src/timelines/' + tag + '.json', JSON.stringify({ tag, script, fps: 30, xf: 10, total: 300, scenes: [{ id: 'hook' }, { id: 'end' }] }));
writeFileSync('out/' + tag + '.vtt', 'WEBVTT\\n');
console.log('hook 2.10s');
`;

const FAIL_CHILD = `
console.error('TTS 401: Incorrect API key provided: ${OPENAI}. You can find your key at https://example.test');
process.exit(1);
`;

async function fixture({ child = CHILD } = {}) {
  const app = await makeFakeApp({ withVideo: true });
  await put(path.join(app.dir, 'video'), 'scripts/voice.mjs', child);
  return app;
}
const secrets = (obj) => async () => new Map(Object.entries(obj));
const args = (o) => ({ _: [], 'dry-run': false, retime: false, json: true, ...o });
const report = async (app) => JSON.parse(await readFile(path.join(app.dir, 'video', 'child-report.json'), 'utf8'));

test('keys reach the voice step through its environment only: never argv, never a file in video/', async () => {
  const app = await fixture();
  try {
    const r = await main(args({ _: [app.dir], tag: 'launch', provider: 'openai', voice: 'cedar', pace: 'fast' }), {
      run: realRun,
      readSecrets: secrets({ OPENAI_API_KEY: OPENAI, DEEPGRAM_API_KEY: DEEPGRAM, SUPABASE_ACCESS_TOKEN: ('sbp_' + 'should_not_be_passed_0123456789') }),
    });
    assert.equal(r.ok, true);
    const rep = await report(app);
    assert.equal(rep.env.OPENAI_API_KEY, OPENAI);
    assert.equal(rep.env.DEEPGRAM_API_KEY, DEEPGRAM);
    assert.equal(rep.env.GEMINI_API_KEY, null);
    assert.deepEqual(rep.argv, ['--script=launch', '--tag=launch']);
    assert.equal(rep.provider, 'openai');
    assert.equal(rep.voice, 'cedar');
    assert.equal(rep.pace, 'fast');
    const everything = JSON.stringify(rep.argv);
    for (const k of [OPENAI, DEEPGRAM]) assert.ok(!everything.includes(k), 'a key is in argv');
    // no key file written into the video folder, and our own output never holds a key
    const names = await readdir(path.join(app.dir, 'video'));
    assert.ok(!names.some((n) => n.startsWith('.env')), names.join(','));
    assert.ok(!JSON.stringify(r).includes(OPENAI) && !JSON.stringify(r).includes(DEEPGRAM));
    assert.equal(r.scenes, 2);
    assert.equal(r.seconds, 10);
    assert.match(r.captions, /launch\.vtt$/);
  } finally {
    await removeDir(app.parent);
  }
});

test('only the voice keys are handed over: account-level keys stay home', async () => {
  const app = await fixture();
  try {
    const run = fakeRun(async (cmd, a, opts) => {
      await put(opts.cwd, 'src/timelines/launch.json', JSON.stringify({ tag: 'launch', script: 'launch', fps: 30, total: 30, scenes: [{}] }));
      return {};
    });
    await main(args({ _: [app.dir], tag: 'launch' }), {
      run, readSecrets: secrets({ OPENAI_API_KEY: OPENAI, SUPABASE_ACCESS_TOKEN: ('sbp_' + 'account_level_0123456789'), STRIPE_SECRET_KEY: ('sk_' + 'test_0123456789abcdefghij') }),
    });
    const env = run.calls[0].env;
    assert.deepEqual(Object.keys(env).sort(), ['OPENAI_API_KEY', 'VOICE_PROVIDER']);
    assert.equal(run.calls[0].input, undefined);
    assert.equal(run.calls[0].cmd, 'node');
    assert.deepEqual(run.calls[0].args, ['scripts/voice.mjs', '--script=launch', '--tag=launch']);
  } finally {
    await removeDir(app.parent);
  }
});

test('--script and --retime are passed on', async () => {
  const app = await fixture();
  try {
    await put(path.join(app.dir, 'video'), 'src/scripts/long.json', JSON.stringify([{ id: 'a', text: 'One two three.' }]));
    await main(args({ _: [app.dir], tag: 'cut2', script: 'long', retime: true }), { run: realRun, readSecrets: secrets({ OPENAI_API_KEY: OPENAI }) });
    assert.deepEqual((await report(app)).argv, ['--script=long', '--tag=cut2', '--retime']);
  } finally {
    await removeDir(app.parent);
  }
});

test('a provider failure that echoes the key is shown with the key removed', async () => {
  const app = await fixture({ child: FAIL_CHILD });
  try {
    await assert.rejects(
      main(args({ _: [app.dir], tag: 'launch' }), { run: realRun, readSecrets: secrets({ OPENAI_API_KEY: OPENAI }) }),
      (err) => {
        assert.ok(!err.message.includes(OPENAI), 'the key must not appear in the error');
        assert.match(err.message, /voice step failed/);
        assert.match(err.message, /key may be wrong or out of credit/);
        return true;
      },
    );
  } finally {
    await removeDir(app.parent);
  }
});

test('missing key: stops before running anything, names the key and the file, never a value', async () => {
  const app = await fixture();
  try {
    const run = fakeRun();
    await assert.rejects(main(args({ _: [app.dir], tag: 'launch' }), { run, readSecrets: secrets({}) }), /OPENAI_API_KEY is missing from your Shipyard keys file/);
    assert.equal(run.calls.length, 0);
    await assert.rejects(main(args({ _: [app.dir], tag: 'launch', provider: 'deepgram' }), { run, readSecrets: secrets({ OPENAI_API_KEY: OPENAI }) }), /DEEPGRAM_API_KEY is missing/);
    await assert.rejects(main(args({ _: [app.dir], tag: 'launch', provider: 'gemini' }), { run, readSecrets: secrets({ GEMINI_API_KEY: GEMINI }) }), /OPENAI_API_KEY is missing/);
    // gemini + a Deepgram key (used for the word timings) is enough
    assert.equal(run.calls.length, 0);
  } finally {
    await removeDir(app.parent);
  }
});

test('--dry-run checks the script and keys, spends nothing, runs nothing', async () => {
  const app = await fixture();
  try {
    const run = fakeRun();
    const r = await main(args({ _: [app.dir], tag: 'launch', 'dry-run': true }), { run, readSecrets: secrets({}) });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.missing, ['OPENAI_API_KEY']);
    assert.equal(r.plan.lines, 2);
    assert.equal(run.calls.length, 0);
  } finally {
    await removeDir(app.parent);
  }
});

test('script problems are explained in plain words', async () => {
  const app = await fixture();
  const v = path.join(app.dir, 'video');
  try {
    const bad = (text) => put(v, 'src/scripts/bad.json', text);
    const go = () => main(args({ _: [app.dir], tag: 'bad', 'dry-run': true }), { run: fakeRun(), readSecrets: secrets({ OPENAI_API_KEY: OPENAI }) });
    await assert.rejects(main(args({ _: [app.dir], tag: 'nope', 'dry-run': true }), { run: fakeRun(), readSecrets: secrets({}) }), /no script at video\/src\/scripts\/nope\.json/);
    await bad('not json');
    await assert.rejects(go(), /not valid JSON/);
    await bad('[]');
    await assert.rejects(go(), /at least one line/);
    await bad(JSON.stringify([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }]));
    await assert.rejects(go(), /used twice/);
    await bad(JSON.stringify([{ id: 'a/b', text: 'x' }]));
    await assert.rejects(go(), /"id" must be a short word/);
    await bad(JSON.stringify([{ id: 'a', text: '  ' }]));
    await assert.rejects(go(), /"text" is empty/);
  } finally {
    await removeDir(app.parent);
  }
});

test('inspectScript counts lines, words and estimates speech time', () => {
  const r = inspectScript([{ id: 'a', text: 'one two three four five six' }, { id: 'b', text: 'seven eight nine' }]);
  assert.deepEqual(r, { lines: 2, words: 9, seconds: 3 });
});

test('video not set up: asks to run video-setup first', async () => {
  const app = await makeFakeApp();
  try {
    await assert.rejects(main(args({ _: [app.dir], tag: 'launch' }), { run: fakeRun(), readSecrets: secrets({}) }), /Run video-setup\.mjs/);
  } finally {
    await removeDir(app.parent);
  }
});

test('bad options are usage errors', async () => {
  const app = await fixture();
  try {
    const d = { run: fakeRun(), readSecrets: secrets({}) };
    await assert.rejects(main(args({ _: [app.dir] }), d), /--tag/);
    await assert.rejects(main(args({ _: [app.dir], tag: '../x' }), d), /--tag can use/);
    await assert.rejects(main(args({ _: [app.dir], tag: 'a', provider: 'azure' }), d), /--provider must be/);
    await assert.rejects(main(args({ _: [app.dir], tag: 'a', pace: 'warp' }), d), /--pace/);
    await assert.rejects(main(args({ _: [app.dir], tag: 'a', voice: 'x;rm -rf' }), d), /--voice/);
  } finally {
    await removeDir(app.parent);
  }
});

test('CLI: --help is 0, a missing tag is 2', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '/tmp'], { encoding: 'utf8' }).status, 2);
});
