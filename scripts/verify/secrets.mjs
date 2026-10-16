// Check: no keys in the files git tracks, and the private env files are not tracked or are ignored.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/run.mjs';
import { pass, failed } from './util.mjs';
import { findServerKeyMisuse } from './server-key.mjs';

const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_OK = /\.(example|sample|template)$/;

export async function check(ctx) {
  const name = 'secrets';
  const details = [];
  const problems = [];

  const scanPath = path.join(ctx.appDir, 'scripts', 'secret-scan.mjs');
  const hasScan = await stat(scanPath).then(() => true, () => false);
  if (!hasScan) problems.push('scripts/secret-scan.mjs is missing, so keys could be pushed without anyone noticing');

  const tracked = await run('git', ['ls-files', '-z'], { cwd: ctx.appDir });
  if (tracked.code !== 0) {
    problems.push('this folder is not a git repository yet, so tracked files could not be checked (run git init)');
    return failed(name, 'could not check tracked files', problems);
  }
  const files = tracked.stdout.split('\0').filter(Boolean);

  // Private env files must never be tracked.
  const envTracked = files.filter((f) => ENV_FILE.test(f) && !ENV_OK.test(f));
  for (const f of envTracked) problems.push(`${f} is tracked by git. It holds keys. Run: git rm --cached ${f}`);
  if (envTracked.length === 0) details.push('no .env file is tracked by git');

  // .env.local must be ignored, so a careless "git add ." cannot pick it up.
  const ignored = await run('git', ['check-ignore', '-q', '.env.local'], { cwd: ctx.appDir });
  if (ignored.code === 0) details.push('.env.local is ignored by git');
  else if (ignored.code === 1) problems.push('.env.local is not in .gitignore, so "git add ." could upload your keys');

  if (hasScan) {
    // Relative path on purpose: the scanner only starts when node's idea of its path matches the real path,
    // and an absolute path through a symlinked folder (macOS /var -> /private/var) would not.
    const scan = await run(process.execPath, [path.join('scripts', 'secret-scan.mjs'), '--json'], { cwd: ctx.appDir, timeoutMs: 60_000 });
    let parsed = null;
    try {
      parsed = JSON.parse(scan.stdout);
    } catch {
      parsed = null;
    }
    if (scan.code === 0 && parsed?.ok) {
      details.push(`scanned ${files.length} tracked files, no keys found`);
    } else if (scan.code === 1 && Array.isArray(parsed?.findings)) {
      // Findings name the file, line and kind of key. The scanner never prints the key itself.
      for (const f of parsed.findings) {
        if (envTracked.includes(f.file)) continue; // already reported above
        problems.push(`${f.file}${f.line ? `:${f.line}` : ''} looks like a ${f.pattern}. Remove it, and replace the key if it was ever pushed`);
      }
    } else {
      problems.push('the key scan could not run (it needs Node and a git repository)');
    }
  }

  // The secret server key skips every privacy rule, so it may only be used in a few files.
  const misuse = await findServerKeyMisuse(ctx.appDir);
  for (const f of misuse.files) {
    problems.push(`${f} uses the secret server key (it skips every privacy rule, so one missing filter shows everyone's data). Use the signed-in person's own client (createSupabaseServer) instead`);
  }
  if (misuse.checked && misuse.files.length === 0) details.push('the secret server key is used only in the files allowed to');

  // The pre-push hook only runs if git is pointed at the .githooks folder.
  const hooks = await run('git', ['config', '--get', 'core.hooksPath'], { cwd: ctx.appDir });
  const warnings = [];
  if (hooks.stdout.trim() !== '.githooks') warnings.push('the pre-push key scan is not switched on here (run: git config core.hooksPath .githooks)');

  if (problems.length > 0) return failed(name, `${problems.length} problem${problems.length === 1 ? '' : 's'} with keys`, problems, { details, warnings });
  return pass(name, 'no keys in tracked files', details, { warnings });
}
