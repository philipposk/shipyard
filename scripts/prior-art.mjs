#!/usr/bin/env node
// Prior-art scan: search GitHub (with the `gh` CLI only) for existing projects that already do all or
// part of what the student wants to build, drop forks and archived repos, flag stale and unlicensed ones,
// and vet the best few. Prints a shortlist; the skill turns it into a verdict (Adopt, Extend, Compose,
// Build). No keys, no paid services, no installs: it only reads public GitHub data.
//
//   node scripts/prior-art.mjs "<query>" ["<query>" ...] [--readme "<query>"]... [--code "<query>"]... [options] [--json]
import { run } from './lib/run.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, fail, warn, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const HELP = `Usage:
  prior-art.mjs "<query>" ["<query>" ...] [options] [--json]

Each positional argument is one SHORT query (2 or 3 words). gh ANDs every word, so long sentences find nothing.
Use several synonym queries (finder, recommender, suggester, matcher ...) and ecosystem words (library, sdk, mcp, skill, cli, api).

Options:
  --readme "<q>"     extra query matched against README text (repeatable; for niche needs)
  --code "<q>"       extra search for SKILL.md files that mention it (repeatable; for agent tooling)
  --min-stars <n>    leave out repos with fewer stars (default 3)
  --limit <n>        results per search, at most 100 (default 30)
  --vet <n>          vet the top n repos: license, last push, issues, tests, real code (default 5, 0 = skip)
  --stale-months <n> flag repos with no push for this long (default 18)
  --delay-ms <n>     pause between GitHub calls (default 2500; the search API allows about 30 a minute)
  --json             machine-readable output
  --help             this text
Needs the gh CLI signed in (gh auth login). Reads public GitHub data only. Runs no security scan, never
installs, clones, stars or forks anything. Exit 0 = ran, 1 = gh missing or every search failed, 2 = bad usage.
`;

const FIELDS = 'fullName,stargazersCount,pushedAt,license,language,description,isArchived,isFork,url';
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift', 'php', 'cs', 'c', 'cc', 'cpp', 'h', 'sh', 'lua', 'ex', 'exs', 'dart', 'scala', 'vue', 'svelte']);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/i;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Months between an ISO date and now (fractional). Unknown date counts as very old. */
export function monthsSince(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? Infinity : (now - t) / (30.44 * 24 * 3600 * 1000);
}

/** gh licence object or SPDX string -> an id, or null when the repo has no usable licence. */
export function licenseId(license) {
  const id = typeof license === 'string' ? license : license?.key ?? license?.spdx_id ?? license?.name ?? null;
  if (!id || /^(none|noassertion|other)$/i.test(id)) return null;
  return id;
}

/**
 * Raw search rows -> one entry per repo, with the queries that found it. Drops forks and archived repos.
 * Input: [{ query, kind, rows }]. Returns { repos, dropped: { forks, archived } }.
 */
export function mergeResults(searches, { minStars = 0, staleMonths = 18, now = Date.now() } = {}) {
  const byName = new Map();
  const dropped = { forks: 0, archived: 0 };
  const seenDrop = new Set();
  for (const { query, kind, rows } of searches) {
    for (const r of rows ?? []) {
      const name = r.fullName ?? r.repository?.nameWithOwner;
      if (!name) continue;
      if (r.isFork || r.isArchived) {
        if (!seenDrop.has(name)) { seenDrop.add(name); dropped[r.isFork ? 'forks' : 'archived'] += 1; }
        continue;
      }
      let e = byName.get(name);
      if (!e) {
        e = { fullName: name, url: r.url ?? `https://github.com/${name}`, stars: r.stargazersCount ?? null, pushedAt: r.pushedAt ?? null, license: licenseId(r.license), language: r.language ?? null, description: r.description ?? '', foundBy: [], hits: 0 };
        byName.set(name, e);
      }
      // Code search rows carry no stars or push date: keep what repo search told us, fill gaps otherwise.
      if (e.stars == null && r.stargazersCount != null) e.stars = r.stargazersCount;
      if (!e.pushedAt && r.pushedAt) e.pushedAt = r.pushedAt;
      if (!e.license && r.license) e.license = licenseId(r.license);
      if (!e.description && r.description) e.description = r.description;
      if (!e.foundBy.includes(`${kind}:${query}`)) { e.foundBy.push(`${kind}:${query}`); e.hits += 1; }
    }
  }
  const repos = [...byName.values()]
    .filter((e) => e.stars == null || e.stars >= minStars)
    .map((e) => ({ ...e, stale: monthsSince(e.pushedAt, now) > staleMonths, referenceOnly: !e.license }))
    .sort((a, b) => b.hits - a.hits || (b.stars ?? 0) - (a.stars ?? 0) || a.fullName.localeCompare(b.fullName));
  return { repos, dropped };
}

