// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/**
 * A small in-memory limiter: at most `max` hits per `windowMs` for a key, and at least `cooldownMs` between two hits.
 * It lives in one server instance's memory, so it is a brake on abuse, not a guarantee. Check first, record after you act.
 * @param {{ windowMs: number, max: number, cooldownMs?: number, maxKeys?: number }} options
 */
export function createLimiter({ windowMs, max, cooldownMs = 0, maxKeys = 10_000 }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  /** @param {string} key @param {number} now */
  function recent(key, now) {
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length === 0) hits.delete(key);
    else hits.set(key, list);
    return list;
  }

  return {
    /** @param {string} key @param {number} [now] @returns {{ ok: true } | { ok: false, retryAfterSec: number }} */
    check(key, now = Date.now()) {
      const list = recent(key, now);
      const last = list[list.length - 1];
      if (last !== undefined && cooldownMs > 0 && now - last < cooldownMs) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cooldownMs - (now - last)) / 1000)) };
      }
      if (list.length >= max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000)) };
      }
      return { ok: true };
    },
    /** @param {string} key @param {number} [now] */
    record(key, now = Date.now()) {
      if (hits.size >= maxKeys) hits.clear();
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
    },
  };
}
