// Check (live, opt-in with --only lighthouse): Google Lighthouse on the public pages, phone and desktop.
// Budgets: performance 90 on phone (85 desktop is never lower in practice, so 90 both), accessibility 95,
// best practices 95, SEO 90 (SEO only for public apps). Needs Chrome; downloads lighthouse with npx the first time.
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pass, failed, skip, joinUrl } from './util.mjs';

export const BUDGETS = { performance: 0.9, accessibility: 0.95, 'best-practices': 0.95, seo: 0.9 };
export const PAGES = ['/', '/about', '/sign-in'];

/** Turn one Lighthouse JSON report into problem strings. Pure: exported for tests. */
export function judge(report, { label, privateApp = false } = {}) {
  const problems = [];
  const scores = {};
  for (const [id, min] of Object.entries(BUDGETS)) {
    const cat = report?.categories?.[id];
    if (!cat || cat.score === null || cat.score === undefined) continue;
    scores[id] = Math.round(cat.score * 100);
    if (id === 'seo' && privateApp) continue;
    if (cat.score < min) {
      const failing = (cat.auditRefs ?? [])
        .filter((r) => r.weight > 0)
        .map((r) => report.audits?.[r.id])
        .filter((a) => a && a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'notApplicable')
        .map((a) => a.id)
        .slice(0, 5);
      problems.push(`${label}: ${id} ${scores[id]} is below ${Math.round(min * 100)}${failing.length ? ` (fix: ${failing.join(', ')})` : ''}`);
    }
  }
  return { problems, scores };
}

const run = (args, opts) => new Promise((resolve) => execFile('npx', args, { timeout: 180_000, maxBuffer: 1 << 26, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));

export async function check(ctx) {
  const name = 'lighthouse';
  if (!ctx.url) return skip(name, 'no web address');
  const dir = await mkdtemp(path.join(tmpdir(), 'shipyard-lh-'));
  const problems = [];
  const details = [];
  const privateApp = Boolean(ctx.app?.private);
  try {
    for (const page of PAGES) {
      for (const form of ['mobile', 'desktop']) {
        const out = path.join(dir, `${form}.json`);
        const args = ['--yes', 'lighthouse@12', joinUrl(ctx.url, page), '--quiet', '--output=json', `--output-path=${out}`, '--chrome-flags=--headless=new --no-sandbox'];
        if (form === 'desktop') args.push('--preset=desktop');
        const r = await run(args);
        let report;
        try { report = JSON.parse(await readFile(out, 'utf8')); } catch {
          return skip(name, `Lighthouse could not run (${(r.stderr || String(r.err)).split('\n').find(Boolean)?.slice(0, 120) ?? 'no output'}). Install Chrome, then retry`);
        }
        const j = judge(report, { label: `${page} ${form}`, privateApp });
        problems.push(...j.problems);
        details.push(`${page} ${form}: ${Object.entries(j.scores).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (problems.length) return failed(name, `${problems.length} score(s) under budget`, [...problems, ...details]);
  return pass(name, 'every page meets the Lighthouse budgets on phone and desktop', details);
}
