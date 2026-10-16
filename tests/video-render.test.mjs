import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/video-render.mjs';
import { parseSpec, parseRenderOutput, parseVolume, volumeNotes, renderOne } from '../scripts/video/render-lib.mjs';
import { tempDir, removeDir, makeFakeApp, put, fakeRun, whichAll, whichNone } from './video-helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'video-render.mjs');

test('parseSpec accepts the engine\'s cut names and refuses anything odd', () => {
  assert.deepEqual(parseSpec('acme'), { tag: 'acme', theme: 'light', music: '', silent: false, vertical: false });
  assert.deepEqual(parseSpec('acme:dark::vertical'), { tag: 'acme', theme: 'dark', music: '', silent: false, vertical: true });
  assert.deepEqual(parseSpec('launch:light:calm:silent:vertical'), { tag: 'launch', theme: 'light', music: 'calm', silent: true, vertical: true });
  for (const bad of ['', 'a b:light', 'x:blue', '../x:light', 'x:light:../m', 'x:light::loud', 'x;rm:light', 'x:light:a b']) {
    assert.throws(() => parseSpec(bad), /render name|light or dark|music name|not a cut/, bad);
  }
});

test('parseRenderOutput reads the engine\'s lines', () => {
  const ok = parseRenderOutput('Bundling...\nacme-light-nomusic.mp4 rendered in 31 s\nacme-light-nomusic.mp4: no frozen stretch over 0.5 s\nout/sheet-acme-light-nomusic.jpg\n');
  assert.equal(ok.name, 'acme-light-nomusic');
  assert.equal(ok.seconds, 31);
  assert.equal(ok.deadAir, null);
  const dead = parseRenderOutput('x-light-nomusic.mp4 rendered in 12 s\nWARNING: x-light-nomusic.mp4 has dead air (frozen > 0.5 s): 3.00-4.20 s (1.2 s). Cut minSec.\n');
  assert.match(dead.deadAir, /^x-light-nomusic\.mp4 has dead air/);
  assert.equal(parseRenderOutput('nothing useful').name, null);
});

test('volume reading and notes', () => {
  const v = parseVolume('[Parsed_volumedetect_0 @ 0x1] mean_volume: -19.8 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -3.2 dB\n');
  assert.deepEqual(v, { meanDb: -19.8, maxDb: -3.2 });
  assert.deepEqual(volumeNotes(v), []);
  assert.match(volumeNotes({ meanDb: -20, maxDb: 0 })[0], /clipping/);
  assert.match(volumeNotes({ meanDb: -40, maxDb: -10 })[0], /quiet/);
  assert.equal(parseVolume('no audio'), null);
});

async function renderFixture() {
  const app = await makeFakeApp({ withVideo: true });
  await put(path.join(app.dir, 'video'), 'src/timelines/launch.json', '{"tag":"launch"}');
  return app;
}

const engineRun = ({ stdout, fail = false, volume = 'mean_volume: -20.0 dB\nmax_volume: -2.0 dB\n', files = ['launch-light-nomusic'] } = {}) => fakeRun(async (cmd, a, opts) => {
  if (cmd === 'node') {
    if (fail) return { code: 1, stderr: 'Error: composition not found' };
    for (const f of files) {
      await put(opts.cwd, `out/${f}.mp4`, 'mp4-data');
      await put(opts.cwd, `out/sheet-${f}.jpg`, 'jpg');
    }
    return { stdout: stdout ?? `${files[0]}.mp4 rendered in 20 s\n${files[0]}.mp4: no frozen stretch over 0.5 s\n` };
  }
  if (cmd === 'ffmpeg') return { stderr: volume };
  return {};
});

test('renders one cut: runs the engine\'s render script in video/, reports files, size, volume', async () => {
  const app = await renderFixture();
  try {
    const run = engineRun();
    const r = await main({ _: [app.dir, 'launch:light'], json: true }, { run, which: whichAll });
    assert.equal(r.ok, true);
    const [x] = r.renders;
    assert.equal(x.name, 'launch-light-nomusic');
    assert.match(x.mp4, /video\/out\/launch-light-nomusic\.mp4$/);
    assert.match(x.sheet, /video\/out\/sheet-launch-light-nomusic\.jpg$/);
    assert.deepEqual(x.volume, { meanDb: -20, maxDb: -2 });
    const render = run.calls.find((c) => c.cmd === 'node');
    assert.deepEqual(render.args, ['scripts/render.mjs', 'launch:light']);
    assert.equal(render.cwd, path.join(app.dir, 'video'));
    assert.equal(render.env?.STRICT_MOTION, undefined);
  } finally {
    await removeDir(app.parent);
  }
});

