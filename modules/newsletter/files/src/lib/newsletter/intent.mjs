// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// The "email me updates" box on the sign-up form. At that moment the person is not signed in yet (and in
// verified mode they have to click a link in an email first), so the tick is kept in this browser and applied the
// first time they are signed in. It is tied to the email address typed, so on a shared computer one person's tick
// can never subscribe someone else.

export const PENDING_KEY = "newsletter-optin-pending";
export const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** @param {unknown} raw the stored text @param {number} [now] @returns {{ email: string, at: number } | null} */
export function parsePending(raw, now = Date.now()) {
  if (typeof raw !== "string" || !raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value.email !== "string" || !value.email.includes("@") || typeof value.at !== "number") return null;
  if (now - value.at > PENDING_MAX_AGE_MS || value.at > now + 60000) return null;
  return { email: value.email.trim().toLowerCase(), at: value.at };
}

/** @param {string} email @param {number} [now] */
export const serializePending = (email, now = Date.now()) => JSON.stringify({ email: String(email).trim().toLowerCase(), at: now });
