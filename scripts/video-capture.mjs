#!/usr/bin/env node
// Records the real app for a video: starts the app on this computer, runs one capture file from video/capture/,
// and stops the app again. The capture file only opens practice pages on made-up data, so nothing signs in,
// nothing reaches a database, and every take comes out the same. Nothing here costs money or needs a key.
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { run as realRun } from './lib/run.mjs';
import * as log from './lib/log.mjs';
import { runCli, isMain, resolveAppDir, ProvisionError } from './provision/common.mjs';
import { ID_RE, VOICE_KEYS, requireVideoDir, pathExists, tailLines } from './video/common.mjs';
import { withApp as realWithApp, LOCAL_URL_RE, PAGE_RE } from './video/app-server.mjs';

const HELP = `
Record the real app for a video (real-app footage mode).

Usage:
  node video-capture.mjs <app-folder> <capture> [--page <path>] [--url <address>] [--json]

  <capture>  the capture file's name: video/capture/<capture>.mjs. It calls record() from ./record.mjs
             and reads the app's address from APP_URL.
  --page     the page to wait for before recording, for example /design-preview/video/board. Default: /
  --url      use an app that is already running on this computer (http://localhost:<port>) instead of
             starting it. For apps not built with Next.js: the student starts the app, you pass its address.

What it does: starts the app's own "next dev" on a free port with placeholder keys (so nothing real can be
reached), waits for the page, runs the capture file, and always stops the app again. The capture writes
video/public/capture/<name>.mp4 and video/src/captures/<name>.json. One capture at a time, in the foreground.
Exit code: 0 ok, 1 something to fix, 2 wrong options.
`;

const CAPTURE_TIMEOUT_MS = 20 * 60_000;
const MISSING_BROWSER_RE = /Executable doesn't exist|playwright install|looks like Playwright was just installed/i;

/** Captures (src/captures/*.json) written since `since` (ms): what this run made. */
export async function newCaptures(videoDir, since) {
  const dir = path.join(videoDir, 'src', 'captures');
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    const file = path.join(dir, n);
    if ((await stat(file)).mtimeMs < since) continue;
    try {
      const c = JSON.parse(await readFile(file, 'utf8'));
      out.push({
        name: c.name ?? n.slice(0, -5),
        seconds: typeof c.duration === 'number' ? Math.round(c.duration * 10) / 10 : null,
        steps: Array.isArray(c.steps) ? c.steps.map((s) => s.id) : [],
        size: c.w && c.h ? `${c.w}x${c.h}` : null,
        failed: c.failed ?? null,
        mp4: path.join(videoDir, 'public', 'capture', `${c.name ?? n.slice(0, -5)}.mp4`),
      });
    } catch {
      out.push({ name: n.slice(0, -5), failed: 'its JSON file could not be read' });
    }
  }
  return out;
}

export async function main(args, deps = {}) {
  const { run = realRun, withApp = realWithApp, now = () => Date.now() } = deps;
  if (args._.length !== 2) throw new log.UsageError('Give the app folder and the capture, for example: node video-capture.mjs ./recipe-box board');
  const name = String(args._[1]).replace(/\.mjs$/, '');
  if (!ID_RE.test(name) || name === 'record') throw new log.UsageError('The capture name can use letters, numbers, dashes and underscores only (the file is video/capture/<name>.mjs).');
  const page = args.page ?? '/';
  if (!PAGE_RE.test(page)) throw new log.UsageError('--page must be a path inside the app that starts with /, for example /design-preview/video/board.');
  if (args.url !== undefined && !LOCAL_URL_RE.test(args.url)) {
    throw new log.UsageError('--url must be an address on this computer, like http://localhost:3000. Never record a live site.');
  }

  const appDir = await resolveAppDir(args._[0]);
  const videoDir = await requireVideoDir(appDir);
  const captureFile = path.join(videoDir, 'capture', `${name}.mjs`);
  if (!(await pathExists(path.join(videoDir, 'capture', 'record.mjs')))) {
    throw new ProvisionError('The video folder has no capture/record.mjs. Run video-setup.mjs with --update to refresh the engine files.');
  }
  if (!(await pathExists(captureFile))) {
    throw new ProvisionError(`There is no capture file at video/capture/${name}.mjs yet. Write it first (one record() call per take), as the video skill's footage guide shows.`);
  }
  try {
    createRequire(path.join(videoDir, 'capture', 'record.mjs')).resolve('playwright');
  } catch {
    throw new ProvisionError('Playwright (the tool that drives the browser) is not installed where the capture can find it. Run npm install in the app folder (Shipyard apps include it), then try again.');
  }

  const since = now();
  const record = async (base) => {
    log.info(`Recording "${name}" from ${base}${page}. This takes as long as the takes themselves, plus encoding...`);
    // The capture needs no keys: none of the voice keys reach it, even when they are set in the shell.
    const env = { APP_URL: base, ...Object.fromEntries(VOICE_KEYS.map((k) => [k, undefined])) };
    return run('node', [path.posix.join('capture', `${name}.mjs`)], { cwd: videoDir, env, timeoutMs: CAPTURE_TIMEOUT_MS, quiet: !!args.json });
  };
  const r = args.url ? await record(args.url.replace(/\/$/, '')) : await withApp({ appDir, page, fn: record });

  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    if (MISSING_BROWSER_RE.test(text)) {
      throw new ProvisionError('The browser for recording is not installed yet. Run this once in the app folder: npx playwright install chromium. Then try again.');
    }
    throw new ProvisionError(`The capture failed. Last lines:\n${tailLines(text, 8)}`);
  }
  const captures = await newCaptures(videoDir, since - 1000);
  if (!captures.length) throw new ProvisionError(`The capture ran but wrote nothing to video/src/captures/. Check that video/capture/${name}.mjs calls record(). Last lines:\n${tailLines(text, 6)}`);
  const failed = captures.filter((c) => c.failed);
  for (const c of captures) {
    if (c.failed) log.fail(`${c.name}: stopped at step ${c.failed}. A screenshot of that moment is in video/out/.capture/${c.name}/ (open it).`);
    else log.ok(`${c.name}: ${c.seconds} s, ${c.steps.length} steps (${c.steps.join(', ')}), ${c.size}: ${c.mp4}`);
  }
  if (!failed.length) log.info('Next: build the scenes with <Footage>, one step per scene, then look at stills.');
  return { ok: failed.length === 0, captures, ...(failed.length ? { error: `${failed.length} take(s) stopped early.` } : {}) };
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['page', 'url'] }, help: HELP, main });
}