test('several cuts run one after another, never together', async () => {
  const app = await renderFixture();
  try {
    let running = 0;
    let maxRunning = 0;
    const run = fakeRun(async (cmd, a, opts) => {
      if (cmd !== 'node') return { stderr: 'mean_volume: -20.0 dB\nmax_volume: -2.0 dB' };
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      const spec = a[1];
      const name = spec === 'launch:light' ? 'launch-light-nomusic' : 'launch-dark-nomusic';
      await put(opts.cwd, `out/${name}.mp4`, 'x');
      running--;
      return { stdout: `${name}.mp4 rendered in 1 s\n` };
    });
    const r = await main({ _: [app.dir, 'launch:light', 'launch:dark'], json: true }, { run, which: whichAll });
    assert.equal(maxRunning, 1);
    assert.deepEqual(r.renders.map((x) => x.name), ['launch-light-nomusic', 'launch-dark-nomusic']);
    assert.equal(r.renders[0].sheet, null, 'a missing contact sheet is reported as null, not invented');
  } finally {
    await removeDir(app.parent);
  }
});

test('dead air is a warning by default and a failure with --strict (STRICT_MOTION)', async () => {
  const app = await renderFixture();
  try {
    const warnLine = 'WARNING: launch-light-nomusic.mp4 has dead air (frozen > 0.5 s): 3.00-4.20 s (1.2 s). Cut it.';
    const run = engineRun({ stdout: `launch-light-nomusic.mp4 rendered in 9 s\n${warnLine}\n` });
    const r = await main({ _: [app.dir, 'launch:light'], json: true }, { run, which: whichAll });
    assert.equal(r.ok, true);
    assert.match(r.renders[0].deadAir, /dead air/);

    const strictRun = fakeRun(async () => ({ code: 1, stderr: 'Error: launch-light-nomusic.mp4 has dead air (frozen > 0.5 s)' }));
    const s = await main({ _: [app.dir, 'launch:light'], json: true, strict: true }, { run: strictRun, which: whichAll });
    assert.equal(s.ok, false);
    assert.match(s.renders[0].error, /dead air/);
    assert.equal(strictRun.calls[0].env.STRICT_MOTION, '1');
  } finally {
    await removeDir(app.parent);
  }
});

test('a failed render says so with the engine\'s last lines', async () => {
  const app = await renderFixture();
  try {
    const r = await main({ _: [app.dir, 'launch:light'], json: true }, { run: engineRun({ fail: true }), which: whichAll });
    assert.equal(r.ok, false);
    assert.match(r.renders[0].error, /render failed[\s\S]*composition not found/);
  } finally {
    await removeDir(app.parent);
  }
});

test('the silent cut is not loudness-checked', async () => {
  const app = await renderFixture();
  try {
    const run = engineRun({ files: ['launch-light-nomusic-silent'] });
    const r = await main({ _: [app.dir, 'launch:light::silent'], json: true }, { run, which: whichAll });
    assert.equal(r.ok, true);
    assert.equal(r.renders[0].volume, undefined);
    assert.ok(!run.calls.some((c) => c.cmd === 'ffmpeg'));
  } finally {
    await removeDir(app.parent);
  }
});

test('stops early, with plain words: no ffmpeg, no timeline, bad cut name, no video folder', async () => {
  const app = await renderFixture();
  const bare = await makeFakeApp();
  try {
    const run = fakeRun();
    await assert.rejects(main({ _: [app.dir, 'launch:light'] }, { run, which: whichNone }), /ffmpeg and ffprobe are not installed/);
    await assert.rejects(main({ _: [app.dir, 'other:light'] }, { run, which: whichAll }), /no voice and timing for "other"[\s\S]*video-voice\.mjs --tag other/);
    await assert.rejects(main({ _: [app.dir, 'launch:blue'] }, { run, which: whichAll }), /light or dark/);
    await assert.rejects(main({ _: [bare.dir, 'launch:light'] }, { run, which: whichAll }), /Run video-setup\.mjs/);
    await assert.rejects(main({ _: [app.dir] }, { run, which: whichAll }), /at least one cut/);
    assert.equal(run.calls.length, 0, 'nothing runs when the input is wrong');
  } finally {
    await removeDir(app.parent);
    await removeDir(bare.parent);
  }
});

test('renderOne refuses a bad cut name before running anything', async () => {
  const run = fakeRun();
  await assert.rejects(renderOne({ run, videoDir: '/x', spec: 'a;b:light' }), /render name/);
  assert.equal(run.calls.length, 0);
});

test('CLI: --help is 0, too few arguments is 2', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '/tmp'], { encoding: 'utf8' }).status, 2);
});
