// Running one engine render and reading its result. Used by video-render.mjs and by the smoke render in video-setup.mjs.
import os from 'node:os';
import path from 'node:path';
import { pathExists, tailLines, mb } from './common.mjs';
import { ProvisionError } from '../provision/common.mjs';
import { readdir, rm, stat, statfs } from 'node:fs/promises';

const RENDER_TIMEOUT_MS = 40 * 60_000;

/** Below this much free disk a render does not start: Remotion needs a few GB to work in (more for real-app footage). */
export const MIN_FREE_BYTES = 3e9;

/** One frame at a time and a smaller frame cache, for a computer short of memory (long real-app captures). */
export const LOW_MEMORY_ENV = { CONCURRENCY: '1', OTV_CACHE: '400000000' };

/**
 * Is another Remotion render running on this computer (another project or chat)? true, false, or null when the
 * system cannot say (no pgrep, for example on Windows). Never `pgrep -l`: it would print environments with keys.
 */
export async function otherRenderRunning(run) {
  const r = await run('pgrep', ['-f', 'remotion rende[r] src/'], { timeoutMs: 10_000 });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

/** Free bytes on the disk that holds `dir`, or null when the system cannot say. */
export async function freeBytes(dir) {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Remotion leaves a bundle folder (about 250 MB) in the temp folder for every render. Remove the ones made since
 * `since` (ms), so only this render's leftovers go, never another program's. Returns how many were removed.
 */
export async function cleanBundles({ tmpRoot = os.tmpdir(), since }) {
  let names;
  try {
    names = await readdir(tmpRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    if (!n.startsWith('remotion-webpack-bundle-')) continue;
    const dir = path.join(tmpRoot, n);
    try {
      const s = await stat(dir);
      if (!s.isDirectory() || s.mtimeMs < since) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed;
}

/** Remotion says "disk space is low" when the computer runs out of memory too. */
const OUT_OF_ROOM_RE = /disk space is low|Could not extract frame from compositor|ENOSPC|heap out of memory|Cannot allocate memory/i;

/**
 * "<tag>:<theme>:<music>[:silent][:vertical]", for example acme:light  acme:dark::vertical  acme:light::silent.
 * Validated here so nothing odd reaches a command line.
 */
export function parseSpec(spec) {
  const parts = String(spec).split(':');
  const [tag, theme = 'light', music = '', ...flags] = parts;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(tag ?? '')) {
    throw new ProvisionError(`"${spec}" is not a render name. Use <tag>:<light|dark>, for example acme:light (add ::silent or ::vertical for those cuts).`);
  }
  if (theme !== 'light' && theme !== 'dark') {
    throw new ProvisionError(`"${spec}": the second part must be light or dark.`);
  }
  if (music !== '' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(music)) {
    throw new ProvisionError(`"${spec}": the music name can only use letters, numbers, dots, dashes and underscores (or "none").`);
  }
  for (const f of flags) {
    if (f !== 'silent' && f !== 'vertical') throw new ProvisionError(`"${spec}": "${f}" is not a cut. Use silent or vertical.`);
  }
  return { tag, theme, music, silent: flags.includes('silent'), vertical: flags.includes('vertical') };
}

/** Read what scripts/render.mjs printed. */
export function parseRenderOutput(text) {
  const out = { name: null, seconds: null, deadAir: null };
  const done = /^(.+?)\.mp4 rendered in (\d+) s\s*$/m.exec(text);
  if (done) {
    out.name = done[1].trim();
    out.seconds = Number(done[2]);
  }
  const warn = /^WARNING: (.+?\.mp4 has dead air[^\n]*)$/m.exec(text);
  if (warn) out.deadAir = warn[1].trim();
  return out;
}

/** "max_volume: -3.2 dB" and "mean_volume: -19.8 dB" from `ffmpeg -af volumedetect`. */
export function parseVolume(text) {
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(text);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(text);
  if (!mean || !max) return null;
  return { meanDb: Number(mean[1]), maxDb: Number(max[1]) };
}

/** Loudness notes in plain words (empty = fine). */
export function volumeNotes(v) {
  if (!v) return [];
  const notes = [];
  if (v.maxDb >= -0.1) notes.push('The sound peaks at the very top and may crackle (clipping). Lower the music or voice level.');
  if (v.meanDb < -30) notes.push('The sound is very quiet on average. Check that the voice is actually in this cut.');
  return notes;
}

/**
 * Render one cut with the engine's own script (it also checks for frozen stretches and makes the contact sheet).
 * Returns { ok, spec, name, mp4, sheet, seconds, sizeMb, deadAir, volume, notes, error? }.
 */
export async function renderOne({ run, videoDir, spec, strict = false, quiet = true, env = {}, lowMemory = false, loudnorm = null }) {
  parseSpec(spec);
  const r = await run('node', ['scripts/render.mjs', spec], {
    cwd: videoDir,
    env: {
      ...env, ...(strict ? { STRICT_MOTION: '1' } : {}), ...(lowMemory ? LOW_MEMORY_ENV : {}),
      // the engine normalises the finished file's sound to this loudness (LUFS), picture copied
      LOUDNORM: loudnorm === null ? undefined : String(loudnorm),
    },
    quiet,
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  const text = `${r.stdout}\n${r.stderr}`;
  const parsed = parseRenderOutput(text);
  if (r.code !== 0) {
    const dead = /dead air/.test(text);
    let error = `The render failed. Last lines from the engine:\n${tailLines(text, 8)}`;
    if (dead) error = `The render has dead air (a frozen stretch over half a second) and strict mode is on. ${tailLines(text, 3)}`;
    else if (OUT_OF_ROOM_RE.test(text)) {
      error = 'The computer ran out of memory or disk space during the render (Remotion says "disk space is low" for both). '
        + `Close other apps, free some disk space, then render again with --low-memory${lowMemory ? ' (it was already on: make the capture or the video shorter)' : ''}.\n${tailLines(text, 3)}`;
    }
    return { ok: false, spec, name: parsed.name, error };
  }
  const name = parsed.name;
  if (!name) {
    return { ok: false, spec, name: null, error: `The render finished but did not say which file it made. Last lines:\n${tailLines(text, 6)}` };
  }
  const mp4 = path.join(videoDir, 'out', `${name}.mp4`);
  const sheet = path.join(videoDir, 'out', `sheet-${name}.jpg`);
  const haveMp4 = await pathExists(mp4);
  const haveSheet = await pathExists(sheet);
  if (!haveMp4) return { ok: false, spec, name, error: `The render said it finished, but ${mp4} is not there.` };
  const sizeMb = mb((await stat(mp4)).size);
  return {
    ok: true,
    spec,
    name,
    mp4,
    sheet: haveSheet ? sheet : null,
    seconds: parsed.seconds,
    sizeMb,
    deadAir: parsed.deadAir,
    notes: [],
  };
}
