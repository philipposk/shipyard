// Shared helpers for ops-setup, ops-status and backup-export. No network in here: anything that talks to
// GitHub goes through an injectable `run` (see makeGh), so tests use fakes.
import { readFile, readdir as realReaddir, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PLUGIN_ROOT } from '../lib/paths.mjs';
import * as realProfile from '../lib/profile.mjs';
import { readAppConfig, updateAppConfig, atomicWrite, repoDisplay, git } from '../provision/common.mjs';
import { skillHint } from '../lib/agent.mjs';

export const OPS_DIR = path.join(PLUGIN_ROOT, 'ops');
export const TEMPLATES_DIR = path.join(OPS_DIR, 'templates');

/** The four parts of ops-setup. Each lists the files it writes, from ops/templates/ into the app. */
export const PARTS = {
  health: ['.github/workflows/health.yml'],
  review: ['.coderabbit.yaml'],
  automerge: ['.github/workflows/automerge.yml', '.github/ops/automerge-check.mjs'],
  deps: ['.github/dependabot.yml'],
};
export const PART_NAMES = Object.keys(PARTS);

export const PART_HELP = {
  health: 'checks your live site every 6 hours and opens a GitHub issue when something is wrong',
  review: 'settings for CodeRabbit, which reviews every pull request',
  automerge: 'lets small, low-risk pull requests merge themselves after the tests pass',
  deps: 'Dependabot: weekly pull requests that update your packages',
};

/** Workflow actions we use, pinned to a full commit (ops/actions-pins.json). */
export async function loadPins() {
  return JSON.parse(await readFile(path.join(OPS_DIR, 'actions-pins.json'), 'utf8'));
}

export async function readTemplate(rel) {
  return readFile(path.join(TEMPLATES_DIR, ...rel.split('/')), 'utf8');
}

/** Same text with Windows line endings turned into plain ones, so a git checkout on Windows doesn't look "edited". */
export const normalizeEol = (text) => String(text).replace(/\r\n/g, '\n');
export const sha256 = (text) => createHash('sha256').update(normalizeEol(text)).digest('hex');

/** "2026-10-16T14-03-00Z", the folder name of a backup (safe on every operating system). */
export function backupStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

// ---------------------------------------------------------------------------------------------
// A small line diff, to show what differs between a file the student changed and Shipyard's version.

/**
 * Lines that differ, as [{ type: '-' | '+', line, text }]. '-' = only in the first text, '+' = only in the second.
 * At most `max` entries; `more` counts the rest.
 */
export function diffLines(a, b, max = 24) {
  const A = normalizeEol(a).split('\n');
  const B = normalizeEol(b).split('\n');
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  const out = [];
  if (midA.length * midB.length <= 250_000) {
    // longest common subsequence of the middle part
    const n = midA.length;
    const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        i++;
        j++;
      } else if (j >= m || (i < n && table[i + 1][j] >= table[i][j + 1])) {
        out.push({ type: '-', line: start + i + 1, text: midA[i] });
        i++;
      } else {
        out.push({ type: '+', line: start + j + 1, text: midB[j] });
        j++;
      }
    }
  } else {
    midA.forEach((text, k) => out.push({ type: '-', line: start + k + 1, text }));
    midB.forEach((text, k) => out.push({ type: '+', line: start + k + 1, text }));
  }
  const shown = out.slice(0, max).map((d) => ({ ...d, text: d.text.length > 140 ? `${d.text.slice(0, 137)}...` : d.text }));
  return { lines: shown, more: Math.max(0, out.length - max) };
}

// ---------------------------------------------------------------------------------------------
// Writing template files into the app without trampling the student's edits

/**
 * Put one file into the app.
 * status: created | unchanged | updated (Shipyard's own older copy, never edited) | replaced (forced)
 *       | kept (the student changed it: left alone, `diff` shows how it differs) | refused (it is a link)
 * `recorded` is the hash Shipyard saved the last time it wrote this file.
 */
