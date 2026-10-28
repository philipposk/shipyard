#!/usr/bin/env node
// Split one big branch into stacked branches that each pass the type check (and the tests, when given) on their own,
// so every pull request stays under a review limit (CodeRabbit's free plan skips pull requests over 150 files).
// Each stage starts from the one before and takes the final version of its files from the big branch, so the last
// stage is exactly the big branch. While the check fails, it pulls forward any later-stage file that has an error,
// or that a file with an error imports, plus that file's test. Run it from a clean checkout of the repo: it creates
// and checks out the stage branches there. Built-ins only, no network.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runCli, isMain, ProvisionError } from '../provision/common.mjs';
import { UsageError } from '../lib/log.mjs';
import * as log from '../lib/log.mjs';

const HELP = `
Split one big branch into stacked branches, each small enough to review and each passing the checks.

Usage:
  node split-stack.mjs --from <branch> --stages <stages.json> [--base origin/main] [--prefix split/]
                       [--check "npx tsc --noEmit"] [--test "npm test"] [--msgs <folder>] [--max-files 150]
                       [--dry-run] [--force] [--json]

  stages.json   an ordered list; the first pattern that matches a file wins, and the last should be ".*":
                [ {"name": "1-hotfix", "match": "^(package(-lock)?\\\\.json|src/lib/auth/)"},
                  {"name": "2-rest", "match": ".*"} ]
  --check       the command that must pass on every stage (default: npx tsc --noEmit)
  --test        a command that must also pass, for example "npm test"
  --msgs        a folder with one commit message file per stage name (default message: "stage <name>")
  --max-files   warn when a stage changes more files than this (default 150)
  --dry-run     only show which files go in which stage; touches nothing
  --force       reset stage branches that already exist (otherwise they are refused)

Lock files always go in the same stage as their package.json. Run it from a clean checkout: it leaves the
last stage checked out, or, when something fails, goes back to the branch you started on.
`;

const CODE_EXT = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'];

/** `git diff --name-status -z` output as Map(path -> status letter). Pure. */
export function parseNameStatus(z) {
  const parts = String(z).split('\0').filter((p) => p !== '');
  const out = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) out.set(parts[i + 1], parts[i][0]);
  return out;
}

/** Check the stages file and compile its patterns. Throws a plain message on any problem. Pure. */
export function compileStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) throw new ProvisionError('The stages file must be a list like [{"name": "1-fixes", "match": "^src/"}, {"name": "2-rest", "match": ".*"}].');
  const seen = new Set();
  return stages.map((s, i) => {
    if (!s || typeof s.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.name)) throw new ProvisionError(`Stage ${i + 1} needs a "name" made of letters, digits, dots, dashes or underscores.`);
    if (seen.has(s.name)) throw new ProvisionError(`Two stages are called "${s.name}".`);
    seen.add(s.name);
    try {
      return { name: s.name, re: new RegExp(s.match) };
    } catch {
      throw new ProvisionError(`Stage "${s.name}" has a "match" that is not a valid pattern.`);
    }
  });
}

/** Which stage each file goes in (the first match wins). Returns { stageOf: Map, unmatched: [] }. Pure. */
export function assignStages(files, stages) {
  const stageOf = new Map();
  const unmatched = [];
  for (const f of files) {
    const s = stages.find((x) => x.re.test(f));
    if (s) stageOf.set(f, s.name);
    else unmatched.push(f);
  }
  return { stageOf, unmatched };
}

/** Import paths in a source file: import/export ... from, import(), bare import, require(). Pure. */
export function importsIn(source) {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
  return [...String(source).matchAll(re)].map((m) => m[1]);
}

