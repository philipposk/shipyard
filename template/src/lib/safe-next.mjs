// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/**
 * Where to send someone after sign-in. Only paths on this same site are allowed, so a crafted link like
 * `?next=//evil.example` or `?next=/\evil.example` cannot bounce a signed-in visitor to another site.
 * @param {string | null | undefined} next
 * @param {string} [fallback]
 */
export function safeNext(next, fallback = "/") {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  // Browsers drop tabs and newlines inside URLs, so "/\t/evil.example" would turn into "//evil.example".
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  // Never send people back to the sign-in page itself.
  if (next === "/sign-in" || next.startsWith("/sign-in?") || next.startsWith("/sign-in/")) return fallback;
  return next;
}
