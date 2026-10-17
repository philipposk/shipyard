// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
//
// What "delete my account" does. In an app that has its own Supabase project, the sign-in user is deleted and every
// table that points at auth.users with `on delete cascade` empties itself.
//
// In an app that shares its Supabase project with other apps ("shared" mode, schema other than `public`) the sign-in
// user belongs to every app there. Deleting it would remove the person's login and, through the other apps' cascading
// foreign keys, their data in those apps. So there only THIS app's rows are deleted, and the login stays.
import { runPreDeleteHooks } from "./run-hooks.mjs";

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Deletes the person's rows from each listed table of this app (the `profiles` table last). Stops at the first error.
 * @param {{ from: (table: string) => { delete: () => { eq: (column: string, value: string) => PromiseLike<{ error: { message: string } | null }> } } }} admin
 * @param {string} userId
 * @param {{ table: string, column: string }[]} tables
 * @returns {Promise<{ ok: true, tables: string[] } | { ok: false, table: string, error: string }>}
 */
export async function deleteOwnRows(admin, userId, tables) {
  const ordered = [...tables.filter((t) => t.table !== "profiles"), ...tables.filter((t) => t.table === "profiles")];
  const done = [];
  for (const { table, column } of ordered) {
    if (!NAME.test(table) || !NAME.test(column)) return { ok: false, table: String(table), error: "not a valid table or column name" };
    const { error } = await admin.from(table).delete().eq(column, userId);
    if (error) return { ok: false, table, error: error.message };
    done.push(table);
  }
  return { ok: true, tables: done };
}

/**
 * @typedef {{ ok: true, keptLogin: boolean } | { ok: false, status: number, error: string }} DeleteResult
 */

/**
 * @param {{
 *   admin: any,
 *   user: { id: string, email?: string | null },
 *   schema: string,
 *   hooks: import("./run-hooks.mjs").PreDeleteHook[],
 *   tables: { table: string, column: string }[],
 *   logError?: (...args: unknown[]) => void,
 * }} input
 * @returns {Promise<DeleteResult>}
 */
export async function deleteAccountCore({ admin, user, schema, hooks, tables, logError = console.error }) {
  // The last admin cannot delete themselves: nobody would be left to run the app.
  const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  if (profile?.is_admin === true) {
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("is_admin", true);
    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        status: 409,
        error: "You are the only admin of this app, so this account cannot be deleted. Make someone else an admin first.",
      };
    }
  }

  const ran = await runPreDeleteHooks(hooks, { userId: user.id, email: user.email ?? null });
  if (!ran.ok) {
    logError(`account delete: step "${ran.failed.id}" failed: ${ran.failed.error}`);
    return {
      ok: false,
      status: 502,
      error: `We could not ${ran.failed.label}, so your account was not deleted. Try again in a minute.`,
    };
  }

  if (schema !== "public") {
    // Shared project: the login belongs to the other apps too. Delete only what this app stores, never the user.
    const rows = await deleteOwnRows(admin, user.id, tables);
    if (!rows.ok) {
      logError(`account delete: removing your rows from "${rows.table}" failed: ${rows.error}`);
      return { ok: false, status: 500, error: "We could not delete your data. Try again in a minute." };
    }
    return { ok: true, keptLogin: true };
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    logError("account delete: deleteUser failed:", error.message);
    return { ok: false, status: 500, error: "We could not delete your account. Try again in a minute." };
  }
  return { ok: true, keptLogin: false };
}
