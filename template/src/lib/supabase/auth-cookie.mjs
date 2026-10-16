// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/**
 * Supabase splits a large login cookie into `<name>.0`, `<name>.1` ... so match the base name and its parts.
 * @param {string} cookieName
 * @param {string} baseName
 */
export function isAuthCookieName(cookieName, baseName) {
  return cookieName === baseName || new RegExp(`^${escapeRegExp(baseName)}\\.\\d+$`).test(cookieName);
}

/**
 * True when the request carries a Supabase login cookie. This only says "a session might exist";
 * the server still asks Supabase to check it before trusting it.
 * @param {{ name: string }[]} cookies
 * @param {string} baseName
 */
export function hasAuthCookie(cookies, baseName) {
  return cookies.some((c) => isAuthCookieName(c.name, baseName));
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
