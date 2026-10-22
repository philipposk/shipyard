// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/** The one-time link types Supabase emails. */
export const OTP_TYPES = ["recovery", "signup", "invite", "magiclink", "email", "email_change"];

/**
 * Reads a one-time email link (`token_hash` and `type`) from query values or form values.
 * Returns null when either is missing or the type is not one we know.
 * @param {{ get(name: string): string | null | FormDataEntryValue }} params
 * @returns {{ tokenHash: string, type: string, next: string | null } | null}
 */
export function parseConfirmParams(params) {
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  if (typeof tokenHash !== "string" || !tokenHash) return null;
  if (typeof type !== "string" || !OTP_TYPES.includes(type)) return null;
  const next = params.get("next");
  return { tokenHash, type, next: typeof next === "string" ? next : null };
}

/** Where the emailed link sends the browser first: a page with a button, never a sign-in on GET. */
export function continuePath({ tokenHash, type, next }) {
  const q = new URLSearchParams({ token_hash: tokenHash, type });
  if (next) q.set("next", next);
  return `/auth/confirm/continue?${q.toString()}`;
}

/** Where a failed link ends up. */
export function failedPath(type) {
  if (type === "recovery") return "/sign-in?mode=forgot&error=link_expired";
  if (type === "signup" || type === "email") return "/sign-in?error=confirm_failed";
  return "/sign-in?error=auth";
}
