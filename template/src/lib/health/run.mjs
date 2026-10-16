// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/**
 * @typedef {"ok" | "warn" | "fail" | "skip"} HealthStatus
 * @typedef {{ status: HealthStatus, detail: string, fix?: string }} HealthResult
 * @typedef {{ id: string, label: string, run: (ctx: { signal: AbortSignal }) => Promise<HealthResult> }} HealthCheck
 * @typedef {HealthResult & { id: string, label: string }} HealthReportItem
 */

export const HEALTH_STATUSES = ["ok", "warn", "fail", "skip"];

/** How each status is written on the page. */
export const STATUS_WORDS = { ok: "OK", warn: "Warning", fail: "Problem", skip: "Skipped" };

const MAX_TEXT = 400;

/** One line of plain text that is safe to show: no line breaks, not endless. @param {unknown} value */
function plain(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/**
 * Runs every check at the same time, each with its own time limit. A check that throws, answers nonsense or takes
 * too long becomes a "fail" line; one broken check never hides the others. Results keep the order of `checks`.
 * @param {HealthCheck[]} checks
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<HealthReportItem[]>}
 */
export async function runChecks(checks, { timeoutMs = 5000 } = {}) {
  return Promise.all(
    checks.map(async (check) => {
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`no answer after ${Math.round(timeoutMs / 1000)} seconds`));
          }, timeoutMs);
        });
        const result = /** @type {HealthResult} */ (await Promise.race([Promise.resolve().then(() => check.run({ signal: controller.signal })), timeout]));
        if (!result || !HEALTH_STATUSES.includes(result.status)) {
          return { id: check.id, label: check.label, status: "fail", detail: "This check gave an answer the page could not read.", fix: "Tell whoever maintains the app." };
        }
        const item = { id: check.id, label: check.label, status: result.status, detail: plain(result.detail) };
        return result.fix ? { ...item, fix: plain(result.fix) } : item;
      } catch (e) {
        const why = plain(e instanceof Error ? e.message : e);
        return { id: check.id, label: check.label, status: "fail", detail: `Could not run this check: ${why}.`, fix: "Reload the page. If it keeps failing, look at the app's logs in Vercel." };
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

/** Counts per status and one sentence for the top of the page. @param {HealthReportItem[]} items */
export function summarize(items) {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const i of items) counts[i.status] += 1;
  const parts = [];
  if (counts.fail) parts.push(`${counts.fail} ${counts.fail === 1 ? "problem" : "problems"}`);
  if (counts.warn) parts.push(`${counts.warn} ${counts.warn === 1 ? "warning" : "warnings"}`);
  const headline = parts.length ? parts.join(", ") : "Everything checked looks good";
  return { counts, headline };
}
