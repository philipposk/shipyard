#!/usr/bin/env node
// Turn a saved review result (the review skill's review workflow) into fix batches, one per area, and waves:
// batches in one wave never share a file, so their fixers can run at the same time without editing over each other.
// The plan is the `batches` and `waves` input of workflows/fix-waves.js. Built-ins only, no network.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli, isMain, ProvisionError } from '../provision/common.mjs';
import { UsageError } from '../lib/log.mjs';
import * as log from '../lib/log.mjs';

const HELP = `
Plan the fix waves for a saved review result.

Usage:
  node plan-waves.mjs <review.json> [--skip 3,12] [--strong auth,data] [--repo <dir>] [--out <plan.json>] [--json]

  --skip     finding numbers to leave out (positions in "confirmed", from 0): deferred, or waiting for a decision
  --strong   areas whose fixer should get your strongest model (sign-in, data rules, live audio, AI costs)
  --repo     the app folder, so absolute file paths in the findings become relative ones
  --out      where to save the plan (default: plan.json next to the review file)
`;

// Top-level folders a file path usually starts with inside an app. Only a fallback when neither --repo nor the
// review's own `repo` is known: a parent folder with one of these names ("app") would cut the path too early.
const TOP_DIRS = new Set(['src', 'app', 'lib', 'components', 'pages', 'scripts', 'supabase', 'public', 'docs', 'tests', 'test', 'e2e', 'packages', 'server', 'api']);

/** A finding's file as a path inside the repo, without ":line" or a trailing "(note)". Pure. */
export function normFile(file, repo = '') {
  let f = String(file ?? '').trim().replace(/\\/g, '/').replace(/ \(.*$/, '').replace(/:\d+(?::\d+)?$/, '');
  const root = String(repo).replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && f.startsWith(`${root}/`)) f = f.slice(root.length + 1);
  else if (f.startsWith('/') || /^[A-Za-z]:\//.test(f)) {
    const parts = f.split('/');
    const at = parts.findIndex((p, i) => i > 0 && TOP_DIRS.has(p));
    if (at > 0) f = parts.slice(at).join('/');
  }
  return f.replace(/^\.\//, '');
}

/**
 * review: { repo?, confirmed: [{ area, where: "file:line", files?: [...] }] }. Finding ids are positions in `confirmed`.
 * Returns { batches: [{ k, strong, ids, files }], waves: [[k, ...]] }: the busiest batches first, each placed in
 * the first wave it shares no file with. Pure.
 */
export function planWaves(review, { skip = [], strong = [], repo = review?.repo ?? '' } = {}) {
  if (!review || !Array.isArray(review.confirmed)) throw new ProvisionError('The review file has no "confirmed" list. Save the whole result of the review workflow.');
  const skipped = new Set(skip.map(Number));
  const strongAreas = new Set(strong);
  const byArea = new Map();
  review.confirmed.forEach((x, id) => {
    if (skipped.has(id)) return;
    const k = String(x?.area || 'other');
    if (!byArea.has(k)) byArea.set(k, { k, strong: strongAreas.has(k), ids: [], files: new Set() });
    const b = byArea.get(k);
    b.ids.push(id);
    for (const f of [x?.where, ...(Array.isArray(x?.files) ? x.files : [])]) {
      const n = normFile(f, repo);
      if (n) b.files.add(n);
    }
  });
  const batches = [...byArea.values()].map((b) => ({ ...b, files: [...b.files].sort() }));
  const overlaps = (a, b) => a.files.some((f) => b.files.includes(f));
  const degree = new Map(batches.map((b) => [b, batches.filter((o) => o !== b && overlaps(b, o)).length]));
  batches.sort((a, b) => degree.get(b) - degree.get(a) || a.k.localeCompare(b.k));
  const waves = [];
  for (const b of batches) {
    let w = waves.find((wave) => wave.every((o) => !overlaps(o, b)));
    if (!w) {
      w = [];
      waves.push(w);
    }
    w.push(b);
  }
  return { batches, waves: waves.map((w) => w.map((b) => b.k)) };
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export async function main(args) {
  const file = args._[0];
  if (!file) throw new UsageError('Give the saved review result, for example: node plan-waves.mjs review.json');
  const skip = list(args.skip);
  const notNumbers = skip.filter((s) => !/^\d+$/.test(s));
  if (notNumbers.length) throw new UsageError(`--skip takes finding numbers separated by commas, not "${notNumbers.join(', ')}".`);
  let review;
  try {
    review = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new ProvisionError(err.code === 'ENOENT' ? `${file} does not exist.` : `${file} is not valid JSON.`);
  }
  const strong = list(args.strong);
  const plan = planWaves(review, { skip: skip.map(Number), strong, ...(args.repo ? { repo: path.resolve(args.repo) } : {}) });
  const unknown = strong.filter((k) => !plan.batches.some((b) => b.k === k));
  const out = path.resolve(args.out ?? path.join(path.dirname(path.resolve(file)), 'plan.json'));
  await writeFile(out, `${JSON.stringify(plan, null, 1)}\n`);
  plan.waves.forEach((w, i) => log.info(`wave ${i + 1}: ${w.map((k) => `${k} (${plan.batches.find((b) => b.k === k).ids.length})`).join(', ')}`));
  if (unknown.length) log.warn(`No findings in ${unknown.join(', ')}, so --strong did nothing there.`);
  log.ok(`${plan.batches.length} batches in ${plan.waves.length} waves, saved to ${out}`);
  return { ok: true, out, batches: plan.batches.map(({ k, strong: s, ids, files }) => ({ k, strong: s, ids, files: files.length })), waves: plan.waves, ...(unknown.length ? { unknownStrong: unknown } : {}) };
}

if (isMain(import.meta.url)) {
  runCli({ argv: process.argv.slice(2), spec: { string: ['skip', 'strong', 'repo', 'out'] }, help: HELP, main });
}
