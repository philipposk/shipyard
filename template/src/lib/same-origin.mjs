// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/**
 * Is this request from a page of this same site? Browsers add an `Origin` header to every POST, and a page on
 * another site cannot fake it. Use it on routes that change data with the visitor's login cookie
 * (account deletion, checkout), as a second lock next to the cookie's SameSite setting.
 * @param {{ get(name: string): string | null }} headers
 * @param {string} requestUrl the full URL of the request
 * @param {string} [siteUrl] the configured public address of the app
 */
export function isSameOrigin(headers, requestUrl, siteUrl) {
  const origin = headers.get("origin");
  if (origin) {
    if (origin === "null") return false;
    const allowed = new Set();
    for (const u of [requestUrl, siteUrl]) {
      try {
        if (u) allowed.add(new URL(u).origin);
      } catch {
        // Not a URL: ignore it.
      }
    }
    return allowed.has(origin);
  }
  // Some privacy settings strip Origin; the browser still says where the request came from.
  return headers.get("sec-fetch-site") === "same-origin";
}
