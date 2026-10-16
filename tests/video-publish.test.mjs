import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, resolveRender, findCaptions } from '../scripts/video-publish.mjs';
import {
  MAX_BYTES, encodeAttempts, buildEncodeArgs, buildPosterArgs, parseSize, parseDuration, defaultPosterAt, defaultWebName, WEB_NAME_RE,
  moveCuesToTop, jsxSnippet,
} from '../scripts/video/encode.mjs';
import { makeFakeApp, removeDir, put, fakeRun, whichAll, whichNone } from './video-helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'video-publish.mjs');

test('size limit is 10 MB and the attempts go from good quality to smaller', () => {
  assert.equal(MAX_BYTES, 10_000_000);
  const a = encodeAttempts();
  assert.equal(a[0].crf, 24);
  assert.ok(!a[0].shrink);
  const plain = a.filter((x) => !x.shrink).map((x) => x.crf);
  assert.deepEqual(plain, [...plain].sort((x, y) => x - y), 'plain attempts only get smaller');
  assert.ok(a.at(-1).shrink, 'the last resort also shrinks the picture');
});

test('encode arguments: H.264, loudness-normalised AAC, fast start; the file names are plain arguments', () => {
  const args = buildEncodeArgs({ src: '/in/a b.mp4', out: '/out/demo-light.mp4', crf: 26 });
  const s = args.join(' ');
  assert.ok(args.includes('/in/a b.mp4') && args.at(-1) === '/out/demo-light.mp4');
  assert.match(s, /-c:v libx264 -profile:v high -preset slow -crf 26 -pix_fmt yuv420p/);
  assert.match(s, /loudnorm=I=-16:TP=-1\.5:LRA=11/);
  assert.match(s, /-c:a aac -b:a 128k/);
  assert.match(s, /-movflags \+faststart/);
  assert.ok(!args.includes('-vf'), 'no scaling unless asked');
  const wide = buildEncodeArgs({ src: 'a', out: 'b', crf: 30, shrink: true });
  assert.equal(wide[wide.indexOf('-vf') + 1], 'scale=-2:720');
  const tall = buildEncodeArgs({ src: 'a', out: 'b', crf: 30, shrink: true, vertical: true });
  assert.equal(tall[tall.indexOf('-vf') + 1], 'scale=720:-2');
});