/** One repo's files -> { codeFiles, markdownFiles, hasTests, promptOnly, truncated } from a git tree listing. */
export function summarizeTree(tree) {
  const paths = (tree?.tree ?? []).filter((n) => n.type === 'blob').map((n) => n.path);
  let codeFiles = 0;
  let markdownFiles = 0;
  for (const p of paths) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase();
    if (ext && CODE_EXT.has(ext)) codeFiles += 1;
    else if (ext === 'md' || ext === 'mdx') markdownFiles += 1;
  }
  return { codeFiles, markdownFiles, hasTests: paths.some((p) => TEST_PATH.test(p)), promptOnly: codeFiles === 0 && markdownFiles > 0, truncated: Boolean(tree?.truncated) };
}

/** Plain-language flags for one vetted repo. */
export function flagsFor(v, staleMonths = 18, now = Date.now()) {
  const flags = [];
  if (!v.license) flags.push('no licence: reference only, do not copy code (ideas are fine)');
  if (monthsSince(v.pushedAt, now) > staleMonths) flags.push(`stale: no push for over ${staleMonths} months`);
  if (v.promptOnly) flags.push('prompt-only: Markdown, no real code');
  if (v.tree && !v.hasTests) flags.push('no tests found');
  if (v.openIssues != null && v.closedIssues != null && v.openIssues > 0 && v.openIssues > v.closedIssues) flags.push('more open than closed issues');
  return flags;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Build a gh caller: one call, a polite pause before it, and one 60 s wait plus retry on HTTP 403 or 429. */
export function makeGh({ runner = run, sleeper = sleep, delayMs = 2500, rateWaitMs = 60_000 } = {}) {
  let first = true;
  return async function gh(args) {
    if (!first) await sleeper(delayMs);
    first = false;
    let r = await runner('gh', args, { timeoutMs: 60_000 });
    if (r.code !== 0 && r.code !== 127 && /HTTP (403|429)|rate limit|secondary rate/i.test(`${r.stderr}${r.stdout}`)) {
      await sleeper(rateWaitMs);
      r = await runner('gh', args, { timeoutMs: 60_000 });
    }
    return r;
  };
}

export function repoSearchArgs(query, { match = 'name,description', minStars = 3, limit = 30 } = {}) {
  const args = ['search', 'repos', query, '--match', match, '--limit', String(limit), '--json', FIELDS];
  if (minStars > 0) args.push('--stars', `>=${minStars}`);
  return args;
}

export function codeSearchArgs(query, { limit = 30 } = {}) {
  return ['search', 'code', query, '--filename', 'SKILL.md', '--limit', String(limit), '--json', 'repository'];
}

async function vetOne(gh, repo, { staleMonths, now }) {
  const name = repo.fullName;
  const v = { fullName: name, errors: [] };
  const meta = await gh(['api', `repos/${name}`]);
  const m = meta.code === 0 ? parseJson(meta.stdout) : null;
  if (!m) v.errors.push(`could not read repo data (${meta.stderr.trim().slice(0, 80) || `exit ${meta.code}`})`);
  Object.assign(v, {
    pushedAt: m?.pushed_at ?? repo.pushedAt, stars: m?.stargazers_count ?? repo.stars, openIssues: m?.open_issues_count ?? null,
    defaultBranch: m?.default_branch ?? null, topics: m?.topics ?? [], homepage: m?.homepage || null,
  });
  const lic = await gh(['api', `repos/${name}/license`]);
  const l = lic.code === 0 ? parseJson(lic.stdout) : null;
  v.license = licenseId(l?.license?.spdx_id) ?? licenseId(m?.license?.spdx_id) ?? null;
  const closed = await gh(['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${name} is:issue is:closed`, '--jq', '.total_count']);
  v.closedIssues = closed.code === 0 && /^\d+$/.test(closed.stdout.trim()) ? Number(closed.stdout.trim()) : null;
  if (v.defaultBranch) {
    const tree = await gh(['api', `repos/${name}/git/trees/${v.defaultBranch}?recursive=1`]);
    const t = tree.code === 0 ? parseJson(tree.stdout) : null;
    if (t) { v.tree = true; Object.assign(v, summarizeTree(t)); } else v.errors.push('could not list files');
  }
  const readme = await gh(['api', `repos/${name}/readme`, '-H', 'Accept: application/vnd.github.raw']);
  v.readmeStart = readme.code === 0 ? readme.stdout.replace(/\s+/g, ' ').trim().slice(0, 600) : null;
  v.flags = flagsFor(v, staleMonths, now);
  delete v.tree;
  return v;
}

/** The whole scan. `deps.gh` and `deps.now` let tests run without a network. */
export async function scan(opts, deps = {}) {
  const { queries = [], readmeQueries = [], codeQueries = [], minStars = 3, limit = 30, vet = 5, staleMonths = 18, delayMs = 2500 } = opts;
  const gh = deps.gh ?? makeGh({ delayMs });
  const now = deps.now ?? Date.now();
  const searches = [];
  const errors = [];
  let attempted = 0;
  const jobs = [
    ...queries.map((q) => ({ query: q, kind: 'name', args: repoSearchArgs(q, { match: 'name,description', minStars, limit }) })),
    ...readmeQueries.map((q) => ({ query: q, kind: 'readme', args: repoSearchArgs(q, { match: 'readme', minStars, limit }) })),
    ...codeQueries.map((q) => ({ query: q, kind: 'skill', args: codeSearchArgs(q, { limit }) })),
  ];
  for (const job of jobs) {
    attempted += 1;
    const r = await gh(job.args);
    if (r.code === 127) return { missingGh: true, errors: ['The gh CLI is not installed. Install it from https://cli.github.com and run gh auth login.'] };
    const rows = r.code === 0 ? parseJson(r.stdout) : null;
    if (!Array.isArray(rows)) { errors.push(`${job.kind} search "${job.query}" failed: ${(r.stderr || `exit ${r.code}`).trim().slice(0, 120)}`); continue; }
    searches.push({ query: job.query, kind: job.kind, rows: job.kind === 'skill' ? rows.map((x) => ({ fullName: x.repository?.nameWithOwner, url: x.repository?.url })) : rows });
  }
  const { repos, dropped } = mergeResults(searches, { minStars, staleMonths, now });
  const vetted = [];
  for (const repo of repos.slice(0, Math.max(0, vet))) vetted.push({ ...repo, vetting: await vetOne(gh, repo, { staleMonths, now }) });
  return {
    attempted, failed: errors.length, errors, dropped, candidates: repos.length,
    shortlist: repos.slice(0, 20), vetted,
    notVerified: ['No security scan was run on any repo.', 'Licences come from GitHub metadata only; read the LICENSE before reusing code.', 'Search covers GitHub only (package registries are checked separately).'],
  };
}

function table(result) {
  const rows = result.vetted.length ? result.vetted : result.shortlist;
  for (const r of rows) {
    const v = r.vetting;
    const flags = v ? v.flags : [r.stale ? 'stale' : null, r.referenceOnly ? 'no licence' : null].filter(Boolean);
    info(`${r.fullName}  ${r.stars ?? '?'} stars  pushed ${(v?.pushedAt ?? r.pushedAt ?? '?').slice(0, 10)}  ${(v?.license ?? r.license) || 'no licence'}  found by ${r.hits} quer${r.hits === 1 ? 'y' : 'ies'}`);
    if (r.description) info(`    ${r.description.slice(0, 120)}`);
    for (const f of flags) info(`    ! ${f}`);
  }
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv, { boolean: ['json', 'help'], string: ['readme', 'code', 'min-stars', 'limit', 'vet', 'stale-months', 'delay-ms'], multiple: ['readme', 'code'], alias: { h: 'help' } });
  if (args.help) { process.stdout.write(HELP); return 0; }
  setQuiet(args.json);
  const num = (name, def, max = Infinity) => {
    if (args[name] === undefined) return def;
    const n = Number(args[name]);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new UsageError(`--${name} must be a whole number${max < Infinity ? ` from 0 to ${max}` : ''}.`);
    return n;
  };
  const opts = {
    queries: args._, readmeQueries: args.readme, codeQueries: args.code,
    minStars: num('min-stars', 3), limit: Math.max(1, num('limit', 30, 100)), vet: num('vet', 5, 20),
    staleMonths: num('stale-months', 18), delayMs: num('delay-ms', 2500),
  };
  if (!opts.queries.length && !opts.readmeQueries.length && !opts.codeQueries.length) throw new UsageError('Give at least one short query. Run with --help for details.');
  const long = [...opts.queries, ...opts.readmeQueries, ...opts.codeQueries].find((q) => q.trim().split(/\s+/).length > 4);
  const result = await scan(opts, deps);
  if (result.missingGh) {
    if (args.json) json({ ok: false, error: result.errors[0] }); else fail(result.errors[0]);
    return 1;
  }
  const allFailed = result.failed === result.attempted;
  if (args.json) json({ ok: !allFailed, ...result });
  else {
    if (allFailed) fail('Every search failed. Is gh signed in (gh auth login)? Rate limited? Wait a minute and try again.');
    else ok(`${result.candidates} repos after removing ${result.dropped.forks} forks and ${result.dropped.archived} archived.`);
    if (long) warn(`"${long}" is long. gh needs every word to match, so 2 or 3 word queries find more.`);
    table(result);
    for (const e of result.errors) warn(e);
    for (const n of result.notVerified) info(`Not verified: ${n}`);
  }
  return allFailed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err.message}\n`); process.exitCode = err instanceof UsageError ? 2 : 1; },
  );
}
