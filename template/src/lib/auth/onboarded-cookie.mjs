// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// Web Crypto only (no node: imports), so it runs in the proxy as well as in Node.

/**
 * The "finished profile" cookie lets the proxy skip one database lookup per page. Its value must be
 * `<userId>.<signature>`, signed with a server-only secret: a plain value (like "1" or the user id) can be
 * typed into the browser by anyone to skip onboarding, and an unsigned id says nothing about who set it.
 * No secret configured means no cookie at all (the proxy then asks the database every time).
 */

const encoder = new TextEncoder();

/** The signing secret: ONBOARDED_COOKIE_SECRET, or the server key as a fallback. Never a browser-visible (public) variable. */
export function onboardedCookieSecret(env = process.env) {
  return env.ONBOARDED_COOKIE_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function toBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(userId, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // A fixed prefix keeps this signature from being reused for anything else signed with the same secret.
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`onboarded:v1:${userId}`));
  return toBase64Url(new Uint8Array(mac));
}

/**
 * The cookie value for this user, or null when there is no secret (then do not set the cookie).
 * @param {string} userId
 * @param {string} secret
 * @returns {Promise<string | null>}
 */
export async function signOnboarded(userId, secret) {
  if (!secret || typeof userId !== "string" || !userId || userId.includes(".")) return null;
  return `${userId}.${await signature(userId, secret)}`;
}

/**
 * True only when the cookie was signed by this server for exactly this user.
 * Legacy values ("1", a bare id), another person's cookie and forged signatures are all false.
 * @param {string | null | undefined} value
 * @param {string} userId
 * @param {string} secret
 */
export async function verifyOnboarded(value, userId, secret) {
  if (!secret || typeof value !== "string" || typeof userId !== "string" || !userId) return false;
  const dot = value.indexOf(".");
  if (dot <= 0 || value.slice(0, dot) !== userId) return false;
  const expected = await signature(userId, secret);
  const given = value.slice(dot + 1);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
