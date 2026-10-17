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
  const skippedNames = result.checks.filter((c) => c.skipped).map((c) => labelFor(c.name)).join(', ');
  let summary;
  if (t.failed > 0) {
    summary = { kind: 'fail', text: `${t.failed} of ${t.passed + t.failed} checks failed. Fix these and run verify again.` };
  } else if (!result.ok && t.passed === 0) {
    summary = { kind: 'fail', text: 'NOT VERIFIED: no check could run, so nothing was checked. See "What verify did not check" below.' };
  } else if (!result.ok) {
    summary = { kind: 'fail', text: `NOT VERIFIED: ${t.passed} ${t.passed === 1 ? 'check' : 'checks'} passed, but these checks you asked for could not run: ${skippedNames}.` };
  } else if (t.skipped > 0) {
    summary = { kind: 'warn', text: `NOT FULLY VERIFIED: ${t.passed} ${t.passed === 1 ? 'check' : 'checks'} passed, ${t.skipped} could not run (${skippedNames}).` };
  } else {
    summary = { kind: 'ok', text: `All ${t.passed} checks passed.` };
  }
  lines.push({ kind: 'blank', text: '' });
  lines.push(summary);

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
