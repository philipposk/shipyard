// Browser sign-in calls give up after AUTH_TIMEOUT_MS. The sign-in page shows AUTH_TIMEOUT_MESSAGE
// instead of spinning. Storage uploads and ordinary data reads are not cut off.
//
// The proxy and the server session check use a shorter limit (AUTH_REQUEST_MS each, AUTH_DEADLINE_MS
// for the whole check). A stalled database otherwise holds the request until the host kills it, and
// the visitor sees a spinner or a bare timeout page.
// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

export const AUTH_TIMEOUT_MS = 20_000;
export const AUTH_TIMEOUT_MESSAGE = "Sign-in isn't responding, try again in a few minutes.";
export const AUTH_REQUEST_MS = 3_000;
export const AUTH_DEADLINE_MS = 5_000;

/** @param {RequestInfo | URL} input */
function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * @param {number} timeoutMs
 * @param {boolean} authOnly  when true, only `/auth/v1/` is limited
 * @param {string | undefined} message  abort reason the sign-in page can recognise
 * @param {typeof fetch} base
 * @returns {typeof fetch}
 */
function limitedFetch(timeoutMs, authOnly, message, base = fetch) {
  return (input, init) => {
    const url = urlOf(input);
    // Never time out storage. A slow upload must be allowed to finish.
    if (url.includes("/storage/v1/")) return base(input, init);
    if (authOnly && !url.includes("/auth/v1/")) return base(input, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(message ? new Error(message) : undefined), timeoutMs);
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    return base(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

/** Browser Supabase client: only `/auth/v1/` calls, about 20s, with a message the sign-in page can show. */
export function authTimeoutFetch(base = fetch, ms = AUTH_TIMEOUT_MS) {
  return limitedFetch(ms, true, AUTH_TIMEOUT_MESSAGE, base);
}

/** One Supabase Auth request from the server. Does not apply to storage or data reads. */
export function authRequestFetch(base = fetch, ms = AUTH_REQUEST_MS) {
  return limitedFetch(ms, true, undefined, base);
}

/**
 * Proxy only. Times out auth and the one profile read the gate does. Storage is still left alone.
 * Data queries in pages are not made through this.
 */
export function gateFetch(base = fetch, ms = AUTH_REQUEST_MS) {
  return limitedFetch(ms, false, undefined, base);
}

/** @param {unknown} error */
export function isAuthTimeout(error) {
  if (!error || typeof error !== "object") return false;
  const record = /** @type {{ message?: unknown, name?: unknown }} */ (error);
  if (record.message === AUTH_TIMEOUT_MESSAGE) return true;
  return record.name === "AbortError" || record.name === "TimeoutError";
}

/**
 * Stop waiting after `ms` even if the request keeps retrying. Supabase Auth retries a failed
 * network call for up to about 30s on its own, which is long enough to look frozen.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<{ timedOut: true } | { timedOut: false, value: T }>}
 */
export function withDeadline(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([promise.then((value) => ({ timedOut: false, value })), timeout]).finally(() => clearTimeout(timer));
}
