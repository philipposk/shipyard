// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// The brain of reportError: what gets logged, what gets emailed, and how often. The database and the email service are
// passed in (`save`, `send`, `recipients`), so tests use fakes and the app (report.ts) passes the real ones.
// Nothing here throws: reporting a failure must never become a second failure.
import {
  LOG_GAP_MS, MAX_AREA, MAX_FINGERPRINT, MAX_MESSAGE, alertIdempotencyKey, buildAlertEmail, createGate, createRateLimit,
  parseAlertHours, scrubDetail, scrubText,
} from "./core.mjs";

/** All the emails one server sends in an hour, whatever the problem: a flood of new problems must not flood an inbox. */
export const MAX_ALERTS_PER_HOUR = 10;

/**
 * @typedef {{
 *   area: string, fingerprint: string, message: string, userId?: string | null, detail?: unknown,
 *   subject?: string, summary?: string, action?: string, email?: boolean, emailEveryHours?: number,
 *   emailKey?: string, emailMessage?: string,
 * }} ErrorReport
 * `emailKey`: problems with the same key share one email slot (default: each fingerprint has its own).
 * `emailMessage`: text for the email instead of the stored message (for reports whose words came from a stranger).
 */

/**
 * Makes a reporter. Pass the real database and email service in the app, fakes in tests.
 * @param {{
 *   save: (row: { area: string, fingerprint: string, message: string, user_id: string | null, detail: unknown }) => Promise<void>,
 *   send: (email: { to: string[], subject: string, text: string, html: string, idempotencyKey: string }) => Promise<{ ok: boolean, disabled?: boolean, error?: string }>,
 *   recipients: () => Promise<string[]>,
 *   configured?: () => boolean,
 *   env?: Record<string, string | undefined>,
 *   brandName: string,
 *   siteUrl: string,
 *   now?: () => number,
 *   log?: { error: (...args: unknown[]) => void },
 * }} deps
 */
export function createReporter(deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const env = deps.env ?? {};
  const logGate = createGate({ windowMs: LOG_GAP_MS });
  const emailGates = new Map(); // window in ms -> gate
  const hourly = createRateLimit({ windowMs: 3_600_000, max: MAX_ALERTS_PER_HOUR, maxKeys: 1 });

  const gateFor = (windowMs) => {
    let g = emailGates.get(windowMs);
    if (!g) {
      g = createGate({ windowMs });
      emailGates.set(windowMs, g);
    }
    return g;
  };

  /** @param {ErrorReport} report */
  async function reportError(report) {
    try {
      const area = scrubText(report.area, MAX_AREA) || "unknown";
      const fingerprint = scrubText(report.fingerprint || area, MAX_FINGERPRINT);
      const message = scrubText(report.message, MAX_MESSAGE) || "(no message)";
      const at = now();
      // Printed to the server log (Vercel shows it) after cleaning, like everything else.
      log.error(`[${area}]`, message.split("\n")[0].slice(0, 300));

      const jobs = [];
      if (logGate.allow(fingerprint, at)) {
        jobs.push(
          deps
            .save({ area, fingerprint, message, user_id: report.userId ?? null, detail: scrubDetail(report.detail) })
            .catch((e) => log.error("[errors] could not save:", scrubText(e instanceof Error ? e.message : e, 200))),
        );
      }
      if (report.email !== false) jobs.push(alert({ report, area, fingerprint, message, at }));
      await Promise.all(jobs);
    } catch (e) {
      log.error("[errors] could not report:", scrubText(e instanceof Error ? e.message : e, 200));
    }
  }

  async function alert({ report, area, fingerprint, message, at }) {
    try {
      if (deps.configured && !deps.configured()) return false; // no email service: logging is all there is
      const hours = report.emailEveryHours && report.emailEveryHours > 0 ? report.emailEveryHours : parseAlertHours(env.ERROR_ALERT_HOURS);
      const windowMs = hours * 3_600_000;
      const gate = gateFor(windowMs);
      const slot = report.emailKey ? scrubText(report.emailKey, MAX_FINGERPRINT) : fingerprint;
      // Set before waiting for anything, so six failures at once in this server send one email.
      if (!gate.allow(slot, at)) return false;
      if (!hourly.hit("all", at)) {
        gate.forget(slot);
        return false;
      }
      const to = await deps.recipients();
      if (to.length === 0) {
        gate.forget(slot);
        return false;
      }
      const { subject, text, html } = buildAlertEmail({
        brandName: deps.brandName, area, subject: report.subject, summary: report.summary, action: report.action,
        message: report.emailMessage ?? message, siteUrl: deps.siteUrl, hours, at,
      });
      const res = await deps.send({ to, subject, text, html, idempotencyKey: alertIdempotencyKey(slot, at, windowMs) });
      // 409 = another server already sent this window's email. Not having an email service is not an error either.
      if (!res.ok && !res.disabled && !/\b409\b/.test(res.error ?? "")) log.error("[errors] email:", scrubText(res.error, 200));
      return res.ok;
    } catch (e) {
      log.error("[errors] email:", scrubText(e instanceof Error ? e.message : e, 200));
      return false;
    }
  }

  return { reportError };
}
