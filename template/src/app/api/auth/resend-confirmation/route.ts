import { NextResponse, after } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { SIGNUP_MODE, SITE_URL } from "@/lib/constants";
import { confirmRedirectUrl } from "@/lib/auth/signup-mode.mjs";
import { createLimiter } from "@/lib/rate-limit.mjs";
import { normalizeEmail } from "@/lib/validate.mjs";

/**
 * "Send the confirmation email again" (verified sign-up mode only).
 * The answer is the same whether or not the email has an account, and the send happens after the response,
 * so neither the text nor the timing tells a caller which emails are registered.
 */

const GENERIC_MESSAGE = "If this email is waiting to be confirmed, we sent a new link. Check your spam folder too.";

// Best-effort limits, kept in memory per server instance.
const perEmail = createLimiter({ windowMs: 60 * 60 * 1000, max: 5, cooldownMs: 60 * 1000 });
const perIp = createLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

async function resend(email: string) {
  try {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: confirmRedirectUrl(SITE_URL) },
    });
    if (error) console.error("resend-confirmation: Supabase said:", error.message);
  } catch (e) {
    console.error("resend-confirmation failed:", e instanceof Error ? e.message : e);
  }
}

export async function POST(request: Request) {
  if (SIGNUP_MODE !== "verified") {
    return NextResponse.json({ error: "Email confirmation is not switched on for this app." }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });

  // Limits key on the submitted email and the caller's IP, never on whether an account exists.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const blocked = [perIp.check(ip, now), perEmail.check(email, now)].find((r) => !r.ok);
  if (blocked && !blocked.ok) {
    return NextResponse.json(
      { error: "Too many requests. Wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(blocked.retryAfterSec) } }
    );
  }
  perIp.record(ip, now);
  perEmail.record(email, now);

  after(() => resend(email));
  return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
}
