import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/video-setup.mjs';
import { patchAppForVideo, patchProxyForVideo } from '../scripts/video/app-patches.mjs';
import { ENGINE_SHA } from '../scripts/video/common.mjs';
import { tempDir, removeDir, makeFakeEngine, makeFakeApp, fakeRun, whichAll, whichNone, put } from './video-helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'video-setup.mjs');
const exists = (p) => stat(p).then(() => true, () => false);
const args = (o = {}) => ({ _: [], update: false, 'no-install': false, 'no-smoke': false, json: true, ...o });

/** run() that answers like npm and the engine's render script would. */
function setupRun({ renderOk = true, installOk = true } = {}) {
  return fakeRun(async (cmd, a, opts) => {
    if (cmd === 'npm') {
      if (!installOk) return { code: 1, stderr: 'npm ERR! network' };
      await mkdir(path.join(opts.cwd, 'node_modules'), { recursive: true });
      return {};
    }
    if (cmd === 'node' && a[0] === 'scripts/render.mjs') {
      if (!renderOk) return { code: 1, stderr: 'Error: browser failed to start' };
      await put(opts.cwd, 'out/acme-light-nomusic.mp4', 'mp4');
      await put(opts.cwd, 'out/sheet-acme-light-nomusic.jpg', 'jpg');
      return { stdout: 'acme-light-nomusic.mp4 rendered in 31 s\nacme-light-nomusic.mp4: no frozen stretch over 0.5 s\n' };
    }
    return {};
  });
}

async function withFixture(fn) {
  const engine = await makeFakeEngine();
  const app = await makeFakeApp();
  try {
    await fn({ engine, app, fetchEngine: async () => engine.root });
  } finally {
    await removeDir(engine.base);
    await removeDir(app.parent);
  }
}

const deps = (run, fetchEngine, over = {}) => ({ run, which: whichAll, fetchEngine, platform: 'darwin', nodeVersion: 'v22.4.0', ...over });

test('fresh setup: copies the engine, patches the app, installs, runs the smoke render, records the pin', async () => {
  await withFixture(async ({ app, fetchEngine }) => {
    const run = setupRun();
    const r = await main(args({ _: [app.dir] }), deps(run, fetchEngine));
    assert.equal(r.ok, true);
    assert.equal(r.state, 'fresh');
    assert.equal(r.install, 'done');
    assert.equal(r.smoke.ok, true);
    assert.match(r.smoke.sheet, /sheet-acme-light-nomusic\.jpg$/);
    assert.equal(r.engine.sha, ENGINE_SHA);

    const v = path.join(app.dir, 'video');
    assert.ok(await exists(path.join(v, 'package.json')));
    assert.ok(await exists(path.join(v, 'src/acme/Demo.tsx')));
    assert.ok(!(await exists(path.join(v, 'src/zeta'))), 'other examples are not copied');
    assert.ok(!(await exists(path.join(v, '.env.example'))));
    const gi = await readFile(path.join(v, '.gitignore'), 'utf8');
    for (const line of ['node_modules/', 'out/', '.env*', 'public/voice/_raw/']) assert.ok(gi.includes(line), line);

    const cmds = run.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    assert.ok(cmds.includes('npm install --no-audit --no-fund'));
    assert.ok(cmds.includes('node scripts/render.mjs acme:light'));
    assert.ok(run.calls.filter((c) => c.cmd === 'npm' || c.args[0] === 'scripts/render.mjs').every((c) => c.cwd === v), 'runs inside video/');
    // nothing secret anywhere on a command line
    assert.ok(run.calls.every((c) => c.env === undefined || !Object.keys(c.env).some((k) => /KEY|TOKEN|SECRET/.test(k))));

    const cfg = JSON.parse(await readFile(path.join(app.dir, '.shipyard-app.json'), 'utf8'));
    assert.equal(cfg.video.engineSha, ENGINE_SHA);
    assert.ok(cfg.video.setupAt);
    assert.equal(cfg.slug, 'recipe-box', 'the rest of the app config is kept');
    const pin = JSON.parse(await readFile(path.join(v, '.shipyard-video.json'), 'utf8'));
    assert.equal(pin.engineSha, ENGINE_SHA);

    const ts = await readFile(path.join(app.dir, 'tsconfig.json'), 'utf8');
    assert.match(ts, /"exclude": \["node_modules", "video"\]/);
    assert.match(await readFile(path.join(app.dir, 'eslint.config.mjs'), 'utf8'), /"video\/\*\*"/);
  });
});

