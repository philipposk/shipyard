// Check (no network): problems found across real 6x7 apps in Oct 2026 that the other checks miss.
//   1. Links and buttons with no accessible name (icon-only, or text hidden at phone size). Lighthouse "link-name"/"button-name".
//   2. The app is still marked private (noindex) although it has public pages. Reported as a warning, not a failure:
//      private can be on purpose, but the owner must say so.
//   3. CI that cannot pass: `uses: ./local-action` that does not exist, `npm ci` with no package-lock.json,
//      a package-lock.json out of step with package.json, or workspace packages tests import from dist/ without a build step first.
//   4. Sign-in API routes that crash when Supabase env vars are missing (`process.env.X!`) instead of answering cleanly.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripComments, pass, failed } from './util.mjs';

const exists = async (p) => stat(p).then(() => true, () => false);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', '.vercel']);

async function walk(dir, test, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

const HIDDEN_CLASS = /className\s*=\s*["{`][^>]*?(?:^|[\s"'`:])hidden\b/;

/** Links/buttons in JSX source with no accessible name. Returns [{ line, snippet }]. Pure: exported for tests. */
export function unlabeledControls(source) {
  const code = stripComments(source);
  const out = [];
  const re = /<(Link|a|button)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(code))) {
    const [whole, tag, attrs, selfClose] = m;
    if (/\baria-label(?:ledby)?\s*=|\btitle\s*=|\{\s*\.\.\./.test(attrs)) continue;
    if (selfClose) { out.push({ index: m.index, snippet: whole }); continue; }
    const end = code.indexOf(`</${tag}>`, re.lastIndex);
    if (end < 0) continue;
    let inner = code.slice(re.lastIndex, end);
    // Text inside elements hidden at some size does not name the control at that size.
    inner = inner.replace(/<(\w+)\b([^>]*)>[\s\S]*?<\/\1>/g, (all, _t, a) => (HIDDEN_CLASS.test(`className=${a.split('className=')[1] ?? ''}`) && /\bhidden\b/.test(a) ? '' : all));
    // Elements whose own attributes say aria-label count as a name.
    if (/aria-label\s*=|\balt\s*=\s*["{][^"}]/.test(inner)) continue;
    const text = inner.replace(/<[A-Z][\w.]*\b[^>]*\/>/g, '').replace(/<\/?[^>]+>/g, '').trim();
    if (!text) out.push({ index: m.index, snippet: whole });
  }
  return out.map((o) => ({ line: code.slice(0, o.index).split('\n').length, snippet: o.snippet.replace(/\s+/g, ' ').slice(0, 90) }));
}

