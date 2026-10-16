// Create a new app folder from the Shipyard template.
import { readFile, writeFile, readdir, mkdir, stat, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, TEMPLATE_DIR } from '../lib/paths.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import {
  APP_CONFIG_FILE, DEFAULT_APP_ENV, SLUG_RE, ProvisionError, writeAppConfig, atomicWrite,
} from './common.mjs';
import { mergeEnv } from './envfile.mjs';

export const LAYOUTS = ['bottom-nav', 'sidebar', 'top-nav'];

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');
const PLACEHOLDER = /<APP_([A-Z_]+)>/g;
const KNOWN_PLACEHOLDERS = new Set(['SLUG', 'NAME', 'SHORT_NAME', 'DESCRIPTION', 'TAGLINE', 'LAYOUT']);
// Files whose placeholders sit inside "double quoted" string literals.
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.webmanifest']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.mp3', '.mp4',
]);
const SKIP_NAMES = new Set(['node_modules', '.next', '.git', '.vercel', '.shipyard', '.DS_Store', 'Thumbs.db']);

/** A plain-English reason the slug is not allowed, or null. */
export function slugProblem(slug) {
  if (typeof slug !== 'string' || slug === '') return 'Give the app a short name with letters, numbers and dashes, for example "recipe-box".';
  if (!SLUG_RE.test(slug)) {
    return `"${slug}" can not be an app name. Use 2 to 39 characters: lowercase letters, numbers and dashes, starting with a letter (for example "recipe-box").`;
  }
  if (slug.endsWith('-') || slug.includes('--')) {
    return `"${slug}" can not end with a dash or contain two dashes in a row. Try "${slug.replace(/-+/g, '-').replace(/-$/, '')}".`;
  }
  return null;
}

/** Collapse whitespace and control characters into single spaces. */
export function cleanText(value) {
  // Control characters and the unicode line separators become spaces.
  return String(value ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** "my-recipe-box" -> "My Recipe Box" */
export function titleFromSlug(slug) {
  return slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Home-screen label: the name if it fits in 12 characters, else its first word, else the first 12 characters. */
export function shortNameOf(name) {
  if (name.length <= 12) return name;
  const first = name.split(' ')[0];
  if (first && first.length <= 12) return first;
  return name.slice(0, 12).trim();
}

const escapeForCode = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Replace every <APP_*> placeholder in one pass (a value is never scanned again). */
export function fillPlaceholders(text, ext, values) {
  return text.replace(PLACEHOLDER, (whole, key) => {
    if (!KNOWN_PLACEHOLDERS.has(key)) throw new ProvisionError(`The template has an unknown placeholder ${whole}. This is a Shipyard bug.`);
    const value = values[key];
    return CODE_EXTENSIONS.has(ext) ? escapeForCode(value) : value;
  });
}

async function copyFileFilled(src, dest, values, counters) {
  const buf = await readFile(src);
  const { mode } = await stat(src);
  const ext = path.extname(src).toLowerCase();
  let out = buf;
  const isText = !BINARY_EXTENSIONS.has(ext) && !buf.subarray(0, 8192).includes(0);
  if (isText) {
    const text = buf.toString('utf8');
    if (text.includes('<APP_')) {
      out = Buffer.from(fillPlaceholders(text, ext, values), 'utf8');
      counters.filled += 1;
    }
  }
  await writeFile(dest, out, { mode: mode & 0o777 });
  if (process.platform !== 'win32') await chmod(dest, mode & 0o777); // keep the executable bit
  counters.files += 1;
}

async function copyTree(src, dest, values, counters) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, values, counters);
    else if (entry.isFile()) await copyFileFilled(from, to, values, counters);
  }
}

