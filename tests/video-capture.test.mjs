import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, newCaptures } from '../scripts/video-capture.mjs';
import { withApp, explainPageStatus, LOCAL_URL_RE, PAGE_RE } from '../scripts/video/app-server.mjs';
import { makeFakeApp, removeDir, put, fakeRun } from './video-helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'video-capture.mjs');
const args = (o = {}) => ({ _: [], json: true, ...o });

/** A set-up app with the engine's recorder, one capture file and Playwright where the capture can find it. */
async function fixture({ playwright = true } = {}) {
  const app = await makeFakeApp({ withVideo: true });
  const v = path.join(app.dir, 'video');
  await put(v, 'capture/record.mjs', '// engine recorder stand-in\n');
  await put(v, 'capture/board.mjs', '// capture stand-in\n');
  if (playwright) {
    await put(app.dir, 'node_modules/playwright/package.json', '{"name":"playwright","main":"index.js"}');
    await put(app.dir, 'node_modules/playwright/index.js', 'module.exports = {};\n');
  }
  return { app, v };
}

/** run() that answers like a capture file: writes the capture JSON (and mp4) that record() writes. */
const captureRun = ({ failed = null, code = 0, stderr = '' } = {}) => fakeRun(async (cmd, a, opts) => {
  if (code) return { code, stderr };
  await put(opts.cwd, 'src/captures/board-laptop-light.json', JSON.stringify({
    name: 'board-laptop-light', w: 1960, h: 2300, css: { width: 980, height: 1150 }, dpr: 2, fps: 30, duration: 21.37, failed,
    steps: [{ id: 'hook', t0: 0, t1: 3 }, { id: 'add', t0: 3, t1: 9 }], events: [],
  }));
  await put(opts.cwd, 'public/capture/board-laptop-light.mp4', 'mp4');
  return { stdout: 'board-laptop-light: 640 frames, 21.4 s, 2 steps\n' };
});

/** withApp() stand-in: no real server, records what it was asked for. */
function fakeWithApp() {
  const calls = [];
  const fn = async ({ appDir, page, fn: inner }) => {
    calls.push({ appDir, page });
    return inner('http://127.0.0.1:43210');
  };
  fn.calls = calls;
  return fn;
}

test('records: starts the app, waits for the page, runs the capture in video/ with APP_URL and no keys, reports the takes', async () => {
  const { app, v } = await fixture();
  try {
    const run = captureRun();
    const withAppFake = fakeWithApp();
    const r = await main(args({ _: [app.dir, 'board'], page: '/design-preview/video/board' }), { run, withApp: withAppFake });
    assert.equal(r.ok, true);
    assert.deepEqual(withAppFake.calls, [{ appDir: app.dir, page: '/design-preview/video/board' }]);
    const [call] = run.calls;
    assert.equal(call.cmd, 'node');
    assert.deepEqual(call.args, ['capture/board.mjs']);
    assert.equal(call.cwd, v);
    assert.equal(call.env.APP_URL, 'http://127.0.0.1:43210');
    for (const k of ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY']) {
      assert.ok(k in call.env && call.env[k] === undefined, `${k} is dropped from the capture's environment`);
    }
    assert.equal(r.captures[0].name, 'board-laptop-light');
    assert.deepEqual(r.captures[0].steps, ['hook', 'add']);
    assert.equal(r.captures[0].seconds, 21.4);
    assert.match(r.captures[0].mp4, /video\/public\/capture\/board-laptop-light\.mp4$/);
  } finally {
    await removeDir(app.parent);
  }
});

test('--url uses an app that is already running here, without starting one; a live site is refused', async () => {
  const { app } = await fixture();
  try {
    const run = captureRun();
    const withAppFake = fakeWithApp();
    const r = await main(args({ _: [app.dir, 'board.mjs'], url: 'http://localhost:5173/' }), { run, withApp: withAppFake });
    assert.equal(r.ok, true);
    assert.equal(withAppFake.calls.length, 0);
    assert.equal(run.calls[0].env.APP_URL, 'http://localhost:5173');
    await assert.rejects(main(args({ _: [app.dir, 'board'], url: 'https://myapp.example.com' }), { run, withApp: withAppFake }), /on this computer/);
    await assert.rejects(main(args({ _: [app.dir, 'board'], url: 'http://localhost.example.com' }), { run, withApp: withAppFake }), /on this computer/);
  } finally {
    await removeDir(app.parent);
  }
});

