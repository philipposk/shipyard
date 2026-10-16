// Shared pieces of the video scripts: where the video engine comes from, names, and small safe helpers.
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProvisionError } from '../provision/common.mjs';
import { INSTALL, osName } from '../check-tools.mjs';

/**
 * The video engine is a public, MIT-licensed folder (`motion/`, built on Remotion) in this repository.
 * We always copy it from ONE pinned commit, never "latest", so a change upstream cannot break a student's video.
 * ENGINE_SHA was looked up (read-only, `git ls-remote` + GitHub API, both agreed) on 2026-10-16.
 * To move to a newer engine: look up the new commit, change ENGINE_SHA, run the tests and the opt-in real test
 * (SHIPYARD_TEST_VIDEO=1).
 */
export const ENGINE_REPO = 'https://github.com/philipposk/demo-pipeline';
export const ENGINE_SHA = 'fe1fd05f3e3c4f40f67f3c567af7ea932ccc95ed';
export const ENGINE_SUBDIR = 'motion';

/** Folder inside the app that holds the engine and the student's scenes. */
export const VIDEO_DIR_NAME = 'video';
/** Folder inside the app that serves the finished web copies. */
export const PUBLISH_DIR = path.join('public', 'video');
/** The one example the engine keeps: a made-up to-do app, with its voice committed, so it renders without keys. */
export const NEUTRAL_EXAMPLE = 'acme';
export const SMOKE_SPEC = 'acme:light';

/** Names we put in file names and command lines (tags, script ids). */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** Keys the voice step may be given (from the Shipyard keys file, through the child's environment). */
export const VOICE_KEYS = ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY'];
export const MIN_NODE_MAJOR = 20;

export const videoDirOf = (appDir) => path.join(appDir, VIDEO_DIR_NAME);

export async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
}

/** The app's video folder, or a plain error that says to run video-setup. */
export async function requireVideoDir(appDir) {
  const dir = videoDirOf(appDir);
  if (!(await pathExists(path.join(dir, 'package.json'))) || !(await pathExists(path.join(dir, 'scripts', 'render.mjs')))) {
    throw new ProvisionError('The video folder is not set up yet. Run video-setup.mjs for this app first.');
  }
  return dir;
}

/** Is ffmpeg + ffprobe on this computer? Returns { ok, missing: [...], install } (install = the line for this system). */
export async function checkMediaTools(which, platform = process.platform) {
  const missing = [];
  for (const tool of ['ffmpeg', 'ffprobe']) if (!(await which(tool))) missing.push(tool);
  return { ok: missing.length === 0, missing, install: INSTALL.ffmpeg[osName(platform)] };
}

export function mediaToolsError(check) {
  return new ProvisionError(
    `${check.missing.join(' and ')} ${check.missing.length === 1 ? 'is' : 'are'} not installed. Videos need ffmpeg (a free tool that edits video). `
    + `Install it with: ${check.install}   Then run this again.`,
    { missing: check.missing, install: check.install },
  );
}

/**
 * Remove anything that looks like a key from text we are about to show, and every exact key value we handed to a child.
 * Provider error messages sometimes echo a (masked) key; this keeps even that out of the chat and the logs.
 */
export function redactSecrets(text, values = []) {
  let out = String(text ?? '');
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 6) out = out.split(v).join('[hidden]');
  }
  out = out.replace(/\b(?:sk|pk|rk|re|sbp|dg)[-_][A-Za-z0-9_*.-]{8,}/g, '[hidden key]');
  out = out.replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=*-]{12,}/g, '$1 [hidden]');
  return out;
}

/** Last few non-empty lines of a program's output (for error messages). */
export function tailLines(text, n = 8) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');
}

export const mb = (bytes) => Math.round((bytes / 1e6) * 10) / 10;