/** package-lock.json root deps must equal package.json deps. Returns problem strings. Pure: exported for tests. */
export function lockDrift(pkg, lock) {
  const root = lock?.packages?.[''];
  if (!root) return [];
  const problems = [];
  for (const field of ['dependencies', 'devDependencies']) {
    const want = pkg[field] ?? {};
    const have = root[field] ?? {};
    for (const [name, spec] of Object.entries(want)) {
      if (have[name] !== spec) problems.push(`${name} ${spec} is in package.json ${field} but the lock file has ${have[name] ?? 'nothing'}`);
    }
    for (const name of Object.keys(have)) if (!(name in want)) problems.push(`${name} is in the lock file but not in package.json ${field}`);
  }
  return problems;
}

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export async function check(ctx) {
  const name = 'hygiene';
  const problems = [];
  const details = [];
  const warnings = [];
  const dir = ctx.appDir;
  const srcDir = (await exists(path.join(dir, 'src'))) ? path.join(dir, 'src') : dir;

  // 1. Accessible names.
  const files = await walk(srcDir, (n) => /\.(tsx|jsx)$/.test(n) && !/\.test\./.test(n));
  let bad = 0;
  for (const f of files) {
    for (const u of unlabeledControls(await readFile(f, 'utf8'))) {
      bad++;
      if (bad <= 10) problems.push(`${path.relative(dir, f)}:${u.line} ${u.snippet} has no name a screen reader can read (text hidden at some sizes counts as none). Add aria-label`);
    }
  }
  if (bad > 10) problems.push(`...and ${bad - 10} more links or buttons without a name`);
  if (!bad) details.push(`${files.length} component files: every link and button has a name`);

  // 2. Private marker.
  const env = await readFile(path.join(dir, '.env.local'), 'utf8').catch(() => '');
  for (const marker of ['.6x7-private', '.shipyard-private']) {
    if (await exists(path.join(dir, marker))) warnings.push(`${marker} is present, so every page is noindex and the sitemap is empty. Keep it only if the owner said the app is private; delete it to go public`);
  }
  if (/^NEXT_PUBLIC_SITE_PRIVATE\s*=\s*"?true/m.test(env)) warnings.push('NEXT_PUBLIC_SITE_PRIVATE=true: search engines skip every page. Confirm with the owner that this is wanted');

  // 3. CI.
  const wfDir = path.join(dir, '.github', 'workflows');
  const workflows = await walk(wfDir, (n) => /\.ya?ml$/.test(n));
  const pkg = await readJson(path.join(dir, 'package.json'));
  const hasLock = await exists(path.join(dir, 'package-lock.json'));
  for (const wf of workflows) {
    const text = await readFile(wf, 'utf8');
    const rel = path.relative(dir, wf);
    for (const [, local] of text.matchAll(/uses:\s*['"]?(\.\/[^\s'"#]+)/g)) {
      if (!(await exists(path.join(dir, local)))) problems.push(`${rel} uses ${local}, which does not exist in the repo, so the job fails before it starts`);
    }
    if (/\bnpm ci\b/.test(text) && !hasLock && pkg) warnings.push(`${rel} runs npm ci but there is no package-lock.json. Run npm install and commit the lock file`);
    const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
    if (ws?.length && /\bnpm (?:run )?test\b/.test(text)) {
      const testAt = text.search(/\bnpm (?:run )?test\b/);
      const buildBefore = /\bnpm run build\b|turbo (?:run )?build|--workspaces|-ws\b/.test(text.slice(0, testAt));
      const needsBuild = [];
      for (const pattern of ws) {
        const base = path.join(dir, pattern.replace(/\/\*.*$/, ''));
        const dirs = pattern.includes('*') ? (await readdir(base, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => path.join(base, e.name)) : [base];
        for (const d of dirs) {
          const p = await readJson(path.join(d, 'package.json'));
          if (p?.scripts?.build && /dist\//.test(JSON.stringify([p.main, p.module, p.exports, p.types]))) needsBuild.push(p.name ?? path.basename(d));
        }
      }
      if (needsBuild.length && !buildBefore) problems.push(`${rel} runs the tests before building the workspace packages ${needsBuild.join(', ')}, whose code lives in dist/. Add "npm run build --workspaces --if-present" before the tests`);
    }
  }
  if (hasLock && pkg) {
    const drift = lockDrift(pkg, await readJson(path.join(dir, 'package-lock.json')));
    if (drift.length) problems.push(`package-lock.json is out of step with package.json, so npm ci fails in CI: ${drift.slice(0, 3).join('; ')}. Run npm install and commit the lock file`);
  }
  if (workflows.length) details.push(`${workflows.length} workflow file(s) checked`);

  // 4. Sign-in routes and missing env.
  const authRoutes = await walk(path.join(srcDir, 'app', 'api', 'auth'), (n) => /^route\.(ts|js|mjs)$/.test(n));
  for (const f of authRoutes) {
    const code = stripComments(await readFile(f, 'utf8'));
    if (/process\.env\.\w+!/.test(code)) problems.push(`${path.relative(dir, f)} reads env vars with "!", so it throws a 500 when they are not set (preview, CI). Check them and answer cleanly (no user, or 503 with a message)`);
  }

  const extra = warnings.length ? { warnings } : {};
  if (problems.length) return failed(name, `${problems.length} problem(s) that break accessibility, search or CI`, [...problems, ...warnings.map((w) => `warning: ${w}`)], extra);
  return pass(name, 'names, search settings, CI and sign-in routes look right', [...details, ...warnings.map((w) => `warning: ${w}`)], extra);
}
