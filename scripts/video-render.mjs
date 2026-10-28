#!/usr/bin/env node
// Renders one or more cuts of a video (light, dark, phone, silent), checks each for frozen stretches and loudness,
// and makes a contact sheet picture (one frame per scene) to look at.
import os from 'node:os';
import path from 'node:path';
import { run as realRun, which as realWhich } from './lib/run.mjs';
import * as log from './lib/log.mjs';
import { runCli, isMain, resolveAppDir, ProvisionError } from './provision/common.mjs';
import { requireVideoDir, pathExists, checkMediaTools, mediaToolsError } from './video/common.mjs';
import {
  parseSpec, renderOne, parseVolume, volumeNotes, freeBytes as realFreeBytes, cleanBundles, MIN_FREE_BYTES,
} from './video/render-lib.mjs';

const HELP = `
Render your video.

Usage:
  node video-render.mjs <app-folder> <cut> [<cut> ...] [--strict] [--low-memory] [--json]

A cut is <tag>:<light|dark>[:<music>][:silent][:vertical]. Examples:
  acme:light             wide video, light theme, with the voice
  acme:dark              dark theme
  acme:light::vertical   phone (9:16) cut
  acme:light::silent     no voice; captions are shown on screen
(<tag> is the name you gave the voice step. The built-in example is "acme".)

Cuts are rendered one after the other (never at the same time). Each one is checked for dead air (a frozen
stretch over half a second) and for loudness, and gets a contact sheet: a picture with one frame per scene.
Look at that picture before you call the video done.

  --strict       treat dead air as a failure
  --low-memory   render one frame at a time with a smaller frame cache: slower, for long real-app footage or a
                 computer short of memory
  --json         print the result as JSON
A render does not start with less than 3 GB of free disk. Remotion's working folder for each render (about 250 MB)
is removed from the temp folder afterwards.
Output goes to <app>/video/out/. Delete old renders when you are done: each is several MB.
Exit code: 0 ok, 1 a render failed, 2 wrong options.
`;

export async function main(args, deps = {}) {
  const { run = realRun, which = realWhich, freeBytes = realFreeBytes, tmpRoot = os.tmpdir(), now = () => Date.now() } = deps;
  if (args._.length < 2) throw new log.UsageError('Give the app folder and at least one cut, for example: node video-render.mjs ./recipe-box launch:light');
  const [dir, ...specs] = args._;
  const parsed = specs.map((s) => ({ spec: s, ...parseSpec(s) })); // bad names stop here, before anything runs
  const appDir = await resolveAppDir(dir);
  const videoDir = await requireVideoDir(appDir);
  const media = await checkMediaTools(which);
  if (!media.ok) throw mediaToolsError(media);

  for (const p of parsed) {
    if (!(await pathExists(path.join(videoDir, 'src', 'timelines', `${p.tag}.json`)))) {
      throw new ProvisionError(`There is no voice and timing for "${p.tag}" yet (video/src/timelines/${p.tag}.json). Run video-voice.mjs --tag ${p.tag} first.`);
    }
  }

  const results = [];
  for (const [i, p] of parsed.entries()) {
    log.step(i + 1, parsed.length, `Rendering ${p.spec} (one at a time; a short video takes about a minute)...`);
    const free = await freeBytes(videoDir);
    if (free !== null && free < MIN_FREE_BYTES) {
      const r = { ok: false, spec: p.spec, name: null, error: `Only ${(free / 1e9).toFixed(1)} GB of disk space is free, and a render needs at least 3 GB to work in. Delete old renders in video/out/ and empty the bin, then try again.` };
      results.push(r);
      log.fail(`${p.spec}: ${r.error}`);
      continue;
    }
    const started = now();
    const r = await renderOne({ run, videoDir, spec: p.spec, strict: !!args.strict, quiet: !!args.json, lowMemory: !!args['low-memory'] });
    await cleanBundles({ tmpRoot, since: started - 1000 });
    if (r.ok && !p.silent) {
      // Loudness. A cut with no audio track at all just gives no reading.
      const v = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', r.mp4, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 });
      r.volume = v.code === 0 ? parseVolume(`${v.stdout}\n${v.stderr}`) : null;
      r.notes = volumeNotes(r.volume);
    }
    results.push(r);
    if (!r.ok) {
      log.fail(`${p.spec}: ${r.error}`);
      continue;
    }
    log.ok(`${r.name}.mp4 (${r.seconds ?? '?'} s to render, ${r.sizeMb} MB): ${r.mp4}`);
    if (r.sheet) log.ok(`Contact sheet, look at it now: ${r.sheet}`);
    else log.warn('No contact sheet was made.');
    if (r.deadAir) log.warn(`${r.deadAir}`);
    else log.ok('No frozen stretch over half a second.');
    if (r.volume) log.info(`Sound: average ${r.volume.meanDb} dB, loudest ${r.volume.maxDb} dB.`);
    for (const n of r.notes) log.warn(n);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) log.fail(`${failed.length} of ${results.length} cuts failed.`);
  return { ok: failed.length === 0, renders: results };
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { boolean: ['strict', 'low-memory'] }, help: HELP, main });
}