test('re-running without --update changes nothing and does not download again', async () => {
  await withFixture(async ({ app, fetchEngine }) => {
    await main(args({ _: [app.dir] }), deps(setupRun(), fetchEngine));
    await put(path.join(app.dir, 'video'), 'src/scripts/launch.json', 'MINE');
    let fetched = 0;
    const run = setupRun();
    const r = await main(args({ _: [app.dir] }), deps(run, async () => { fetched++; throw new Error('should not fetch'); }));
    assert.equal(r.state, 'already');
    assert.equal(fetched, 0);
    assert.equal(run.calls.length, 0, 'no install and no render when everything is already there');
    assert.equal(await readFile(path.join(app.dir, 'video/src/scripts/launch.json'), 'utf8'), 'MINE');
  });
});

test('a half-finished setup (files copied, packages missing) installs on the next run', async () => {
  await withFixture(async ({ app, fetchEngine }) => {
    await main(args({ _: [app.dir], 'no-install': true }), deps(setupRun(), fetchEngine));
    assert.ok(!(await exists(path.join(app.dir, 'video/node_modules'))));
    const run = setupRun();
    const r = await main(args({ _: [app.dir] }), deps(run, fetchEngine));
    assert.equal(r.state, 'already');
    assert.equal(r.install, 'done');
    assert.ok(r.smoke?.ok, 'and it proves it works with the smoke render');
  });
});

test('--update refreshes the engine and keeps the student\'s work', async () => {
  await withFixture(async ({ app, engine, fetchEngine }) => {
    await main(args({ _: [app.dir] }), deps(setupRun(), fetchEngine));
    const v = path.join(app.dir, 'video');
    await put(v, 'src/mine/Demo.tsx', 'MY SCENES');
    await put(v, 'src/scripts/launch.json', 'MY SCRIPT');
    await put(v, 'src/products.json', '{"Mine":{}}');
    await put(engine.root, 'scripts/render.mjs', '// NEW\n');
    const r = await main(args({ _: [app.dir], update: true }), deps(setupRun(), fetchEngine));
    assert.equal(r.state, 'updated');
    assert.equal(await readFile(path.join(v, 'scripts/render.mjs'), 'utf8'), '// NEW\n');
    assert.equal(await readFile(path.join(v, 'src/mine/Demo.tsx'), 'utf8'), 'MY SCENES');
    assert.equal(await readFile(path.join(v, 'src/scripts/launch.json'), 'utf8'), 'MY SCRIPT');
    assert.equal(await readFile(path.join(v, 'src/products.json'), 'utf8'), '{"Mine":{}}');
    const cfg = JSON.parse(await readFile(path.join(app.dir, '.shipyard-app.json'), 'utf8'));
    assert.ok(cfg.video.setupAt, 'the first setup time is kept');
  });
});

test('missing ffmpeg: stops before downloading anything, with the install line', async () => {
  await withFixture(async ({ app }) => {
    const run = setupRun();
    await assert.rejects(main(args({ _: [app.dir] }), deps(run, async () => { throw new Error('no'); }, { which: whichNone, platform: 'darwin' })),
      /ffmpeg and ffprobe are not installed[\s\S]*brew install ffmpeg/);
    assert.equal(run.calls.length, 0);
    assert.ok(!(await exists(path.join(app.dir, 'video'))));
  });
});

test('old Node: plain error with the install line', async () => {
  await withFixture(async ({ app, fetchEngine }) => {
    await assert.rejects(main(args({ _: [app.dir] }), deps(setupRun(), fetchEngine, { nodeVersion: 'v18.20.0' })), /too old for the video tools/);
  });
});

test('not a Shipyard app: plain error', async () => {
  const dir = await tempDir('not-an-app-');
  try {
    await assert.rejects(main(args({ _: [dir] }), deps(setupRun(), async () => '')), /was not made by Shipyard/);
  } finally {
    await removeDir(dir);
  }
});

