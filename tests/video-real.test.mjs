// Opt-in end-to-end test. Needs internet (downloads the pinned engine from GitHub and its npm packages), ffmpeg, and about
// 3 minutes. It uses NO keys: the built-in example's voice is committed. Run it with:
//   SHIPYARD_TEST_VIDEO=1 node --test tests/video-real.test.mjs
// Optional: SHIPYARD_TEST_VIDEO_DIR=<folder> chooses where the scratch app goes (default: the system temp folder);
//           SHIPYARD_TEST_VIDEO_KEEP=1 keeps the scratch app (without node_modules) so you can open the contact sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.SHIPYARD_TEST_VIDEO === '1';

test('real: scaffold an app, video-setup, keyless Acme smoke render, contact sheet', { skip: !enabled && 'set SHIPYARD_TEST_VIDEO=1 to run', timeout: 20 * 60_000 }, async () => {
  const base = await mkdtemp(path.join(process.env.SHIPYARD_TEST_VIDEO_DIR || os.tmpdir(), 'shipyard-video-real-'));
  const home = path.join(base, 'home');
  const env = { ...process.env, SHIPYARD_HOME: home };
  // The test must prove the example needs no keys: take any out of the environment.
  for (const k of ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY']) delete env[k];
  const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 15 * 60_000, ...opts });
  try {
    const sc = node([path.join(ROOT, 'scripts/scaffold.mjs'), 'video-real-app', '--name', 'Video Real App', '--description', 'A tiny app for the video test.', '--dir', base, '--json']);
    assert.equal(sc.status, 0, sc.stdout + sc.stderr);
    const app = path.join(base, 'video-real-app');

    const r = node([path.join(ROOT, 'scripts/video-setup.mjs'), app, '--json']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.state, 'fresh');
    assert.equal(out.install, 'done');
    assert.equal(out.smoke.ok, true);

    // The smoke render's files exist and look like a real video and a real picture.
    const mp4 = out.smoke.mp4;
    const sheet = out.smoke.sheet;
    assert.ok(sheet, 'a contact sheet path is reported');
    assert.ok((await stat(mp4)).size > 100_000, 'the mp4 is not empty');
    const jpg = await readFile(sheet);
    assert.ok(jpg.length > 5_000, 'the contact sheet is not empty');
    assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'the contact sheet is a JPEG');
    console.log(`CONTACT SHEET: ${sheet}`);

    // Only the neutral example came along, and nothing key-like was written.
    const v = path.join(app, 'video');
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(v, 'src/products.json'), 'utf8'))), ['Acme']);
    const top = await readdir(v);
    assert.ok(!top.some((n) => n.startsWith('.env')), top.join(','));
    const gitignore = await readFile(path.join(v, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.env\*/);

    // The app's own TypeScript check no longer looks into video/ (list the files tsc would read).
    const tsc = path.join(v, 'node_modules', 'typescript', 'bin', 'tsc');
    const realApp = await realpath(app);
    const list = spawnSync(process.execPath, [tsc, '-p', path.join(realApp, 'tsconfig.json'), '--listFilesOnly'], { encoding: 'utf8', env, cwd: realApp });
    const listed = list.stdout.split('\n').filter((l) => l.startsWith(realApp));
    assert.ok(listed.some((f) => f.startsWith(path.join(realApp, 'src'))), 'tsc listed the app files');
    // (TypeScript's own built-in library files live inside video/node_modules because that is the copy we ran. They are not ours.)
    const own = listed.filter((f) => f.startsWith(path.join(realApp, 'video')) && !f.startsWith(path.join(realApp, 'video', 'node_modules', 'typescript', 'lib')));
    assert.deepEqual(own, [], 'tsc must not read the video folder');

    // The app's key scanner finds nothing in the engine files (stage them in the scratch git only; nothing is committed).
    spawnSync('git', ['add', '-A'], { cwd: app, encoding: 'utf8' });
    const scan = spawnSync(process.execPath, [path.join(app, 'scripts/secret-scan.mjs'), '--staged'], { cwd: app, encoding: 'utf8', env });
    assert.equal(scan.status, 0, scan.stdout + scan.stderr);

    // Running it again is a no-op.
    const again = JSON.parse(node([path.join(ROOT, 'scripts/video-setup.mjs'), app, '--json']).stdout);
    assert.equal(again.state, 'already');
  } finally {
    if (process.env.SHIPYARD_TEST_VIDEO_KEEP === '1') {
      await rm(path.join(base, 'video-real-app', 'video', 'node_modules'), { recursive: true, force: true });
      console.log(`KEPT: ${base}`);
    } else {
      await rm(base, { recursive: true, force: true });
    }
  }
});
