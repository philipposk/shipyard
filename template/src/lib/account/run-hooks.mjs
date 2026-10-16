// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/**
 * @typedef {{ userId: string, email: string | null }} DeleteContext
 * @typedef {{ id: string, label: string, run: (ctx: DeleteContext) => Promise<void> }} PreDeleteHook
 */

/**
 * Runs the "before we delete this account" steps one after another (for example: cancel the subscription).
 * Stops at the first one that fails or takes too long, so the account is NOT deleted while something
 * outside (like a paid subscription) is still running.
 * @param {PreDeleteHook[]} hooks
 * @param {DeleteContext} ctx
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, ran: string[] } | { ok: false, ran: string[], failed: { id: string, label: string, error: string } }>}
 */
export async function runPreDeleteHooks(hooks, ctx, { timeoutMs = 15_000 } = {}) {
  /** @type {string[]} */
  const ran = [];
  for (const hook of hooks) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => hook.run(ctx)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`took longer than ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
        }),
      ]);
      ran.push(hook.id);
    } catch (e) {
      return { ok: false, ran, failed: { id: hook.id, label: hook.label, error: e instanceof Error ? e.message : String(e) } };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, ran };
}

/** Does this text confirm the deletion? Case and spaces around it do not matter. @param {unknown} value */
export function isDeleteConfirmation(value) {
  return typeof value === "string" && value.trim().toUpperCase() === "DELETE";
}