export async function installFile({ appDir, rel, wanted, recorded, force = false }) {
  const target = path.join(appDir, ...rel.split('/'));
  let info = null;
  try {
    info = await lstat(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const write = async () => {
    await mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, wanted);
  };
  if (!info) {
    await write();
    return { path: rel, status: 'created', hash: sha256(wanted) };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { path: rel, status: 'refused', reason: `${rel} is a link or a folder, not a plain file. Move it away and run this again.` };
  }
  const current = await readFile(target, 'utf8');
  if (normalizeEol(current) === normalizeEol(wanted)) return { path: rel, status: 'unchanged', hash: sha256(wanted) };
  if (force) {
    await write();
    return { path: rel, status: 'replaced', hash: sha256(wanted) };
  }
  if (recorded && sha256(current) === recorded) {
    await write();
    return { path: rel, status: 'updated', hash: sha256(wanted) };
  }
  return { path: rel, status: 'kept', diff: diffLines(current, wanted), hash: recorded };
}

// ---------------------------------------------------------------------------------------------
// GitHub through the gh program

/** "owner/name" from a git remote address, or null when it isn't on github.com. */
export function repoSlugFrom(remote) {
  const shown = repoDisplay(remote);
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(shown);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The GitHub repository of an app folder: { slug, remote } (slug null when there is no github.com remote). */
export async function appRepo(run, appDir) {
  const inside = await git(run, appDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return { slug: null, reason: 'This folder is not a git repository.' };
  const remote = await git(run, appDir, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0 || !remote.out) return { slug: null, reason: 'This app is not on GitHub yet (no "origin" address).' };
  const slug = repoSlugFrom(remote.out);
  return slug ? { slug } : { slug: null, reason: 'The "origin" address is not a github.com repository.' };
}

const clip = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' ').trim().slice(0, 300);

/**
 * A small wrapper for `gh`. Every call names the repository with --repo, so the folder doesn't matter.
 *   gh.json(args)          -> { ok, data }            (args end up in `gh api` style calls that print JSON)
 *   gh.text(args, {input}) -> { ok, out }
 * Failures come back as { ok: false, error, missing } and never throw. `missing` = gh is not installed.
 */
export function makeGh(run, { cwd, repo } = {}) {
  const call = async (args, { input } = {}) => {
    const r = await run('gh', args, { cwd, input, timeoutMs: 120_000 });
    if (r.code === 127) return { ok: false, missing: true, error: `The GitHub program (gh) is not installed. Run ${skillHint('setup')} to check your tools.` };
    if (r.code !== 0) {
      const msg = clip(r.stderr || r.stdout);
      const notLoggedIn = /gh auth login|not logged in|authentication/i.test(msg);
      return { ok: false, notLoggedIn, status: /HTTP (\d{3})/.exec(msg)?.[1] ? Number(/HTTP (\d{3})/.exec(msg)[1]) : undefined, error: notLoggedIn ? 'You are not logged in to GitHub. Run: gh auth login' : msg || `gh stopped with code ${r.code}.` };
    }
    return { ok: true, out: String(r.stdout ?? '') };
  };
  return {
    repo,
    text: call,
    async json(args, opts) {
      const r = await call(args, opts);
      if (!r.ok) return r;
      try {
        return { ok: true, data: r.out.trim() === '' ? null : JSON.parse(r.out) };
      } catch {
        return { ok: false, error: 'GitHub sent back something unexpected.' };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What ops has done to an app, written into .shipyard-app.json (no secrets) and a short copy in the profile

/** The facts the settings page shows. */
export function opsSummary(ops = {}) {
  const has = (rel) => Boolean(ops.files?.[rel]);
  return {
    health: has('.github/workflows/health.yml'),
    review: has('.coderabbit.yaml'),
    automerge: has('.github/workflows/automerge.yml'),
    deps: has('.github/dependabot.yml'),
    ...(typeof ops.backupAt === 'string' ? { backupAt: ops.backupAt } : {}),
  };
}

/**
 * Merge `patch` into the app's `ops` record. `patch.files` entries are merged by path.
 * Returns the new record. A profile problem never stops the step.
 */
export async function recordOps(appDir, patch, { profile = realProfile } = {}) {
  const config = await readAppConfig(appDir);
  const before = config.ops && typeof config.ops === 'object' ? config.ops : {};
  const ops = { ...before, ...patch, files: { ...(before.files ?? {}), ...(patch.files ?? {}) } };
  const next = await updateAppConfig(appDir, { ops });
  try {
    await profile.upsertApp({ slug: next.slug, ops: opsSummary(ops) });
  } catch {
    // the settings page is a convenience; the app's own file is the record
  }
  return ops;
}

/** Newest backup folder name for an app, or null. `listDir` is injectable for tests. */
export async function latestBackup(homeDir, slug, { readdir } = {}) {
  const list = readdir ?? realReaddir;
  try {
    const names = (await list(path.join(homeDir, 'backups', slug))).filter((n) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?$/.test(n)).sort();
    const last = names.at(-1);
    if (!last) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(last);
    return { name: last, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, count: names.length };
  } catch {
    return null;
  }
}

