// Small helpers shared by scaffold, provision-supabase, provision-vercel and deploy.
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from '../lib/log.mjs';
import { parseArgs, UsageError } from '../lib/log.mjs';

/** Each app folder carries this file. It holds no secrets and is committed with the app. */
export const APP_CONFIG_FILE = '.shipyard-app.json';

export const SLUG_RE = /^[a-z][a-z0-9-]{1,38}$/;

/** Variables the app uses by default. provision-vercel copies these (when they have a value). */
export const DEFAULT_APP_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_ENABLE_PWA',
  'NEXT_PUBLIC_SITE_PRIVATE',
  'NEXT_PUBLIC_SIGNUP_MODE',
  'NEXT_PUBLIC_CONTACT_EMAIL',
  'ADMIN_EMAIL',
];

/** An error whose message is already written for the student. `data` is merged into --json output. */
export class ProvisionError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.name = 'ProvisionError';
    this.data = data;
  }
}

/** True when this module's file is the one node was started with (so a script can also be imported by tests). */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Write a file in one step: temp file next to it, then rename. */
export async function atomicWrite(file, text, mode = 0o644) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** The absolute path of an app folder, or a friendly error. */
export async function resolveAppDir(arg) {
  if (!arg) throw new UsageError('Give the app folder, for example: node provision-supabase.mjs ./my-app');
  const dir = path.resolve(String(arg));
  let s;
  try {
    s = await stat(dir);
  } catch {
    throw new ProvisionError(`The folder ${dir} does not exist.`);
  }
  if (!s.isDirectory()) throw new ProvisionError(`${dir} is not a folder.`);
  return dir;
}

export async function readAppConfig(appDir) {
  const file = path.join(appDir, APP_CONFIG_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ProvisionError(`This folder was not made by Shipyard (there is no ${APP_CONFIG_FILE} in ${appDir}). Check the folder, or create the app with /shipyard:new-app.`);
    }
    throw err;
  }
  let config;
  try {
    config = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new ProvisionError(`${APP_CONFIG_FILE} is damaged (it is not valid JSON). Restore it from git, or fix it by hand.`);
  }
  if (!config || typeof config !== 'object' || typeof config.slug !== 'string' || !SLUG_RE.test(config.slug)) {
    throw new ProvisionError(`${APP_CONFIG_FILE} has no valid "slug". Restore it from git, or fix it by hand.`);
  }
  return config;
}

export async function writeAppConfig(appDir, config) {
  await atomicWrite(path.join(appDir, APP_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

/** Read, change a few fields, write back. Returns the new config. */
export async function updateAppConfig(appDir, patch) {
  const config = await readAppConfig(appDir);
  return writeAppConfig(appDir, { ...config, ...patch });
}

/** The environment variable names this app uses (from .shipyard-app.json, or the defaults). */
export function appEnvNames(config) {
  const list = Array.isArray(config.env) ? config.env : DEFAULT_APP_ENV;
  return [...new Set(list.filter((n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)))];
}

/**
 * Turn a git remote into a plain web address without any login part.
 * "https://user:token@github.com/a/b.git" and "git@github.com:a/b.git" both become "https://github.com/a/b".
 */
export function repoDisplay(remote) {
  const r = String(remote ?? '').trim();
  if (!r) return '';
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(r);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(r);
    if (!u.hostname) return '';
    return `https://${u.hostname}${u.pathname}`.replace(/\.git\/?$/, '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** Only the scheme and host of a web address ("https://x.vercel.app/a?b" -> "https://x.vercel.app"). */
export function originOf(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new ProvisionError(`"${input}" is not a web address. Use something like https://my-app.vercel.app`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ProvisionError(`"${input}" is not a web address. Use something like https://my-app.vercel.app`);
  }
  return u.origin;
}

export const isLocalOrigin = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
};

/** Run git and return { code, out }. `run` is injectable for tests. */
export async function git(run, cwd, args) {
  const r = await run('git', args, { cwd });
  return { code: r.code, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/**
 * Shared entry point for the four scripts: parse flags, handle --help and --json,
 * turn errors into plain messages and set the exit code (0 ok, 1 check failed, 2 usage).
 * `main(args)` returns { ok, ... }; human lines are printed by main itself.
 */
export async function runCli({ argv, spec, help, main }) {
  const wantsJson = argv.includes('--json');
  const fullSpec = {
    ...spec,
    boolean: ['help', 'json', ...(spec.boolean ?? [])],
    alias: { h: 'help', ...(spec.alias ?? {}) },
  };
  let args;
  try {
    args = parseArgs(argv, fullSpec);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    if (wantsJson) log.json({ ok: false, error: err.message });
    else log.fail(err.message);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${help.trim()}\n`);
    return;
  }
  if (args.json) log.setQuiet(true);
  let result;
  try {
    result = await main(args);
  } catch (err) {
    if (err instanceof UsageError) {
      if (args.json) log.json({ ok: false, error: err.message });
      else log.fail(err.message);
      process.exitCode = 2;
      return;
    }
    const known = err instanceof ProvisionError || ['ApiError', 'MissingSecretError'].includes(err?.name);
    const message = known ? err.message : `Something unexpected went wrong: ${err?.message ?? err}`;
    result = { ok: false, error: message, ...(err instanceof ProvisionError ? err.data : {}) };
    if (!args.json) log.fail(message);
  }
  if (args.json) log.json(result);
  process.exitCode = result.ok ? 0 : 1;
}
