// Running one engine render and reading its result. Used by video-render.mjs and by the smoke render in video-setup.mjs.
import path from 'node:path';
import { pathExists, tailLines, mb } from './common.mjs';
import { ProvisionError } from '../provision/common.mjs';
import { stat } from 'node:fs/promises';

const RENDER_TIMEOUT_MS = 40 * 60_000;

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
export async function renderOne({ run, videoDir, spec, strict = false, quiet = true, env = {} }) {
  parseSpec(spec);
  const r = await run('node', ['scripts/render.mjs', spec], {
    cwd: videoDir,
    env: { ...env, ...(strict ? { STRICT_MOTION: '1' } : {}) },
    quiet,
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  const text = `${r.stdout}\n${r.stderr}`;
  const parsed = parseRenderOutput(text);
  if (r.code !== 0) {
    const dead = /dead air/.test(text);
    return {
      ok: false,
      spec,
      name: parsed.name,
      error: dead
        ? `The render has dead air (a frozen stretch over half a second) and strict mode is on. ${tailLines(text, 3)}`
        : `The render failed. Last lines from the engine:\n${tailLines(text, 8)}`,
    };
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