test('poster arguments: one frame at the chosen second, 1280x720 or 720x1280', () => {
  const w = buildPosterArgs({ src: 'in.mp4', out: 'p.jpg', at: 12.5 });
  assert.deepEqual(w, ['-v', 'error', '-y', '-ss', '12.5', '-i', 'in.mp4', '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '3', 'p.jpg']);
  assert.ok(buildPosterArgs({ src: 'a', out: 'b', at: 1, vertical: true }).includes('scale=720:1280'));
});

test('probe parsing, poster default, web names', () => {
  assert.deepEqual(parseSize('1920,1080\n'), { width: 1920, height: 1080 });
  assert.equal(parseSize('garbage'), null);
  assert.equal(parseDuration('20.5\n'), 20.5);
  assert.equal(parseDuration('N/A'), null);
  assert.equal(defaultPosterAt(20), 9);
  assert.equal(defaultPosterAt(null), 3);
  assert.equal(defaultPosterAt(1), 1);
  assert.equal(defaultWebName('acme-light-nomusic'), 'demo-light');
  assert.equal(defaultWebName('acme-dark-nomusic'), 'demo-dark');
  assert.equal(defaultWebName('acme-light-nomusic-vertical'), 'demo-light-phone');
  assert.equal(defaultWebName('acme-dark-nomusic-silent-vertical'), 'demo-dark-silent-phone');
  for (const n of ['demo-light', 'a', 'x1-2']) assert.ok(WEB_NAME_RE.test(n), n);
  for (const n of ['Demo', '-x', 'a/b', '../x', 'a.b', 'a b', '']) assert.ok(!WEB_NAME_RE.test(n), n);
});

test('captions at the top: adds line:5% to timing lines only, once', () => {
  const vtt = 'WEBVTT\n\n00:00:00.200 --> 00:00:02.300\nMeet Recipe Box.\n\n00:00:02.500 --> 00:00:04.000 line:90%\nKeep this.\n\n01:02.000 --> 01:03.000\nShort form.\n';
  const out = moveCuesToTop(vtt);
  assert.match(out, /00:00:00\.200 --> 00:00:02\.300 line:5%\n/);
  assert.match(out, /00:00:02\.500 --> 00:00:04\.000 line:90%\n/, 'an existing position is respected');
  assert.match(out, /01:02\.000 --> 01:03\.000 line:5%\n/);
  assert.match(out, /^WEBVTT\n/);
  assert.match(out, /\nMeet Recipe Box\.\n/, 'cue text is untouched');
  assert.equal(moveCuesToTop(out), out, 'running it twice changes nothing');
});

test('page snippet: lazy video, poster, captions off by default, AI voice note', () => {
  const s = jsxSnippet({ base: 'demo-light' });
  assert.match(s, /preload="none"/);
  assert.match(s, /poster="\/video\/demo-light\.jpg"/);
  assert.match(s, /src="\/video\/demo-light\.mp4"/);
  assert.match(s, /<track kind="captions" src="\/video\/demo\.vtt"/);
  assert.doesNotMatch(s, /\bdefault\b/);
  assert.match(s, /Narrated with an AI voice/);
  assert.doesNotMatch(jsxSnippet({ base: 'x', captions: false }), /<track/);
});

// ---- the command itself, with a stand-in ffmpeg/ffprobe ----

const SIZES = { 24: 1_600_000, 26: 1_300_000, 28: 900_000, 30: 700_000, 32: 600_000, 34: 500_000 };

function mediaRun({ size = '1920,1080', duration = '20.0', sizes = SIZES, ffmpegFails = false } = {}) {
  return fakeRun(async (cmd, a) => {
    if (cmd === 'ffprobe') return { stdout: a.includes('stream=width,height') ? `${size}\n` : `${duration}\n` };
    if (cmd === 'ffmpeg') {
      if (ffmpegFails) return { code: 1, stderr: 'Unknown encoder libx264' };
      const out = a.at(-1);
      if (out.endsWith('.mp4')) {
        const crf = a[a.indexOf('-crf') + 1];
        const shrink = a.includes('-vf');
        await writeFile(out, Buffer.alloc(shrink ? 400_000 : (sizes[crf] ?? 5_000_000)));
      } else {
        await writeFile(out, 'jpg');
      }
    }
    return {};
  });
}

async function fixture() {
  const app = await makeFakeApp({ withVideo: true });
  const v = path.join(app.dir, 'video');
  await put(v, 'out/launch-light-nomusic.mp4', 'RENDER');
  await put(v, 'out/launch-dark-nomusic.mp4', 'RENDER');
  await put(v, 'out/launch-light-nomusic-silent.mp4', 'RENDER');
  await put(v, 'out/launch.vtt', 'WEBVTT\n\n00:00:00.200 --> 00:00:02.300\nMeet Recipe Box.\n');
  return app;
}
const args = (o = {}) => ({ _: [], json: true, 'captions-top': false, 'no-captions': false, 'no-patch': false, ...o });

test('publish: picks the best quality under the limit, writes mp4 + poster + captions into public/video/, records it', async () => {
  const app = await fixture();
  try {
    const run = mediaRun();
    const r = await main(args({ _: [app.dir, 'launch-light-nomusic'], 'max-mb': '1' }), { run, which: whichAll });
    assert.equal(r.ok, true);
    assert.deepEqual(r.attempts.map((x) => x.crf), [24, 26, 28]);
    assert.equal(r.sizeMb, 0.9);
    const pub = path.join(app.dir, 'public', 'video');
    assert.equal((await stat(path.join(pub, 'demo-light.mp4'))).size, 900_000);
    assert.equal(await readFile(path.join(pub, 'demo-light.jpg'), 'utf8'), 'jpg');
    assert.match(await readFile(path.join(pub, 'demo.vtt'), 'utf8'), /Meet Recipe Box/);
    assert.equal(r.posterAt, 9);
    assert.match(r.snippet, /demo-light\.mp4/);
    const cfg = JSON.parse(await readFile(path.join(app.dir, '.shipyard-app.json'), 'utf8'));
    assert.equal(cfg.video.published[0].name, 'demo-light');
    assert.equal(cfg.slug, 'recipe-box');
    // every ffmpeg argument is a separate argv entry and no shell is involved
    assert.ok(run.calls.every((c) => ['ffprobe', 'ffmpeg'].includes(c.cmd)));
    assert.match(await readFile(path.join(app.dir, 'src/proxy.ts'), 'utf8'), /\|mp4\|webm\|vtt\)\$/, 'signed-out visitors can open the files');
  } finally {
    await removeDir(app.parent);
  }
});

test('publish: default limit is 10 MB (a 1.6 MB test file passes at the first quality)', async () => {
  const app = await fixture();
  try {
    const r = await main(args({ _: [app.dir, 'launch-dark-nomusic'] }), { run: mediaRun(), which: whichAll });
    assert.equal(r.ok, true);
    assert.deepEqual(r.attempts.map((x) => x.crf), [24]);
    assert.match(r.video, /demo-dark\.mp4$/);
  } finally {
    await removeDir(app.parent);
  }
});

test('publish: too big even at the smallest settings is a failure that says what to do (files are still written)', async () => {
  const app = await fixture();
  try {
    const run = fakeRun(async (cmd, a) => {
      if (cmd === 'ffprobe') return { stdout: a.includes('stream=width,height') ? '1920,1080\n' : '20\n' };
      const out = a.at(-1);
      await writeFile(out, out.endsWith('.mp4') ? Buffer.alloc(2_000_000) : 'jpg');
      return {};
    });
    const r = await main(args({ _: [app.dir, 'launch-light-nomusic'], 'max-mb': '1' }), { run, which: whichAll });
    assert.equal(r.ok, false);
    assert.match(r.error, /over the 1 MB limit/);
    assert.equal(r.attempts.length, encodeAttempts().length);
  } finally {
    await removeDir(app.parent);
  }
});

test('publish: phone cut uses portrait poster and shrink sizes', async () => {
  const app = await fixture();
  try {
    const run = mediaRun({ size: '1080,1920' });
    const r = await main(args({ _: [app.dir, 'launch-light-nomusic'], name: 'demo-phone' }), { run, which: whichAll });
    assert.equal(r.vertical, true);
    const poster = run.calls.find((c) => c.cmd === 'ffmpeg' && c.args.at(-1).endsWith('.jpg'));
    assert.ok(poster.args.includes('scale=720:1280'));
  } finally {
    await removeDir(app.parent);
  }
});

test('publish: options --poster-at, --captions-top, --no-captions, --no-patch, --vtt', async () => {
  const app = await fixture();
  try {
    const v = path.join(app.dir, 'video');
    await put(v, 'out/other.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOther.\n');
    const proxyBefore = await readFile(path.join(app.dir, 'src/proxy.ts'), 'utf8');
    const run = mediaRun();
    const r = await main(args({ _: [app.dir, 'launch-light-nomusic'], 'poster-at': '12.5', 'captions-top': true, vtt: 'other', 'no-patch': true }), { run, which: whichAll });
    assert.equal(r.posterAt, 12.5);
    const vtt = await readFile(path.join(app.dir, 'public/video/demo.vtt'), 'utf8');
    assert.match(vtt, /Other\./);
    assert.match(vtt, /line:5%/);
    assert.equal(await readFile(path.join(app.dir, 'src/proxy.ts'), 'utf8'), proxyBefore, '--no-patch leaves the proxy alone');
    const none = await main(args({ _: [app.dir, 'launch-light-nomusic'], 'no-captions': true, name: 'plain', 'no-patch': true }), { run, which: whichAll });
    assert.equal(none.captions, null);
    assert.doesNotMatch(none.snippet, /<track/);
  } finally {
    await removeDir(app.parent);
  }
});

test('publish: the silent cut needs no captions file', async () => {
  const app = await fixture();
  try {
    const r = await main(args({ _: [app.dir, 'launch-light-nomusic-silent'] }), { run: mediaRun(), which: whichAll });
    assert.equal(r.captions, null);
    assert.match(r.video, /demo-light-silent\.mp4$/);
  } finally {
    await removeDir(app.parent);
  }
});

test('publish: only files inside video/out/ can be published; a path elsewhere is refused', async () => {
  const app = await fixture();
  try {
    await put(app.dir, 'elsewhere.mp4', 'x');
    await assert.rejects(resolveRender(app.dir, path.join(app.dir, 'elsewhere.mp4')), /Could not find that render/);
    await assert.rejects(resolveRender(app.dir, '../../etc/passwd'), /Could not find that render/);
    await assert.rejects(resolveRender(app.dir, 'nope'), /Run video-render\.mjs first/);
    const byPath = await resolveRender(app.dir, path.join(app.dir, 'video/out/launch-light-nomusic.mp4'));
    assert.equal(byPath.name, 'launch-light-nomusic');
    const byName = await resolveRender(app.dir, 'launch-light-nomusic');
    assert.equal(byName.file, byPath.file);
  } finally {
    await removeDir(app.parent);
  }
});

test('captions are found by the tag inside the render name, longest tag first', async () => {
  const app = await fixture();
  try {
    const out = path.join(app.dir, 'video/out');
    await put(out, 'launch-2.vtt', 'WEBVTT\n');
    assert.match(await findCaptions(out, 'launch-2-light-nomusic'), /launch-2\.vtt$/);
    assert.match(await findCaptions(out, 'launch-light-nomusic'), /launch\.vtt$/);
    assert.equal(await findCaptions(out, 'unrelated-light-nomusic'), null, 'two vtt files and no match: do not guess');
    assert.match(await findCaptions(out, 'x', 'launch'), /launch\.vtt$/);
    assert.equal(await findCaptions(out, 'x', 'missing'), null);
  } finally {
    await removeDir(app.parent);
  }
});

test('publish: plain errors for ffmpeg missing, ffmpeg failing, bad options', async () => {
  const app = await fixture();
  try {
    await assert.rejects(main(args({ _: [app.dir, 'launch-light-nomusic'] }), { run: fakeRun(), which: whichNone }), /ffmpeg and ffprobe are not installed/);
    await assert.rejects(main(args({ _: [app.dir, 'launch-light-nomusic'] }), { run: mediaRun({ ffmpegFails: true }), which: whichAll }), /ffmpeg could not make the web copy/);
    const d = { run: fakeRun(), which: whichAll };
    await assert.rejects(main(args({ _: [app.dir] }), d), /app folder and the render/);
    await assert.rejects(main(args({ _: [app.dir, 'x'], name: 'My Brand' }), d), /--name can use/);
    await assert.rejects(main(args({ _: [app.dir, 'x'], 'max-mb': '0' }), d), /--max-mb/);
    await assert.rejects(main(args({ _: [app.dir, 'x'], 'poster-at': '-3' }), d), /--poster-at/);
  } finally {
    await removeDir(app.parent);
  }
});

test('CLI: --help is 0, no arguments is 2', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});

