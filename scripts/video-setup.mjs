#!/usr/bin/env node
// Sets up the video tools inside an app: <app>/video/ (a small Remotion project). Nothing here costs money or needs a key.
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { run as realRun, which as realWhich } from './lib/run.mjs';
import * as log from './lib/log.mjs';
import { runCli, isMain, resolveAppDir, readAppConfig, updateAppConfig, ProvisionError } from './provision/common.mjs';
import {
  ENGINE_REPO, ENGINE_SHA, MIN_NODE_MAJOR, SMOKE_SPEC, videoDirOf, pathExists, checkMediaTools, mediaToolsError, tailLines,
  requireVideoApp,
} from './video/common.mjs';
import { fetchEngine as realFetchEngine, copyEngine, cleanup } from './video/engine.mjs';
import { patchAppForVideo } from './video/app-patches.mjs';
import { renderOne } from './video/render-lib.mjs';
import { INSTALL, osName } from './check-tools.mjs';

const HELP = `
Set up the video tools in your app (a folder called video/).

Usage:
  node video-setup.mjs <app-folder> [--update] [--no-install] [--no-smoke] [--general] [--json]

  --update      refresh the video engine files to the version Shipyard expects. Your own scenes, scripts,
                voices and product list are never touched.
  --no-install  copy the files but do not run npm install
  --no-smoke    skip the test render of the built-in example (about 35 seconds)
  --general     the app was not made by Shipyard and has been brought up to the Shipyard standard
                (new-app upgrade guide). Nothing is written to .shipyard-app.json then.
  --json        print the result as JSON

What it does: checks Node and ffmpeg, copies the video engine (one fixed, tested version) into <app>/video/,
installs its packages (once; a few hundred MB), then renders a small made-up example video with no keys, as a
check that everything works. It prints where the contact sheet (a picture with one frame per scene) is.
It also adds the video folder to the app's tsconfig and lint ignore lists, so the app's own checks skip it.
Exit code: 0 ok, 1 something to fix, 2 wrong options.
`;

const SETUP_FILE = '.shipyard-video.json';

