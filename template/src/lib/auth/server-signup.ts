import "server-only";
import { createSupabaseAdmin } from "@/lib/admin";
import { createSupabaseServer } from "@/lib/supabase/server";
import { GOOGLE_SIGNIN_ENABLED, SIGNUP_MODE, SITE_URL } from "@/lib/constants";
import { confirmRedirectUrl, isHiddenExistingUser, signupErrorToResult } from "@/lib/auth/signup-mode.mjs";

type SignupResult =
  | { ok: true; userId?: string; needsConfirmation: boolean }
  | { ok: false; status: number; error: string };

/**
 * Creates an account. Two modes (NEXT_PUBLIC_SIGNUP_MODE):
 *
 * "starter" (default): the server creates the account with the email already marked as confirmed, so no
 * email is needed and sign-up works before email sending is set up. The email is NOT proven to belong to
 * the person, so two things are refused: the owner's email (ADMIN_EMAIL; the owner account is made by
 * Shipyard's `make-owner` script) and any sign-up at all once Google sign-in is on (an unverified
 * password account made with someone else's Google address could later be linked to that person's login).
 *
 * "verified": Supabase sends a confirmation email (over the SMTP set up with `launch-email`) and the
 * account works only after the link is opened. The owner's email is still refused.
 *
 * In both modes an email that already has an account gets a 409 and its password is never touched.
 */
export async function serverSignup(email: string, password: string): Promise<SignupResult> {
  const trimmed = email.trim().toLowerCase();
  const ownerEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (ownerEmail && trimmed === ownerEmail) {
    return { ok: false, status: 403, error: "This email belongs to the owner of this app. Sign in with the account Shipyard created." };
  }
  // Only starter mode skips the proof that the email is theirs, so only there can a made-up account be linked to
  // someone's Google login. Verified mode proves it with the confirmation link.
  if (SIGNUP_MODE === "starter" && GOOGLE_SIGNIN_ENABLED) {
    return { ok: false, status: 403, error: "Sign up with Google. Email sign-up is switched off until email confirmation is set up." };
  }

  return SIGNUP_MODE === "verified" ? verifiedSignup(trimmed, password) : starterSignup(trimmed, password);
}

async function starterSignup(email: string, password: string): Promise<SignupResult> {
  const admin = createSupabaseAdmin();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: email.split("@")[0] },
  });

  if (error) {
    const msg = error.message.toLowerCase();
    if (error.code === "email_exists" || msg.includes("already") || msg.includes("registered")) {
      return { ok: false, status: 409, error: "This email already has an account. Sign in instead." };
    }
    return { ok: false, status: 400, error: "Could not create the account. Check the email and try again." };
  }

  return { ok: true, userId: data.user?.id, needsConfirmation: false };
}

async function verifiedSignup(email: string, password: string): Promise<SignupResult> {
  // The person's own (signed-out) client: Supabase itself sends the confirmation email.
  // This client also keeps the one-time code check in a cookie, so opening the link in the same browser works.
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: confirmRedirectUrl(SITE_URL),
      data: { full_name: email.split("@")[0] },
    },
  });

  if (error) return { ok: false, ...signupErrorToResult(error) };
  if (isHiddenExistingUser(data.user)) {
    return { ok: false, status: 409, error: "This email already has an account. Sign in instead." };
  }
  // No session means Supabase is waiting for the confirmation link. (A session means confirmation is switched off
  // in Supabase; the Health page flags that.)
  return { ok: true, needsConfirmation: !data.session };
}