/** Path aliases from a tsconfig.json text, as { "@/": "src/" }. Comments and trailing commas are allowed. Pure. */
export function aliasFromTsconfig(text) {
  let cfg;
  try {
    const clean = String(text)
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    cfg = JSON.parse(clean);
  } catch {
    return {};
  }
  const opts = cfg?.compilerOptions ?? {};
  const base = String(opts.baseUrl ?? '.').replace(/\\/g, '/');
  const out = {};
  for (const [key, targets] of Object.entries(opts.paths ?? {})) {
    const target = Array.isArray(targets) ? targets[0] : null;
    if (!key.endsWith('/*') || typeof target !== 'string' || !(target === '*' || target.endsWith('/*'))) continue;
    const dir = path.posix.normalize(path.posix.join(base, target.slice(0, -1)));
    out[key.slice(0, -1)] = dir === './' || dir === '.' ? '' : dir.replace(/^\.\//, '').replace(/\/?$/, '/');
  }
  return out;
}

/** The changed file an import points at, or null (a package, or a file this branch does not change). Pure. */
export function resolveImport(from, spec, known, alias = {}) {
  let base = null;
  const prefix = Object.keys(alias).sort((a, b) => b.length - a.length).find((p) => spec.startsWith(p));
  if (prefix !== undefined) base = alias[prefix] + spec.slice(prefix.length);
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base === null) return null;
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  const candidates = [base, ...CODE_EXT.map((e) => `${base}${e}`), ...CODE_EXT.map((e) => `${stem}${e}`), ...CODE_EXT.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => known.has(c)) ?? null;
}

/** Files named in type-check errors, in tsc's plain ("a.ts(1,2): error") and pretty ("a.ts:1:2 - error") forms. Pure. */
export function errorFiles(output) {
  const text = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const found = new Set();
  // Lazy up to the first "(line,col): error", so folders like src/app/(marketing)/ stay in the path.
  for (const m of text.matchAll(/^(\S[^\n]*?)\(\d+,\d+\): error/gm)) found.add(m[1].replace(/\\/g, '/'));
  for (const m of text.matchAll(/^(\S[^\n]*?):\d+:\d+ - error/gm)) found.add(m[1].replace(/\\/g, '/'));
  return [...found];
}

const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];

/**
 * Keep each lock file in the same stage as the package.json next to it (the earlier of the two), or `npm ci` fails
 * on the stage that changes a dependency. Changes `stageOf` in place and returns the files it moved. Pure.
 */
export function pairLockFiles(stageOf, order) {
  const moved = [];
  for (const [file, stage] of [...stageOf]) {
    if (!LOCK_FILES.includes(path.posix.basename(file))) continue;
    const pkg = path.posix.join(path.posix.dirname(file), 'package.json');
    if (!stageOf.has(pkg)) continue;
    const first = order[Math.min(order.indexOf(stage), order.indexOf(stageOf.get(pkg)))];
    for (const f of [file, pkg]) {
      if (stageOf.get(f) !== first) {
        stageOf.set(f, first);
        moved.push(f);
      }
    }
  }
  return moved;
}

/** The test files that usually sit next to a file (x.ts -> x.test.ts, x.test.tsx, x.test.mjs). Pure. */
export function testSiblings(file) {
  const stem = file.replace(/\.(tsx?|mts|mjs|jsx?)$/, '');
  return stem === file ? [] : ['.test.ts', '.test.tsx', '.test.mjs', '.test.js'].map((e) => `${stem}${e}`).filter((t) => t !== file);
}

/**
 * Later-stage files that must move into `current` so its errors go away: files with an error, files those import,
 * and their tests. `importsOf(file)` lists the changed files a file imports. Pure apart from importsOf.
 */
export function filesToPull({ errFiles, stageOf, order, current, importsOf }) {
  const later = (f) => stageOf.has(f) && order.indexOf(stageOf.get(f)) > order.indexOf(current);
  const pull = new Set();
  for (const f of errFiles) {
    if (later(f)) pull.add(f);
    for (const d of importsOf(f)) if (later(d)) pull.add(d);
  }
  for (const f of [...pull]) for (const t of testSiblings(f)) if (later(t)) pull.add(t);
  return [...pull];
}

// ---------- git and commands ----------

let TOP = '.';
// Literal paths: Next.js folders such as [id] or (group) are not patterns here.
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: TOP, env: GIT_ENV, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw new ProvisionError(`Could not run git: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new ProvisionError(`git ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  return { ok: r.status === 0, out: r.stdout };
}

function shell(command) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
}

