import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next.mjs";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { SITE_URL } from "@/lib/constants";
import { continuePath, failedPath, parseConfirmParams } from "@/lib/auth/confirm-link.mjs";

/**
 * Email links land here:
 *  - password reset (built from a Supabase `hashed_token`, see /api/auth/forgot-password),
 *  - "confirm your email" after sign-up in verified mode (token_hash, or a one-time `code` in Supabase's standard link).
 *
 * A one-time token is never used on a plain GET. Mail scanners open every link in an email and would use the
 * token up before the person clicks, and a crafted link could sign a visitor into someone else's account.
 * So a token link only shows a page with a button (/auth/confirm/continue), and the button POSTs here.
 * The `code` link is safe on GET: it only works in the browser that asked for it (it needs that browser's cookie).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const link = parseConfirmParams(searchParams);
  if (link) return NextResponse.redirect(`${origin}${continuePath(link)}`, 303);

  const code = searchParams.get("code");
  if (code) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${safeNext(searchParams.get("next"), "/")}`);
    return NextResponse.redirect(`${origin}/sign-in?error=confirm_failed`);
  }
  return NextResponse.redirect(`${origin}/sign-in?error=auth`);
}

export async function POST(request: Request) {
  const { origin } = new URL(request.url);
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.redirect(`${origin}/sign-in?error=auth`, 303);
  }
  const form = await request.formData().catch(() => null);
  const link = form ? parseConfirmParams(form) : null;
  if (!link) return NextResponse.redirect(`${origin}/sign-in?error=auth`, 303);

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.verifyOtp({ type: link.type as EmailOtpType, token_hash: link.tokenHash });
  if (error) return NextResponse.redirect(`${origin}${failedPath(link.type)}`, 303);

  // A recovery link always ends on the new-password form, never straight in the app.
  const dest = link.type === "recovery" ? "/reset-password" : safeNext(link.next, "/");
  return NextResponse.redirect(`${origin}${dest}`, 303);
}
