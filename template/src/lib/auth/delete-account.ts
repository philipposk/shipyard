import "server-only";
import { createSupabaseAdmin } from "@/lib/admin";
import { PRE_DELETE_HOOKS } from "@/lib/account/pre-delete";
import { runPreDeleteHooks } from "@/lib/account/run-hooks.mjs";

type DeleteResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Deletes one person's account for good: runs the pre-delete hooks (a failing hook stops everything, nothing is
 * deleted), then removes the sign-in user with the server key. Rows in tables that point at auth.users with
 * `on delete cascade` go with it. Call it only for the person who is signed in and has confirmed.
 */
export async function deleteAccount(user: { id: string; email?: string | null }): Promise<DeleteResult> {
  const admin = createSupabaseAdmin();

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

  const hooks = await runPreDeleteHooks(PRE_DELETE_HOOKS, { userId: user.id, email: user.email ?? null });
  if (!hooks.ok) {
    console.error(`account delete: step "${hooks.failed.id}" failed: ${hooks.failed.error}`);
    return {
      ok: false,
      status: 502,
      error: `We could not ${hooks.failed.label}, so your account was not deleted. Try again in a minute.`,
    };
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("account delete: deleteUser failed:", error.message);
    return { ok: false, status: 500, error: "We could not delete your account. Try again in a minute." };
  }
  return { ok: true };
}
