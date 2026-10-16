// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/**
 * How people sign up.
 *  - "starter" (default): the server creates the account with the email already marked as confirmed.
 *    No email is sent, so it works before email sending is set up. The email is NOT proven to be theirs.
 *  - "verified": Supabase sends a confirmation email and the account works only after the link is opened.
 * Set NEXT_PUBLIC_SIGNUP_MODE and redeploy (the value is baked into the build).
 * @param {unknown} value
 * @returns {"starter" | "verified"}
 */
export function parseSignupMode(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "verified" ? "verified" : "starter";
}

/**
 * Supabase hides whether an email already has an account: when confirmation is on, signing up with an
 * existing address answers "success" with a user whose `identities` list is empty.
 * @param {{ identities?: unknown[] | null } | null | undefined} user
 */
export function isHiddenExistingUser(user) {
  return Boolean(user) && Array.isArray(user?.identities) && user.identities.length === 0;
}

/**
 * Turns a Supabase sign-up error into a status and a plain-English message.
 * @param {{ code?: string, message?: string, status?: number } | null | undefined} error
 * @returns {{ status: number, error: string }}
 */
export function signupErrorToResult(error) {
  const msg = String(error?.message ?? "").toLowerCase();
  const code = String(error?.code ?? "");
  if (code === "user_already_exists" || code === "email_exists" || msg.includes("already") || msg.includes("registered")) {
    return { status: 409, error: "This email already has an account. Sign in instead." };
  }
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || error?.status === 429) {
    return { status: 429, error: "Too many sign-ups right now. Wait a few minutes and try again." };
  }
  if (code === "weak_password") {
    return { status: 400, error: "Choose a stronger password: add more characters or a mix of letters and numbers." };
  }
  if (code === "email_address_invalid" || code === "validation_failed") {
    return { status: 400, error: "Enter a valid email." };
  }
  return { status: 400, error: "Could not create the account. Check the email and try again." };
}

/** True when a sign-in failed only because the email link was never opened. */
export function isEmailNotConfirmed(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "email_not_confirmed" || msg.includes("email not confirmed");
}

/** Where the confirmation email sends people. Built from the configured site address, never from a request header. */
export function confirmRedirectUrl(siteUrl) {
  return `${String(siteUrl).replace(/\/$/, "")}/auth/confirm`;
}