// ---- with the real ffmpeg, when it is installed (a 3-second generated clip: no network, no keys) ----

import { run as realRun, which as realWhich } from '../scripts/lib/run.mjs';
import { parseVolume } from '../scripts/video/render-lib.mjs';

const haveFfmpeg = (await realWhich('ffmpeg')) && (await realWhich('ffprobe'));

test('real ffmpeg: a generated clip becomes mp4 + poster + captions that ffprobe can read; loudness is readable', { skip: !haveFfmpeg && 'ffmpeg is not installed' }, async () => {
  const app = await makeFakeApp({ withVideo: true });
  try {
    const out = path.join(app.dir, 'video', 'out');
    await put(out, 'keep.txt', 'x');
    const clip = path.join(out, 'demo-light-nomusic.mp4');
    const gen = await realRun('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], { timeoutMs: 60_000 });
    assert.equal(gen.code, 0, gen.stderr);
    await put(out, 'demo.vtt', 'WEBVTT\n\n00:00:00.200 --> 00:00:02.300\nHello.\n');

    const r = await main(args({ _: [app.dir, 'demo-light-nomusic'], 'poster-at': '1' }), { run: realRun, which: realWhich });
    assert.equal(r.ok, true, JSON.stringify(r));
    const pub = path.join(app.dir, 'public', 'video');
    const probe = await realRun('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'csv=p=0', path.join(pub, 'demo-light.mp4')]);
    assert.match(probe.stdout, /h264/);
    assert.match(probe.stdout, /aac/);
    const jpg = await readFile(path.join(pub, 'demo-light.jpg'));
    assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.match(await readFile(path.join(pub, 'demo.vtt'), 'utf8'), /Hello\./);

    // the loudness reading used by video-render works on the real tool's output
    const vol = await realRun('ffmpeg', ['-hide_banner', '-nostats', '-i', clip, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    const v = parseVolume(`${vol.stdout}\n${vol.stderr}`);
    assert.ok(v && Number.isFinite(v.meanDb) && Number.isFinite(v.maxDb), vol.stderr.slice(-300));
  } finally {
    await removeDir(app.parent);
  }
});