test('npm install failing is reported plainly and says what to do', async () => {
  await withFixture(async ({ app, fetchEngine }) => {
    await assert.rejects(main(args({ _: [app.dir] }), deps(setupRun({ installOk: false }), fetchEngine)), /npm install did not finish[\s\S]*internet connection/);
  });
});

test('a failing smoke render is an error, not a silent success', async () => {
  await withFixture(async ({ app, fetchEngine }) => {
    await assert.rejects(main(args({ _: [app.dir] }), deps(setupRun({ renderOk: false }), fetchEngine)), /test render did not work/);
  });
});

test('--no-smoke and --no-install skip those steps', async () => {
  await withFixture(async ({ app, fetchEngine }) => {
    const run = setupRun();
    const r = await main(args({ _: [app.dir], 'no-install': true, 'no-smoke': true }), deps(run, fetchEngine));
    assert.equal(r.install, 'skipped');
    assert.equal(r.smoke, null);
    assert.equal(run.calls.length, 0);
  });
});

test('app patches: tsconfig and eslint get the video folder once, never twice; real template text', async () => {
  const app = await makeFakeApp();
  try {
    const first = await patchAppForVideo(app.dir);
    assert.deepEqual(first.map((p) => p.status), ['patched', 'patched']);
    const second = await patchAppForVideo(app.dir);
    assert.deepEqual(second.map((p) => p.status), ['already', 'already']);
    const ts = JSON.parse(await readFile(path.join(app.dir, 'tsconfig.json'), 'utf8'));
    assert.deepEqual(ts.exclude, ['node_modules', 'video']);
    const es = await readFile(path.join(app.dir, 'eslint.config.mjs'), 'utf8');
    assert.equal(es.split('video/**').length - 1, 1);
    assert.match(es, /globalIgnores\(\[[^\]]*"\.shipyard\/\*\*", "video\/\*\*"\]\)/);
  } finally {
    await removeDir(app.parent);
  }
});

test('app patches: unfamiliar files get a plain manual instruction instead of a guess', async () => {
  const app = await makeFakeApp();
  try {
    await put(app.dir, 'tsconfig.json', '{ "compilerOptions": {} }');
    await put(app.dir, 'eslint.config.mjs', 'export default [];');
    const r = await patchAppForVideo(app.dir);
    assert.deepEqual(r.map((p) => p.status), ['manual', 'manual']);
    assert.match(r[0].note, /"exclude"/);
    assert.match(r[1].note, /video\/\*\*/);
    assert.equal(await readFile(path.join(app.dir, 'tsconfig.json'), 'utf8'), '{ "compilerOptions": {} }', 'unchanged');
  } finally {
    await removeDir(app.parent);
  }
});

test('proxy patch: video and caption files become public static types, once; template text', async () => {
  const app = await makeFakeApp();
  try {
    let before = await readFile(path.join(app.dir, 'src/proxy.ts'), 'utf8');
    if (/mp4/.test(before)) {
      // The template already lists video files: then the patch must leave it alone. Test the patch on the older text.
      before = before.replace('|mp4|webm|vtt', '').replace('|mp4|webm', '').replace('|mp4', '');
      await put(app.dir, 'src/proxy.ts', before);
    }
    const r = await patchProxyForVideo(app.dir);
    assert.equal(r.status, 'patched');
    const after = await readFile(path.join(app.dir, 'src/proxy.ts'), 'utf8');
    assert.match(after, /webmanifest\|txt\|xml\|mp4\|webm\|vtt\)\$/);
    assert.equal(after.length - before.length, '|mp4|webm|vtt'.length);
    assert.equal((await patchProxyForVideo(app.dir)).status, 'already');
    await put(app.dir, 'src/proxy.ts', 'export const config = { matcher: ["/(.*)"] };');
    assert.equal((await patchProxyForVideo(app.dir)).status, 'manual');
  } finally {
    await removeDir(app.parent);
  }
});

test('CLI: --help is 0, no folder is 2, --json errors are JSON', async () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const dir = await tempDir('not-an-app-');
  try {
    const r = spawnSync(process.execPath, [SCRIPT, dir, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /not made by Shipyard/);
  } finally {
    await removeDir(dir);
  }
});
