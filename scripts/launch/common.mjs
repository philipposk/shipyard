// Small helpers shared by the launch scripts. No network here.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppConfig, updateAppConfig, appEnvNames } from '../provision/common.mjs';
import * as realProfile from '../lib/profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

let servicesCache = null;
/** The services catalogue (scripts/launch/services.json). */
export async function loadServices(file = path.join(here, 'services.json')) {
  if (file === path.join(here, 'services.json') && servicesCache) return servicesCache;
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (file === path.join(here, 'services.json')) servicesCache = data;
  return data;
}

/**
 * Take secret values out of a piece of text before it can reach the screen or a result.
 * `values` are exact strings (keys we hold); the patterns catch anything key-shaped from a provider.
 */
export function scrub(text, values = []) {
  let out = String(text ?? '');
  for (const v of [...new Set(values.filter((x) => typeof x === 'string' && x.length >= 6))].sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('***');
  }
  return out
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/g, '***')
    .replace(/\bwhsec_[A-Za-z0-9]{6,}/g, '***')
    .replace(/\bre_[A-Za-z0-9_]{12,}/g, '***')
    .replace(/\bsbp_[A-Za-z0-9]{10,}/g, '***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

/**
 * The short launch summary the settings page shows for an app (profile app entry, key `launch`):
 * { domain, emailVerified, legalAt, billing: 'test'|'live'|'', shells: [] }. Non-secret facts only.
 */
export function launchSummary(config) {
  const l = config.launch ?? {};
  const mode = l.billing?.mode;
  return {
    domain: typeof l.domain?.name === 'string' ? l.domain.name : '',
    emailVerified: l.email?.verified === true,
    legalAt: typeof l.legal?.generatedAt === 'string' ? l.legal.generatedAt : '',
    billing: mode === 'test' || mode === 'live' ? mode : '',
    shells: Object.keys(config.shells ?? {}),
  };
}

/**
 * Merge a patch into the `launch` record of .shipyard-app.json (non-secret facts launch-check reads), then copy the short
 * summary to the profile so the settings page can show it. A profile problem never stops the launch step.
 */
export async function recordLaunch(appDir, patch, { profile = realProfile } = {}) {
  const config = await readAppConfig(appDir);
  const launch = { ...(config.launch ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    launch[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(launch[key] ?? {}), ...value } : value;
  }
  const next = await updateAppConfig(appDir, { launch });
  try {
    await profile.upsertApp({ slug: next.slug, launch: launchSummary(next) });
  } catch {
    // the settings page is a convenience; the app's own file is the record
  }
  return launch;
}

/** The address visitors use: the custom domain if one is set, else the saved web address, else null. */
export function appUrlOf(config, profileApp) {
  const raw = config.launch?.domain?.url || config.siteUrl || config.url || profileApp?.url || '';
  try {
    return raw ? new URL(raw).origin : null;
  } catch {
    return null;
  }
}

/** True for addresses that are only for trying things out (vercel.app, localhost). */
export function isTestAddress(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h.endsWith('.vercel.app');
  } catch {
    return true;
  }
}

/** Add names to the app's `env` list (the names provision-vercel copies to Vercel). Returns the new list. */
export async function addEnvNames(appDir, names) {
  const config = await readAppConfig(appDir);
  const before = appEnvNames(config);
  const env = [...before];
  for (const n of names) if (!env.includes(n)) env.push(n);
  if (env.length !== before.length || !Array.isArray(config.env)) await updateAppConfig(appDir, { env });
  return env;
}
