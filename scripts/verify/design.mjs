// Check (no network): the app's own design rules. Runs the app's scripts/design-check.mjs, which looks in src/
// for hard-coded colours, gradients, em dashes, emoji, placeholder text, fake numbers, native pop-ups,
// small inputs and "Tip:" boxes. The same script runs in the app's CI.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/run.mjs';
import { pass, failed, skip } from './util.mjs';

const MAX_SHOWN = 15;

/** Plain-English name for each rule, so a beginner reads "a colour typed in directly", not "hard-coded-colour". */
const PLAIN = {
  'hard-coded-colour': 'a colour typed in directly',
  gradient: 'a gradient',
  'em-dash': 'a long dash in text',
  'emoji-in-ui': 'an emoji in text',
  'placeholder-text': 'placeholder text',
  'fake-proof': 'an invented number or logo claim',
  'ai-badge': 'an "AI" badge',
  'native-alert': 'a browser pop-up',
  'small-input-text': 'input text under 16px',
  'tip-box': 'a "Tip:" box',
};

export async function check(ctx) {
  const name = 'design';
  // Relative path on purpose: see the secrets check (a symlinked folder would otherwise make the script do nothing).
  const script = path.join('scripts', 'design-check.mjs');
  const hasScript = await stat(path.join(ctx.appDir, script)).then(() => true, () => false);
  if (!hasScript) return skip(name, 'this app has no scripts/design-check.mjs (it was made with an older Shipyard; copy it from the template)');

  const res = await run(process.execPath, [script, '--json'], { cwd: ctx.appDir, timeoutMs: 60_000 });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }

  if (res.code === 0 && parsed?.ok) {
    return pass(name, 'no design-rule problems', [`checked ${parsed.scanned} source files`]);
  }
  if (res.code === 1 && Array.isArray(parsed?.findings)) {
    const lines = parsed.findings.map((f) => `${f.file}:${f.line} ${PLAIN[f.rule] ?? f.rule}: ${f.hint}`);
    const shown = lines.slice(0, MAX_SHOWN);
    if (lines.length > shown.length) shown.push(`...and ${lines.length - shown.length} more (run npm run check:design in the app for the full list)`);
    const n = parsed.findings.length;
    return failed(name, `${n} design-rule problem${n === 1 ? '' : 's'}`, shown);
  }
  return failed(name, 'the design check could not run', [parsed?.error ?? 'it needs Node and the app\'s src folder']);
}
