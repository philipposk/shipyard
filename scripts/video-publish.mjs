#!/usr/bin/env node
// Makes the web copy of a finished render: a small mp4 (under 10 MB), a poster picture and captions,
// into <app>/public/video/. Prints the snippet to paste into a page.
import path from 'node:path';
import { mkdir, stat, readFile, writeFile, readdir } from 'node:fs/promises';
import { run as realRun, which as realWhich } from './lib/run.mjs';
import * as log from './lib/log.mjs';
import { runCli, isMain, resolveAppDir, readAppConfig, updateAppConfig, ProvisionError } from './provision/common.mjs';
import { videoDirOf, PUBLISH_DIR, pathExists, checkMediaTools, mediaToolsError, tailLines, mb } from './video/common.mjs';
import {
  MAX_BYTES, encodeAttempts, buildEncodeArgs, buildPosterArgs, probeSizeArgs, probeDurationArgs, parseSize, parseDuration,
  defaultPosterAt, defaultWebName, WEB_NAME_RE, moveCuesToTop, jsxSnippet,
} from './video/encode.mjs';
import { patchProxyForVideo } from './video/app-patches.mjs';

const HELP = `
Make the web copy of a finished video and put it in your app.

Usage:
  node video-publish.mjs <app-folder> <render> [--name <file-name>] [--poster-at <seconds>] [--vtt <tag>]
                         [--captions-top] [--no-captions] [--max-mb <n>] [--no-patch] [--json]

  <render>        the render's name (like acme-light-nomusic) or its path inside video/out/
  --name          file name for the web copy, without extension. Default: demo-light, demo-dark, demo-light-phone...
                  Use plain names, not your product's name.
  --poster-at     second to take the poster picture from (pick a frame where the screen is full). Default: just under halfway.
  --vtt           tag whose captions file (video/out/<tag>.vtt) to copy. Default: found from the render's name.
  --captions-top  put the captions at the top of the picture (use when the video already shows text at the bottom)
  --no-captions   do not copy captions
  --max-mb        biggest allowed size in MB (default 10)
  --no-patch      do not change src/proxy.ts (see below)
  --json          print the result as JSON

Writes public/video/<name>.mp4, <name>.jpg and demo.vtt. It also lets signed-out visitors open mp4, webm and vtt files
by adding them to the static file types in src/proxy.ts (otherwise the proxy sends them to the sign-in page).
The voice is made by AI: keep the note "Narrated with an AI voice" next to the video.
Exit code: 0 ok, 1 something to fix, 2 wrong options.
`;

/** Where is the render? Accepts a name or a path, and only ever inside <app>/video/out/. */
export async function resolveRender(appDir, input) {
  const outDir = path.join(videoDirOf(appDir), 'out');
  const candidates = [];
  const raw = String(input);
  if (/\.mp4$/i.test(raw)) {
    candidates.push(path.resolve(raw), path.join(outDir, path.basename(raw)));
  } else {
    candidates.push(path.join(outDir, `${path.basename(raw)}.mp4`));
  }
  for (const c of candidates) {
    const rel = path.relative(outDir, c);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside video/out
    if (await pathExists(c)) return { file: c, name: path.basename(c, '.mp4'), outDir };
  }
  throw new ProvisionError(`Could not find that render in ${outDir}. Run video-render.mjs first, then use the name it printed (without .mp4).`);
}

/** The captions file that belongs to a render: out/<tag>.vtt where <tag> appears in the render's name (longest wins). */
export async function findCaptions(outDir, renderName, wantedTag) {
  if (wantedTag) {
    const f = path.join(outDir, `${wantedTag}.vtt`);
    return (await pathExists(f)) ? f : null;
  }
  let names = [];
  try {
    names = (await readdir(outDir)).filter((n) => n.endsWith('.vtt')).map((n) => n.slice(0, -4));
  } catch {
    return null;
  }
  const parts = `-${renderName}-`;
  const hits = names.filter((t) => parts.includes(`-${t}-`)).sort((a, b) => b.length - a.length);
  if (hits.length) return path.join(outDir, `${hits[0]}.vtt`);
  return names.length === 1 ? path.join(outDir, `${names[0]}.vtt`) : null;
}

