import { NextResponse, after } from "next/server";
import { createSupabaseAdmin } from "@/lib/admin";
import { sendEmail } from "@/lib/email";
import { BRAND, SITE_URL } from "@/lib/constants";
import { normalizeEmail } from "@/lib/validate.mjs";

/**
 * Forgot password: emails a one-time Supabase recovery link. It never sets a password itself.
 * A password may only change through the person's own recovery session:
 * /auth/confirm (checks the one-time token) then /reset-password (sets the new password).
 *
 * The answer is the same whether or not the account exists, and the lookup and send run after the
 * response, so neither the text nor the timing tells a caller which emails have accounts.
 */

const GENERIC_MESSAGE =
  "If an account exists for that email, we sent a link to reset your password. Check your spam folder too.";

// Best-effort limits, kept in memory per server instance.
const HOUR_MS = 60 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const EMAIL_MAX_PER_HOUR = 5;
const IP_MAX_PER_HOUR = 20;
const hits = new Map<string, number[]>();

function recentHits(key: string, now: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => now - t < HOUR_MS);
  hits.set(key, list);
  return list;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendRecoveryLink(email: string) {
  const admin = createSupabaseAdmin();
  // type "recovery" never creates a user; an unknown email is an error (404) and we stay silent.
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error || !data.properties?.hashed_token) {
    if (error && error.status !== 404) console.error("forgot-password: generateLink failed:", error.message);
    return;
  }

  // The configured site address, never the request's Host header: a forged Host would mail the token to another domain.
  const link = `${SITE_URL}/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=recovery&next=/reset-password`;
  const name = escapeHtml(BRAND.name);

  const result = await sendEmail({
    to: email,
    subject: `Reset your ${BRAND.name} password`,
    html:
      `<p>Someone asked to reset the password for your ${name} account.</p>` +
      `<p><a href="${link}">Set a new password</a></p>` +
      `<p>The link works once and expires soon.</p>` +
      `<p>If you did not ask for this, ignore this email. Your password stays the same.</p>`,
    text:
      `Someone asked to reset the password for your ${BRAND.name} account.\n\n` +
      `Set a new password: ${link}\n\n` +
      `The link works once and expires soon.\n` +
      `If you did not ask for this, ignore this email. Your password stays the same.`,
  });
  if (!result.ok) console.error("forgot-password: email send failed:", result.error);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Password reset by email is not set up for this app yet. Ask the person who runs it to reset your password." },
      { status: 503 }
    );
  }

  // Limits key on the submitted email and the caller's IP, never on whether an account exists.
  const now = Date.now();
  if (hits.size > 10_000) hits.clear();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipHits = recentHits(`ip:${ip}`, now);
  const emailHits = recentHits(`email:${email}`, now);
  const lastForEmail = emailHits[emailHits.length - 1];
  if (
    ipHits.length >= IP_MAX_PER_HOUR ||
    emailHits.length >= EMAIL_MAX_PER_HOUR ||
    (lastForEmail !== undefined && now - lastForEmail < EMAIL_COOLDOWN_MS)
  ) {
    return NextResponse.json(
      { error: "Too many reset requests. Wait a minute and try again." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  ipHits.push(now);
  emailHits.push(now);

  after(() => sendRecoveryLink(email));
  return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
}