const chunks = (list, size = 100) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function main(args) {
  const prefix = args.prefix ?? 'split/';
  const check = args.check ?? 'npx tsc --noEmit';
  const maxFiles = args['max-files'] === undefined ? 150 : Number(args['max-files']);
  if (!args.from || !args.stages) throw new UsageError('Give --from <branch> and --stages <stages.json>. Try --help.');
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new UsageError('--max-files takes a whole number, like 150.');
  TOP = '.';
  if (!git(['rev-parse', '--is-inside-work-tree'], { allowFail: true }).ok) throw new ProvisionError('Run this from inside the git repo you want to split.');
  // Git runs at the top of the repo, where its file list starts. The check and the tests run here, and the
  // paths they print are read relative to here.
  TOP = git(['rev-parse', '--show-toplevel']).out.trim();
  const here = git(['rev-parse', '--show-prefix']).out.trim();

  let stagesJson;
  try {
    stagesJson = JSON.parse(readFileSync(args.stages, 'utf8'));
  } catch (err) {
    throw new ProvisionError(err.code === 'ENOENT' ? `${args.stages} does not exist.` : `${args.stages} is not valid JSON.`);
  }
  const stages = compileStages(stagesJson);
  const order = stages.map((s) => s.name);
  // Fixed commits from here on: HEAD and other moving names change meaning once stage branches are checked out.
  const sha = (ref) => {
    const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    if (!r.ok) throw new ProvisionError(`${ref} is not a branch or commit here. Fetch it first.`);
    return r.out.trim();
  };
  const fromName = args.from;
  const baseName = args.base ?? 'origin/main';
  const from = sha(fromName);
  const base = sha(baseName);
  if (!git(['merge-base', '--is-ancestor', base, from], { allowFail: true }).ok) throw new ProvisionError(`${fromName} does not contain the latest ${baseName}. Merge ${baseName} into it first, so no stage undoes newer work.`);

  const status = parseNameStatus(git(['diff', '--no-renames', '--name-status', '-z', base, from]).out);
  if (status.size === 0) throw new ProvisionError(`${fromName} has no changes compared with ${baseName}.`);
  const { stageOf, unmatched } = assignStages([...status.keys()], stages);
  if (unmatched.length) throw new ProvisionError(`${unmatched.length} changed file(s) match no stage, for example ${unmatched.slice(0, 3).join(', ')}. End the stages with {"name": "...", "match": ".*"}.`);
  const paired = pairLockFiles(stageOf, order);
  if (paired.length) log.info(`kept with their package.json: ${paired.join(', ')}`);

  if (args['dry-run']) {
    const plan = order.map((name) => ({ name, branch: `${prefix}${name}`, files: [...stageOf].filter(([, s]) => s === name).map(([f]) => f) }));
    for (const p of plan) (p.files.length > maxFiles ? log.warn : log.info)(`${p.name}: ${p.files.length} files${p.files.length > maxFiles ? ` (over ${maxFiles})` : ''}`);
    log.ok(`dry run: ${status.size} changed files in ${plan.length} stages; nothing was changed`);
    return { ok: true, dryRun: true, stages: plan.map((p) => ({ ...p, count: p.files.length })) };
  }

  if (git(['status', '--porcelain']).out.trim()) throw new ProvisionError('This checkout has uncommitted changes. Commit or move them first: the script checks out branches here.');
  const current = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }).out.trim();
  const checkedOut = new Set([...git(['worktree', 'list', '--porcelain']).out.matchAll(/^branch refs\/heads\/(.+)$/gm)].map((m) => m[1]));
  const protectedNames = new Set([fromName, baseName, fromName.replace(/^refs\/heads\//, ''), baseName.replace(/^refs\/heads\//, '')]);
  for (const name of order) {
    const branch = `${prefix}${name}`;
    if (!git(['check-ref-format', '--branch', branch], { allowFail: true }).ok) throw new ProvisionError(`"${branch}" is not a valid branch name. Change --prefix or the stage name.`);
    if (protectedNames.has(branch) || branch === current || checkedOut.has(branch)) throw new ProvisionError(`The stage branch ${branch} is ${branch === current || checkedOut.has(branch) ? 'checked out' : `the --from or --base branch`}. Pick another --prefix.`);
    if (!args.force && git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).ok) throw new ProvisionError(`The branch ${branch} already exists. Delete it, pick another --prefix, or pass --force to reset it.`);
  }

  const aliasFile = ['tsconfig.json', 'jsconfig.json'].find((f) => existsSync(f));
  const alias = Object.fromEntries(Object.entries(aliasFile ? aliasFromTsconfig(readFileSync(aliasFile, 'utf8')) : {}).map(([k, v]) => [k, `${here}${v}`]));
  const known = new Set(status.keys());
  const importCache = new Map();
  const importsOf = (f) => {
    if (!importCache.has(f)) {
      const src = git(['show', `${from}:${f}`], { allowFail: true });
      importCache.set(f, src.ok ? importsIn(src.out).map((s) => resolveImport(f, s, known, alias)).filter(Boolean) : []);
    }
    return importCache.get(f);
  };
  const apply = (files) => {
    const gone = files.filter((f) => status.get(f) === 'D');
    const kept = files.filter((f) => status.get(f) !== 'D');
    for (const part of chunks(kept)) git(['checkout', from, '--', ...part]);
    for (const part of chunks(gone)) git(['rm', '-q', '--', ...part]);
  };

  const results = [];
  let prev = base;
  try {
    for (const name of order) {
      const branch = `${prefix}${name}`;
      // --no-track: a stage branch must never push to the base's remote branch by accident.
      git(['checkout', '-q', '--no-track', '-B', branch, prev]);
      rmSync('.next', { recursive: true, force: true });
      apply([...stageOf].filter(([, s]) => s === name).map(([f]) => f));
      const pulled = [];
      for (let round = 0; ; round++) {
        const r = shell(check);
        if (r.ok) break;
        const errFiles = errorFiles(r.out).map((f) => path.posix.normalize(`${here}${f}`));
        const pull = filesToPull({ errFiles, stageOf, order, current: name, importsOf });
        if (!pull.length || round >= 20) {
          throw new ProvisionError(`Stage ${name} does not pass "${check}" and no later file explains it. Fix the stage patterns or the code, then run again. First lines:\n${r.out.split('\n').slice(0, 20).join('\n')}`);
        }
        for (const f of pull) {
          stageOf.set(f, name);
          pulled.push(f);
        }
        apply(pull);
      }
      if (args.test) {
        const t = shell(args.test);
        if (!t.ok) throw new ProvisionError(`Stage ${name} fails "${args.test}":\n${t.out.split('\n').filter((l) => /✖|not ok|Error|fail/i.test(l)).slice(0, 20).join('\n')}`);
      }
      const msgFile = args.msgs ? path.resolve(args.msgs, name) : null;
      // --no-verify: these files already passed the commit hooks on the big branch.
      git(['commit', '-q', '--no-verify', '--allow-empty', ...(msgFile && existsSync(msgFile) ? ['-F', msgFile] : ['-m', `stage ${name}`])]);
      const changed = git(['status', '--porcelain', '--untracked-files=no']).out.trim();
      if (changed) throw new ProvisionError(`The check or tests changed tracked files on ${branch}:\n${changed}\nCommit or undo that on the big branch, then run again.`);
      const count = git(['diff', '--name-only', '-z', prev, branch]).out.split('\0').filter(Boolean).length;
      const over = count > maxFiles;
      (over ? log.warn : log.ok)(`${branch}: ${count} files${pulled.length ? `, ${pulled.length} pulled forward` : ''}${over ? ` (over ${maxFiles}: cut this stage smaller)` : ''}`);
      results.push({ name, branch, files: count, pulled, over });
      prev = branch;
    }
  } catch (err) {
    // The checkout was clean when we started, so everything here is ours: drop it and go back.
    git(['reset', '-q', '--hard'], { allowFail: true });
    git(['checkout', '-q', current || from], { allowFail: true });
    const made = results.map((r) => r.branch);
    err.message = `${err.message}\nBack on ${current || fromName}.${made.length ? ` Stage branches already made: ${made.join(', ')} (run again with --force after fixing).` : ''}`;
    throw err;
  }
  const identical = git(['diff', '--quiet', from, prev], { allowFail: true }).ok;
  if (identical) log.ok(`the last stage, ${prev}, is identical to ${fromName}`);
  else log.fail(`the last stage, ${prev}, differs from ${fromName}. Check git diff ${fromName} ${prev}`);
  return { ok: identical, identical, stages: results, ...(paired.length ? { paired } : {}) };
}

if (isMain(import.meta.url)) {
  runCli({ argv: process.argv.slice(2), spec: { string: ['from', 'base', 'prefix', 'stages', 'check', 'test', 'msgs', 'max-files'], boolean: ['dry-run', 'force'] }, help: HELP, main });
}
