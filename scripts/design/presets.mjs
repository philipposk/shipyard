// The ready-made looks (presets/*.tokens.json) and the looks a student saved for later
// (~/.shipyard/designs/*.tokens.json). Ids are checked before they touch a file path.
import { readFile, readdir, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { HOME_DIR, PLUGIN_ROOT } from '../lib/paths.mjs';
import { ID_RE, isObject, normalizeTokens } from './tokens.mjs';

export const PRESETS_DIR = path.join(PLUGIN_ROOT, 'presets');
export const CUSTOM_LOOKS_DIR = path.join(HOME_DIR, 'designs');

/** Shown first and in this order everywhere (gallery, docs). */
export const PRESET_ORDER = [
  'calm-blue', 'clean-mono', 'warm-friendly', 'editorial', 'fresh-green', 'playful', 'night-tech', 'soft-pastel',
];

/** An error whose message is already written for the student. */
export class LookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LookError';
  }
}

export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

async function readLook(file, label) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ''));
    if (!isObject(parsed)) throw new Error('not an object');
    return normalizeTokens(parsed);
  } catch {
    throw new LookError(`The look file for ${label} is damaged (it is not valid JSON).`);
  }
}

async function idsIn(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.tokens.json')).map((f) => f.slice(0, -'.tokens.json'.length)).filter(isValidId);
  } catch {
    return [];
  }
}

/** Ids of the built-in looks, in display order. */
export async function listPresetIds() {
  const found = await idsIn(PRESETS_DIR);
  const first = PRESET_ORDER.filter((id) => found.includes(id));
  return [...first, ...found.filter((id) => !PRESET_ORDER.includes(id)).sort()];
}

/** Built-in looks, in display order: [tokens, ...] */
export async function listPresets() {
  const out = [];
  for (const id of await listPresetIds()) out.push(await readLook(path.join(PRESETS_DIR, `${id}.tokens.json`), `"${id}"`));
  return out.filter(Boolean);
}

/** Looks saved by the student with "use this look for my next apps too". */
export async function listCustomLooks() {
  const out = [];
  for (const id of (await idsIn(CUSTOM_LOOKS_DIR)).sort()) {
    try {
      const look = await readLook(path.join(CUSTOM_LOOKS_DIR, `${id}.tokens.json`), `"${id}"`);
      if (look) out.push(look);
    } catch {
      // a damaged saved look is skipped, not fatal
    }
  }
  return out;
}

/**
 * Load a look by id: built-in first, then the student's saved looks.
 * The id must be a plain look id, so "../../something" can never reach a file.
 */
export async function loadPreset(id, { custom = true } = {}) {
  if (!isValidId(id)) {
    throw new LookError(`"${String(id).slice(0, 60)}" is not a look name. Use a name like "warm-friendly".`);
  }
  const builtIn = await readLook(path.join(PRESETS_DIR, `${id}.tokens.json`), `"${id}"`);
  if (builtIn) return { tokens: builtIn, origin: 'preset' };
  if (custom) {
    const mine = await readLook(path.join(CUSTOM_LOOKS_DIR, `${id}.tokens.json`), `"${id}"`);
    if (mine) return { tokens: mine, origin: 'saved' };
  }
  const known = [...(await listPresetIds()), ...(custom ? (await listCustomLooks()).map((l) => l.id) : [])];
  throw new LookError(`There is no look called "${id}". Available: ${known.join(', ')}.`);
}

/** Save a look so it can be used for later apps (`apply-design --preset <id>`). */
export async function saveCustomLook(tokens) {
  if (!isValidId(tokens?.id)) throw new LookError('This look has no valid id, so it cannot be saved.');
  await mkdir(CUSTOM_LOOKS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(CUSTOM_LOOKS_DIR, `${tokens.id}.tokens.json`);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return file;
}