export async function main(args, deps = {}) {
  const { run = realRun, which = realWhich } = deps;
  if (args._.length !== 2) throw new log.UsageError('Give the app folder and the render, for example: node video-publish.mjs ./recipe-box launch-light-nomusic');
  const maxMb = args['max-mb'] === undefined ? 10 : Number(args['max-mb']);
  if (!(maxMb >= 1 && maxMb <= 100)) throw new log.UsageError('--max-mb must be a number between 1 and 100.');
  const maxBytes = maxMb === 10 ? MAX_BYTES : maxMb * 1_000_000;
  let posterAtArg;
  if (args['poster-at'] !== undefined) {
    posterAtArg = Number(args['poster-at']);
    if (!(posterAtArg >= 0)) throw new log.UsageError('--poster-at must be a number of seconds, for example 12.5.');
  }
  if (args.name !== undefined && !WEB_NAME_RE.test(args.name)) {
    throw new log.UsageError('--name can use lower-case letters, numbers and dashes only (for example demo-light).');
  }
  if (args.vtt !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.vtt)) throw new log.UsageError('--vtt must be the tag you gave the voice step.');

  const appDir = await resolveAppDir(args._[0]);
  await readAppConfig(appDir);
  const media = await checkMediaTools(which);
  if (!media.ok) throw mediaToolsError(media);
  const render = await resolveRender(appDir, args._[1]);
  const base = args.name ?? defaultWebName(render.name);
  const publishDir = path.join(appDir, PUBLISH_DIR);
  await mkdir(publishDir, { recursive: true });

  // Size and length of the render
  const sizeOut = await run('ffprobe', probeSizeArgs(render.file), { timeoutMs: 60_000 });
  const size = parseSize(sizeOut.stdout);
  if (sizeOut.code !== 0 || !size) throw new ProvisionError('Could not read the picture size of that render. Is it a finished mp4?');
  const durOut = await run('ffprobe', probeDurationArgs(render.file), { timeoutMs: 60_000 });
  const duration = durOut.code === 0 ? parseDuration(durOut.stdout) : null;
  const vertical = size.height > size.width;
  const posterAt = posterAtArg ?? defaultPosterAt(duration);

  // Encode: the best quality that fits
  log.step(1, 3, `Making the web copy (${base}.mp4). Higher quality first, smaller until it fits under ${maxMb} MB...`);
  const outMp4 = path.join(publishDir, `${base}.mp4`);
  let final = null;
  const tried = [];
  for (const attempt of encodeAttempts()) {
    const r = await run('ffmpeg', buildEncodeArgs({ src: render.file, out: outMp4, crf: attempt.crf, shrink: attempt.shrink, vertical }), { timeoutMs: 30 * 60_000 });
    if (r.code !== 0) throw new ProvisionError(`ffmpeg could not make the web copy.\n${tailLines(`${r.stderr}`, 5)}`);
    const bytes = (await stat(outMp4)).size;
    tried.push({ crf: attempt.crf, shrink: attempt.shrink, mb: mb(bytes) });
    log.info(`quality ${attempt.crf}${attempt.shrink ? ' (smaller picture)' : ''}: ${mb(bytes)} MB`);
    final = { ...attempt, bytes };
    if (bytes <= maxBytes) break;
  }
  const fits = final.bytes <= maxBytes;
  if (fits) log.ok(`${path.join(PUBLISH_DIR, `${base}.mp4`)}: ${mb(final.bytes)} MB.`);
  else log.fail(`${base}.mp4 is still ${mb(final.bytes)} MB, over the ${maxMb} MB limit. Make the video shorter, or raise --max-mb if you are sure.`);

  // Poster
  log.step(2, 3, 'Making the poster picture...');
  const outJpg = path.join(publishDir, `${base}.jpg`);
  const p = await run('ffmpeg', buildPosterArgs({ src: render.file, out: outJpg, at: posterAt, vertical }), { timeoutMs: 120_000 });
  if (p.code !== 0) throw new ProvisionError(`ffmpeg could not make the poster picture. Try another --poster-at second.\n${tailLines(p.stderr, 4)}`);
  log.ok(`${path.join(PUBLISH_DIR, `${base}.jpg`)} (frame at ${posterAt} s). Open it: a poster should show the app, not a blank frame.`);

  // Captions
  log.step(3, 3, 'Captions and page settings...');
  let vttOut = null;
  const silentCut = /(?:^|-)silent(?:-|$)/.test(render.name);
  if (!args['no-captions'] && !silentCut) {
    const src = await findCaptions(render.outDir, render.name, args.vtt);
    if (src) {
      let text = await readFile(src, 'utf8');
      if (args['captions-top']) text = moveCuesToTop(text);
      vttOut = path.join(publishDir, 'demo.vtt');
      await writeFile(vttOut, text);
      log.ok(`${path.join(PUBLISH_DIR, 'demo.vtt')} (captions${args['captions-top'] ? ' at the top' : ''}).`);
    } else {
      log.warn('No captions file found for this render (video/out/<tag>.vtt). Pass --vtt <tag> if you want captions.');
    }
  } else if (silentCut) {
    log.info('This is the silent cut: its captions are in the picture, so no captions file is needed.');
  }

  let proxy = null;
  if (!args['no-patch']) {
    proxy = await patchProxyForVideo(appDir);
    if (proxy.status === 'patched') log.ok(`${proxy.file}: ${proxy.note}`);
    else if (proxy.status === 'manual') log.warn(`${proxy.file}: ${proxy.note}`);
  }

  // Remember what was published (no secrets; the settings page and later runs read this)
  const config = await readAppConfig(appDir);
  const published = (config.video?.published ?? []).filter((x) => x.name !== base);
  published.push({ name: base, file: `public/video/${base}.mp4`, poster: `public/video/${base}.jpg`, sizeMb: mb(final.bytes), render: render.name, at: new Date().toISOString() });
  await updateAppConfig(appDir, { video: { ...(config.video ?? {}), published } });

  const snippet = jsxSnippet({ base, captions: Boolean(vttOut), label: 'Product video' });
  log.info('');
  log.info('Paste this where the video should appear (change the label to describe your video):');
  for (const l of snippet.split('\n')) log.info(`  ${l}`);
  log.info('');
  log.info('Keep the "Narrated with an AI voice" note. The files in public/video/ are part of your app: save them to GitHub when you are happy (that is your call).');

  return {
    ok: fits,
    render: render.name,
    video: outMp4,
    poster: outJpg,
    captions: vttOut,
    sizeMb: mb(final.bytes),
    attempts: tried,
    posterAt,
    vertical,
    proxy,
    snippet,
    ...(fits ? {} : { error: `The web copy is ${mb(final.bytes)} MB, over the ${maxMb} MB limit.` }),
  };
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['name', 'poster-at', 'vtt', 'max-mb'], boolean: ['captions-top', 'no-captions', 'no-patch'] },
    help: HELP,
    main,
  });
}