async function pluginVersion() {
  try {
    const manifest = JSON.parse(await readFile(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

async function isEmptyDir(dir) {
  return (await readdir(dir)).length === 0;
}

/**
 * Make <parent>/<slug> from the template. Does not commit, install or call any service.
 * opts: { slug, name, description, parent, layout, pwa (default true), isPrivate }
 * deps: { run, profile: { loadProfile, upsertApp }, templateDir } (all optional, for tests)
 */
export async function scaffold(opts, deps = {}) {
  const run = deps.run ?? realRun;
  const profileApi = deps.profile ?? realProfile;
  const templateDir = deps.templateDir ?? TEMPLATE_DIR;
  const notes = [];

  const problem = slugProblem(opts.slug);
  if (problem) throw new ProvisionError(problem, { usage: true });
  const slug = opts.slug;

  const name = cleanText(opts.name) || titleFromSlug(slug);
  const description = cleanText(opts.description) || 'A web app made with Shipyard.';
  if (name.length > 60) throw new ProvisionError('The app name is longer than 60 characters. Use a shorter name.', { usage: true });
  if (description.length > 300) throw new ProvisionError('The description is longer than 300 characters. Shorten it to one or two sentences.', { usage: true });

  const profile = await profileApi.loadProfile();
  const layout = opts.layout ?? profile.defaults?.layout ?? 'bottom-nav';
  if (!LAYOUTS.includes(layout)) {
    throw new ProvisionError(`The layout "${layout}" is not known. Use "bottom-nav" (phone-first), "sidebar" (tools) or "top-nav" (links in the top bar, like a website).`, { usage: true });
  }
  const pwa = opts.pwa === undefined ? profile.defaults?.pwa !== false : Boolean(opts.pwa);
  const isPrivate = Boolean(opts.isPrivate);

  const parent = path.resolve(opts.parent ?? process.cwd());
  const target = path.join(parent, slug);
  const templateRel = path.relative(templateDir, target);
  if (templateRel === '' || (!templateRel.startsWith('..') && !path.isAbsolute(templateRel))) {
    throw new ProvisionError('Pick a folder outside the Shipyard plugin to create the app in.');
  }

  let targetExists = false;
  try {
    const s = await stat(target);
    if (!s.isDirectory()) throw new ProvisionError(`${target} already exists and is a file. Pick another name or folder.`);
    if (!(await isEmptyDir(target))) {
      throw new ProvisionError(`The folder ${target} already exists and is not empty. Pick another name, or another folder with --dir.`);
    }
    targetExists = true;
  } catch (err) {
    if (err instanceof ProvisionError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }

  const known = (profile.apps ?? []).find((a) => a.slug === slug);
  if (known?.dir && path.resolve(known.dir) !== target && existsSync(known.dir)) {
    throw new ProvisionError(`You already have an app called "${slug}" in ${known.dir}. Pick a different name.`);
  }

  const values = {
    SLUG: slug,
    NAME: name,
    SHORT_NAME: shortNameOf(name),
    DESCRIPTION: description,
    TAGLINE: description,
    LAYOUT: layout,
  };
  const counters = { files: 0, filled: 0 };

  try {
    await mkdir(parent, { recursive: true });
    await copyTree(templateDir, target, values, counters);

    const createdAt = new Date().toISOString();
    const env = [...DEFAULT_APP_ENV];
    const config = {
      slug,
      name,
      description,
      layout,
      modules: [],
      pwa,
      private: isPrivate,
      env,
      createdAt,
      pluginVersion: await pluginVersion(),
    };
    await writeAppConfig(target, config);

    // Local settings: only the choices that differ from the template's defaults, plus the owner's email (the app refuses sign-ups with it; make-owner.mjs makes that account and sets the admin flag).
    const local = { NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' };
    if (!pwa) local.NEXT_PUBLIC_ENABLE_PWA = 'false';
    if (isPrivate) local.NEXT_PUBLIC_SITE_PRIVATE = 'true';
    const ownerEmail = cleanText(profile.owner?.email);
    if (ownerEmail && !/[\s'"$#]/.test(ownerEmail)) local.ADMIN_EMAIL = ownerEmail;
    await atomicWrite(path.join(target, '.env.local'), mergeEnv('', local), 0o600);

    const git = { initialized: false, hooks: false };
    const init = await run('git', ['init'], { cwd: target });
    if (init.code === 0) {
      git.initialized = true;
      await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: target });
      const hooks = await run('git', ['config', 'core.hooksPath', '.githooks'], { cwd: target });
      git.hooks = hooks.code === 0;
      if (!git.hooks) notes.push('Could not turn on the key-leak check before pushing. Run: git config core.hooksPath .githooks');
    } else {
      notes.push('Git is not installed or did not start, so the folder is not a git repository yet. Install Git, then run "git init" inside it.');
    }

    await profileApi.upsertApp({
      slug,
      name,
      dir: target,
      layout,
      modules: [],
      status: 'scaffolded',
      step: 'scaffolded',
      url: '',
      repo: '',
      supabaseRef: '',
      vercelProject: '',
      lastVerify: null,
      createdAt,
    });

    return {
      ok: true, slug, name, dir: target, layout, pwa, private: isPrivate,
      files: counters.files, git, notes,
      configFile: APP_CONFIG_FILE,
      next: 'Write SPEC.md and build the features, then run npm install and provision-supabase.mjs.',
    };
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    if (targetExists) await mkdir(target, { recursive: true }).catch(() => {});
    throw err;
  }
}
