import "server-only";
import { NextResponse } from "next/server";
import { BRAND, SITE_URL } from "@/lib/constants";
import { alertRecipients, describeError, fingerprintFor } from "./core.mjs";
import { createReporter, type ErrorReport } from "./reporter.mjs";
import { adminEmails, saveErrorRow } from "./store";

export type { ErrorReport };

// Resend (the email service). The shared test sender only delivers to the owner of the Resend account.
async function sendThroughResend(email: { to: string[]; subject: string; text: string; html: string; idempotencyKey: string }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, disabled: true };
  const from = process.env.RESEND_FROM || `${BRAND.name} <onboarding@resend.dev>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Resend drops a second request with the same key, so two servers can not send the same alert twice.
        "Idempotency-Key": email.idempotencyKey,
      },
      body: JSON.stringify({ from, to: email.to, subject: email.subject, html: email.html, text: email.text }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Resend ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.name : "email failed" };
  }
}

const reporter = createReporter({
  save: saveErrorRow,
  send: sendThroughResend,
  configured: () => Boolean(process.env.RESEND_API_KEY),
  recipients: async () => {
    let admins: string[] = [];
    try {
      admins = await adminEmails();
    } catch {
      // The setting in ADMIN_EMAIL still works.
    }
    return alertRecipients(process.env.ADMIN_EMAIL, admins);
  },
  env: process.env,
  brandName: BRAND.name,
  siteUrl: SITE_URL,
});

/**
 * Writes down a problem behind a friendly message: the server log, the error_log table (at most one row a minute for
 * the same `fingerprint`), and an email to the owner (at most once per ERROR_ALERT_HOURS, default 6, for the same
 * fingerprint). Secrets, tokens and passwords are removed from everything. Never throws.
 */
export const reportError: (report: ErrorReport) => Promise<void> = reporter.reportError;

/**
 * Reports `err` and returns what to tell the person: "Couldn't <what>. Please try again."
 * `what` finishes the sentence, for example "save your changes". Supabase's own text names tables and columns, which
 * means nothing to a visitor, so it never goes into a response.
 */
export async function reportFailure(area: string, err: unknown, what: string): Promise<string> {
  const message = describeError(err);
  await reportError({ area, fingerprint: fingerprintFor(area, message), message });
  return `Couldn't ${what}. Please try again.`;
}

/** reportFailure as a route's answer: status 500 with `{ error, ...extra }`. */
export async function serverError(area: string, err: unknown, what = "finish that", extra?: Record<string, unknown>) {
  return NextResponse.json({ error: await reportFailure(area, err, what), ...extra }, { status: 500 });
}
