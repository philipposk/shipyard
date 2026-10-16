import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next.mjs";

const OTP_TYPES: EmailOtpType[] = ["recovery", "signup", "invite", "magiclink", "email", "email_change"];

/**
 * Email links land here:
 *  - password reset (built from a Supabase `hashed_token`, see /api/auth/forgot-password),
 *  - "confirm your email" after sign-up in verified mode (token_hash, or a one-time `code` in Supabase's standard link).
 * verifyOtp / exchangeCodeForSession check the one-time value on the server and write the login cookie.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");

  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      // A recovery link always ends on the new-password form, never straight in the app.
      const dest = type === "recovery" ? "/reset-password" : safeNext(searchParams.get("next"), "/");
      return NextResponse.redirect(`${origin}${dest}`);
    }
  } else if (code) {
    // Supabase's standard confirmation link. It works in the browser that asked for the sign-up.
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${safeNext(searchParams.get("next"), "/")}`);
  }

  const failed =
    type === "recovery"
      ? "/sign-in?mode=forgot&error=link_expired"
      : type === "signup" || type === "email" || code
        ? "/sign-in?error=confirm_failed"
        : "/sign-in?error=auth";
  return NextResponse.redirect(`${origin}${failed}`);
}
