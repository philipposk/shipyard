import "server-only";
import { createSupabaseAdmin } from "@/lib/admin";
import { PRE_DELETE_HOOKS, ACCOUNT_DATA_TABLES } from "@/lib/account/pre-delete";
import { deleteAccountCore } from "@/lib/account/delete-account-core.mjs";
import { SUPABASE_SCHEMA } from "@/lib/supabase/schema.mjs";

type DeleteResult = { ok: true; keptLogin: boolean } | { ok: false; status: number; error: string };

/**
 * Deletes one person's account for good: runs the pre-delete hooks (a failing hook stops everything, nothing is
 * deleted), then removes the sign-in user with the server key. Rows in tables that point at auth.users with
 * `on delete cascade` go with it. Call it only for the person who is signed in and has confirmed.
 *
 * When the app shares its Supabase project with other apps (NEXT_PUBLIC_SUPABASE_SCHEMA is not `public`) the sign-in
 * user is NOT deleted, because the login belongs to the other apps too: only this app's rows (ACCOUNT_DATA_TABLES)
 * are deleted, and the result says `keptLogin: true`. See src/lib/account/delete-account-core.mjs.
 */
export async function deleteAccount(user: { id: string; email?: string | null }): Promise<DeleteResult> {
  return deleteAccountCore({
    admin: createSupabaseAdmin(),
    user,
    schema: SUPABASE_SCHEMA,
    hooks: PRE_DELETE_HOOKS,
    tables: ACCOUNT_DATA_TABLES,
  });
}
