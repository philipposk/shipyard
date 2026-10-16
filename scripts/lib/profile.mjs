// The student's non-secret settings: ~/.shipyard/profile.json.
// Keys we don't know about are kept when saving (newer plugin versions may add some).
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PROFILE_PATH, ensureHomeDir } from './paths.mjs';

/** Setup steps, in the order the setup skill walks through them. */
export const STEP_IDS = ['tools', 'github', 'vercel', 'supabase', 'ai-keys', 'email', 'stripe', 'domain', 'profile', 'habits'];

export function defaultProfile() {
  return {
    version: 1,
    owner: { name: '', email: '', country: '', languages: ['en'] },
    accounts: {
      github: { user: '', ok: false },
      vercel: { user: '', scope: '', ok: false },
      supabase: { orgId: '', orgName: '', ok: false },
      openrouter: { ok: false },
      openai: { ok: false },
      resend: { ok: false, domain: '' },
      stripe: { ok: false, mode: 'test' },
    },
    defaults: { design: '', layout: 'bottom-nav', pwa: true, phoneApps: false, budgetMode: true },
    company: { legalName: '', address: '', contactEmail: '', phone: '', vatId: '' },
    domain: { choice: 'none', name: '' },
    setup: { step: STEP_IDS[0], done: [], updatedAt: '' },
    apps: [],
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Defaults fill gaps; values from the file win; arrays are replaced, not merged. */
function merge(base, extra) {
  if (!isPlainObject(base) || !isPlainObject(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = k in base && isPlainObject(base[k]) && isPlainObject(v) ? merge(base[k], v) : v;
  }
  return out;
}

/** Read the profile. Missing file = defaults. A corrupt file is moved aside, not lost. */
export async function loadProfile() {
  let text;
  try {
    text = await readFile(PROFILE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultProfile();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
    if (!isPlainObject(parsed)) throw new Error('not an object');
  } catch {
    try {
      await rename(PROFILE_PATH, `${PROFILE_PATH}.broken-${Date.now()}`);
    } catch {
      // keep going with defaults
    }
    return defaultProfile();
  }
  return merge(defaultProfile(), parsed);
}

/** Write the whole profile atomically (temp file in the same folder, then rename). */
export async function saveProfile(profile) {
  await ensureHomeDir();
  const tmp = `${PROFILE_PATH}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, PROFILE_PATH);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return profile;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const splitPath = (dotted) => {
  const parts = String(dotted).split('.').filter((s) => s !== '');
  if (parts.length === 0) throw new Error('Give a path like "defaults.layout".');
  if (parts.some((p) => FORBIDDEN_KEYS.has(p))) throw new Error(`"${dotted}" is not a valid path.`);
  return parts;
};

/** profile value at "a.b.c", or undefined. Array indexes work too ("apps.0.slug"). */
export function getPath(profile, dotted) {
  let cur = profile;
  for (const key of splitPath(dotted)) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Command-line values arrive as strings. Turn "true"/"false"/"null", plain numbers
 * and JSON arrays/objects into real values. A JSON string ("\"007\"") forces a string.
 * Numbers with leading zeros (like VAT ids) stay strings.
 */
export function parseValue(value) {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v) && Number.isSafeInteger(Math.trunc(Number(v)))) return Number(v);
  if (/^[[{"]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return value;
    }
  }
  return value;
}

/** Set a value at "a.b.c" (creates missing objects). Changes and returns `profile`. */
export function setPath(profile, dotted, value) {
  const keys = splitPath(dotted);
  let cur = profile;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] === undefined || cur[key] === null) cur[key] = {};
    else if (typeof cur[key] !== 'object') throw new Error(`Can't set "${dotted}": "${key}" holds a plain value.`);
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = parseValue(value);
  return profile;
}

/** Mark a setup step done and point `setup.step` at the first step still open. */
export async function markStep(stepId) {
  if (!STEP_IDS.includes(stepId)) {
    throw new Error(`Unknown setup step "${stepId}". Steps: ${STEP_IDS.join(', ')}.`);
  }
  const profile = await loadProfile();
  const done = Array.isArray(profile.setup.done) ? profile.setup.done : [];
  if (!done.includes(stepId)) done.push(stepId);
  profile.setup.done = done;
  profile.setup.step = STEP_IDS.find((id) => !done.includes(id)) ?? 'done';
  profile.setup.updatedAt = new Date().toISOString();
  await saveProfile(profile);
  return profile;
}

const APP_DEFAULTS = {
  slug: '', name: '', dir: '', url: '', repo: '', supabaseRef: '', vercelProject: '',
  layout: '', modules: [], status: 'scaffolded', step: '', createdAt: '', lastVerify: null,
};

/** Add or update an app (matched by slug). New fields win; other fields are kept. */
export async function upsertApp(app) {
  if (!app || typeof app.slug !== 'string' || !app.slug) throw new Error('An app needs a slug.');
  const profile = await loadProfile();
  const apps = Array.isArray(profile.apps) ? profile.apps : [];
  const i = apps.findIndex((a) => a.slug === app.slug);
  let saved;
  if (i === -1) {
    saved = { ...APP_DEFAULTS, createdAt: new Date().toISOString(), ...app };
    apps.push(saved);
  } else {
    saved = { ...apps[i], ...app };
    apps[i] = saved;
  }
  profile.apps = apps;
  await saveProfile(profile);
  return saved;
}

/** One app by slug, or null. */
export async function getApp(slug) {
  const profile = await loadProfile();
  return (profile.apps ?? []).find((a) => a.slug === slug) ?? null;
}
