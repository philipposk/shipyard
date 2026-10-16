// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 72;
export const MAX_ITEM_TITLE_LENGTH = 120;
export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_BIO_LENGTH = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercased, trimmed email, or null when it does not look like one. @param {unknown} value */
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** Returns a plain-English problem, or null when the password is fine. @param {unknown} value */
export function passwordProblem(value) {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
  }
  // Supabase (bcrypt) ignores everything after 72 bytes, so refuse longer ones instead of silently cutting.
  if (new TextEncoder().encode(value).length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${MAX_PASSWORD_LENGTH} characters for your password.`;
  }
  return null;
}

/** Trimmed title or null when empty or too long. @param {unknown} value */
export function normalizeItemTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.trim().replace(/\s+/g, " ");
  return title.length > 0 && title.length <= MAX_ITEM_TITLE_LENGTH ? title : null;
}

/**
 * Cleans the profile form. Returns `{ value }` or `{ error }` in plain English.
 * @param {unknown} input
 * @returns {{ value: { display_name: string, bio: string } } | { error: string }}
 */
export function parseProfileInput(input) {
  const body = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const bio = typeof body.bio === "string" ? body.bio.trim() : "";
  if (!displayName) return { error: "Enter a display name." };
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return { error: `Keep your display name under ${MAX_DISPLAY_NAME_LENGTH} characters.` };
  }
  if (bio.length > MAX_BIO_LENGTH) return { error: `Keep your bio under ${MAX_BIO_LENGTH} characters.` };
  return { value: { display_name: displayName, bio } };
}