export async function main(args, deps = {}) {
  const {
    run = realRun,
    which = realWhich,
    platform = process.platform,
    nodeVersion = process.version,
    fetchEngine = realFetchEngine,
    tmpRoot = os.tmpdir(),
    now = () => new Date(),
  } = deps;

  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node video-setup.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const app = await requireVideoApp(appDir, { general: !!args.general }); // plain error otherwise
  const videoDir = videoDirOf(appDir);
  const total = 5;

  // 1. Tools
  log.step(1, total, 'Checking Node and ffmpeg...');
  const major = Number(/^v?(\d+)/.exec(String(nodeVersion))?.[1] ?? 0);
  if (major < MIN_NODE_MAJOR) {
    throw new ProvisionError(`Node ${String(nodeVersion).replace(/^v/, '')} is too old for the video tools (they need ${MIN_NODE_MAJOR} or newer). Install it with: ${INSTALL.node[osName(platform)]}`);
  }
  const media = await checkMediaTools(which, platform);
  if (!media.ok) throw mediaToolsError(media);
  log.ok('Node and ffmpeg are ready.');

  const alreadyThere = await pathExists(path.join(videoDir, 'package.json'));
  const state = !alreadyThere ? 'fresh' : args.update ? 'updated' : 'already';
  const result = {
    ok: true,
    appDir,
    videoDir,
    app,
    engine: { repo: ENGINE_REPO, sha: ENGINE_SHA },
    state,
    copied: 0,
    kept: 0,
    patches: [],
    install: 'skipped',
    smoke: null,
    next: [],
  };

  // 2. Engine files
  if (state === 'already') {
    log.step(2, total, 'The video folder is already set up. (Use --update to refresh the engine files; your own work is never touched.)');
  } else {
    log.step(2, total, state === 'fresh' ? 'Downloading the video engine (one fixed version)...' : 'Refreshing the video engine files...');
    const work = await mkdtemp(path.join(tmpRoot, 'shipyard-video-'));
    try {
      const engineRoot = await fetchEngine({ run, workDir: work });
      const copy = await copyEngine({ engineRoot, dest: videoDir, update: state === 'updated' });
      result.copied = copy.copied.length;
      result.kept = copy.kept.length;
      const stamp = now().toISOString();
      let setupAt = stamp;
      if (state === 'updated') {
        try {
          setupAt = JSON.parse(await readFile(path.join(videoDir, SETUP_FILE), 'utf8')).setupAt ?? stamp;
        } catch {
          // no earlier record: use now
        }
      }
      await writeFile(path.join(videoDir, SETUP_FILE), `${JSON.stringify({ engineRepo: ENGINE_REPO, engineSha: ENGINE_SHA, app, setupAt, updatedAt: stamp }, null, 2)}\n`);
      if (app === 'shipyard') {
        const config = await readAppConfig(appDir);
        await updateAppConfig(appDir, { video: { ...(config.video ?? {}), engineSha: ENGINE_SHA, setupAt } });
      }
    } finally {
      await cleanup(work);
    }
    log.ok(state === 'fresh'
      ? `Copied the video engine into video/ (${result.copied} files).`
      : `Refreshed ${result.copied} engine files. Kept ${result.kept} of your own files as they were.`);
  }

  // 3. Keep the app's own checks away from the video folder
  log.step(3, total, 'Making the app\'s checks skip the video folder...');
  result.patches = await patchAppForVideo(appDir);
  for (const p of result.patches) {
    if (p.status === 'patched') log.ok(`${p.file}: ${p.note}`);
    else if (p.status === 'manual') {
      log.warn(`${p.file}: ${p.note}`);
      result.next.push(p.note);
    }
  }
  if (result.patches.every((p) => p.status === 'already' || p.status === 'missing')) log.ok('Already in place.');

  // 4. Install packages
  const needsInstall = !(await pathExists(path.join(videoDir, 'node_modules')));
  if (args['no-install']) {
    log.step(4, total, 'Skipping npm install (--no-install).');
  } else if (state === 'already' && !needsInstall) {
    log.step(4, total, 'The video packages are already installed.');
  } else {
    log.step(4, total, 'Installing the video packages. This downloads a few hundred MB once, so it can take a few minutes...');
    const inst = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: videoDir, quiet: !!args.json, timeoutMs: 20 * 60_000 });
    if (inst.code !== 0) {
      result.install = 'failed';
      throw new ProvisionError(
        `npm install did not finish. Check your internet connection and run this again.\n${tailLines(`${inst.stdout}\n${inst.stderr}`, 6)}`,
        { ...result, ok: false },
      );
    }
    result.install = 'done';
    log.ok('Video packages installed.');
  }

  // 5. Smoke render: the committed example voice, no keys
  const canSmoke = !args['no-install'] && !args['no-smoke'] && (state !== 'already' || result.install === 'done');
  if (!canSmoke) {
    log.step(5, total, 'Skipping the test render.');
  } else {
    log.step(5, total, 'Test render of the built-in example (about 35 seconds; the first time it may also download a small browser)...');
    const r = await renderOne({ run, videoDir, spec: SMOKE_SPEC, quiet: !!args.json });
    result.smoke = r;
    if (!r.ok) {
      throw new ProvisionError(`The test render did not work. ${r.error}`, { ...result, ok: false });
    }
    log.ok(`Test render worked: ${r.mp4}`);
    if (r.sheet) log.ok(`Contact sheet (one frame per scene, open it to see the example): ${r.sheet}`);
    if (r.deadAir) log.warn(r.deadAir);
  }

  result.next.push('Next: study the app, write the narration script and show it to the student for approval (nothing costs money until the voice step).');
  if (state === 'already') log.info('Nothing to do: the video tools were already set up.');
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { boolean: ['update', 'no-install', 'no-smoke', 'general'] }, help: HELP, main });
}
