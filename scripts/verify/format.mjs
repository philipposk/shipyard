// Turns a verify result into lines for the screen. Pure functions: easy to test.
import { NEVER_CHECKED } from './index.mjs';

const LABELS = {
  secrets: 'Keys', proxy: 'Sign-in gate', design: 'Design rules', routes: 'Pages', protection: 'Public access',
  auth: 'Sign-in', isolation: 'Privacy between users', browser: 'Phone browser',
};
export const labelFor = (name) => LABELS[name] ?? name;

/** Count passed / failed / skipped checks. */
export function tally(checks) {
  return {
    passed: checks.filter((c) => c.ok && !c.skipped).length,
    failed: checks.filter((c) => !c.ok).length,
    skipped: checks.filter((c) => c.skipped).length,
  };
}

/**
 * Lines to print: [{ kind: 'ok'|'fail'|'warn'|'info'|'blank', text }].
 * `result` = { checks, notRun, ok, url }.
 */
export function formatReport(result) {
  const lines = [];
  for (const c of result.checks) {
    const label = labelFor(c.name);
    if (c.skipped) {
      lines.push({ kind: 'warn', text: `${label}: not checked (${c.reason})` });
      continue;
    }
    lines.push({ kind: c.ok ? 'ok' : 'fail', text: `${label}: ${c.summary}` });
    for (const p of c.problems ?? []) lines.push({ kind: 'fail', text: `  ${p}` });
    for (const d of c.details ?? []) lines.push({ kind: 'info', text: `- ${d}` });
    for (const w of c.warnings ?? []) lines.push({ kind: 'warn', text: w });
  }

  const t = tally(result.checks);
  lines.push({ kind: 'blank', text: '' });
  lines.push({
    kind: result.ok ? 'ok' : 'fail',
    text: result.ok
      ? `All ${t.passed} checks that ran passed${t.skipped ? `, ${t.skipped} could not run` : ''}.`
      : `${t.failed} of ${t.passed + t.failed} checks failed. Fix these and run verify again.`,
  });

  const notChecked = [
    ...result.checks.filter((c) => c.skipped).map((c) => `${labelFor(c.name)}: ${c.reason}`),
    ...(result.notRun ?? []).map((n) => `${labelFor(n)}: left out with --only`),
  ];
  lines.push({ kind: 'blank', text: '' });
  lines.push({ kind: 'info', text: 'What verify did not check:' });
  for (const n of notChecked) lines.push({ kind: 'info', text: `  - ${n}` });
  for (const n of NEVER_CHECKED) lines.push({ kind: 'info', text: `  - ${n}` });
  return lines;
}

/** Compact record saved in the profile (apps[].lastVerify) for the settings page. */
export function summarizeForProfile(result) {
  const t = tally(result.checks);
  return {
    at: result.ranAt,
    ok: result.ok,
    url: result.url ?? '',
    passed: t.passed,
    failed: t.failed,
    skipped: t.skipped,
    failedChecks: result.checks.filter((c) => !c.ok).map((c) => c.name),
    skippedChecks: result.checks.filter((c) => c.skipped).map((c) => c.name),
  };
}