test('a take that stopped early is a failure that points at its screenshot', async () => {
  const { app } = await fixture();
  try {
    const r = await main(args({ _: [app.dir, 'board'] }), { run: captureRun({ failed: 'add: no box for [data-add]' }), withApp: fakeWithApp() });
    assert.equal(r.ok, false);
    assert.match(r.error, /stopped early/);
    assert.equal(r.captures[0].failed, 'add: no box for [data-add]');
  } finally {
    await removeDir(app.parent);
  }
});

test('plain errors: bad names, no capture file, no recorder, no Playwright, no browser, a failing capture', async () => {
  const { app, v } = await fixture();
  const bare = await fixture({ playwright: false });
  try {
    const deps = { run: captureRun(), withApp: fakeWithApp() };
    await assert.rejects(main(args({ _: [app.dir, '../x'] }), deps), /capture name/);
    await assert.rejects(main(args({ _: [app.dir, 'record'] }), deps), /capture name/);
    await assert.rejects(main(args({ _: [app.dir, 'board'], page: 'design-preview' }), deps), /--page/);
    await assert.rejects(main(args({ _: [app.dir, 'other'] }), deps), /no capture file at video\/capture\/other\.mjs/);
    await assert.rejects(main(args({ _: [bare.app.dir, 'board'] }), deps), /npm install in the app folder/);
    await assert.rejects(main(args({ _: [app.dir, 'board'] }), { ...deps, run: captureRun({ code: 1, stderr: "browserType.launch: Executable doesn't exist at /x" }) }), /npx playwright install chromium/);
    await assert.rejects(main(args({ _: [app.dir, 'board'] }), { ...deps, run: captureRun({ code: 1, stderr: 'TypeError: h.clik is not a function' }) }), /capture failed[\s\S]*h\.clik/);
    await assert.rejects(main(args({ _: [app.dir, 'board'] }), { ...deps, run: fakeRun() }), /wrote nothing/);
    const { rm } = await import('node:fs/promises');
    await rm(path.join(v, 'capture', 'record.mjs'));
    await assert.rejects(main(args({ _: [app.dir, 'board'] }), deps), /--update/);
  } finally {
    await removeDir(app.parent);
    await removeDir(bare.app.parent);
  }
});

test('page answers: ready, missing, behind sign-in; addresses and paths are checked', async () => {
  assert.equal(explainPageStatus(200, null, '/x'), null);
  assert.match(explainPageStatus(404, null, '/design-preview/video/board'), /does not exist/);
  assert.match(explainPageStatus(307, '/sign-in', '/x'), /sign-in[\s\S]*without signing in/);
  assert.ok(LOCAL_URL_RE.test('http://127.0.0.1:3000') && LOCAL_URL_RE.test('http://[::1]:3000/') && LOCAL_URL_RE.test('http://localhost'));
  assert.ok(!LOCAL_URL_RE.test('http://localhost.evil.test') && !LOCAL_URL_RE.test('file:///etc/passwd'));
  assert.ok(PAGE_RE.test('/design-preview/video/board?theme=dark') && !PAGE_RE.test('/x y') && !PAGE_RE.test('http://x'));
});

test('withApp: an app without Next.js installed says to pass --url', async () => {
  const { app } = await fixture();
  try {
    await assert.rejects(withApp({ appDir: app.dir, fn: async () => {} }), /Next\.js is not installed[\s\S]*--url/);
  } finally {
    await removeDir(app.parent);
  }
});

test('newCaptures lists only what this run wrote', async () => {
  const { app, v } = await fixture();
  try {
    await put(v, 'src/captures/old.json', '{"name":"old","steps":[]}');
    const since = Date.now() + 5_000;
    assert.deepEqual(await newCaptures(v, since), []);
    assert.equal((await newCaptures(v, 0)).length, 1);
  } finally {
    await removeDir(app.parent);
  }
});

test('CLI: --help is 0, wrong arguments are 2', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /real-app footage/);
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
