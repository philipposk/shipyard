import "server-only";
import { createSupabaseAdmin } from "@/lib/admin";
import { MAX_AREA, MAX_FINGERPRINT, MAX_MESSAGE, retentionCutoff, groupErrors } from "./core.mjs";

// The only file that reads and writes the error log. It uses the secret server key (the table has no access for
// anyone else), so the pages and routes that call it check who is asking first.

export const ERROR_LOG_TABLE = "error_log";

export interface ErrorRow {
  fingerprint: string;
  area: string;
  message: string;
  created_at: string;
  resolved_at: string | null;
}

export interface NewErrorRow {
  area: string;
  fingerprint: string;
  message: string;
  user_id: string | null;
  detail: unknown;
}

export async function saveErrorRow(row: NewErrorRow): Promise<void> {
  const { error } = await createSupabaseAdmin()
    .from(ERROR_LOG_TABLE)
    .insert({
      area: row.area.slice(0, MAX_AREA),
      fingerprint: row.fingerprint.slice(0, MAX_FINGERPRINT),
      message: row.message.slice(0, MAX_MESSAGE),
      user_id: row.user_id,
      detail: row.detail ?? null,
    });
  if (error) throw new Error(error.message);
}

const since = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** The newest rows (at most 1000), for grouping on the admin page. Resolved ones only when asked. */
export async function recentRows({ includeResolved = false, days = 30 }: { includeResolved?: boolean; days?: number } = {}): Promise<ErrorRow[]> {
  let query = createSupabaseAdmin()
    .from(ERROR_LOG_TABLE)
    .select("fingerprint, area, message, created_at, resolved_at")
    .gte("created_at", since(days * 24))
    .order("created_at", { ascending: false })
    .limit(1000);
  if (!includeResolved) query = query.is("resolved_at", null);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ErrorRow[];
}

/** Marks every open row of one problem as resolved. Returns how many rows changed. */
export async function markResolved(fingerprint: string): Promise<number> {
  const { data, error } = await createSupabaseAdmin()
    .from(ERROR_LOG_TABLE)
    .update({ resolved_at: new Date().toISOString() })
    .eq("fingerprint", fingerprint)
    .is("resolved_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

/** How many different unresolved problems were logged in the last `hours` hours. */
export async function countOpenProblems(hours: number): Promise<number> {
  const { data, error } = await createSupabaseAdmin()
    .from(ERROR_LOG_TABLE)
    .select("fingerprint")
    .gte("created_at", since(hours))
    .is("resolved_at", null)
    .limit(1000);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.fingerprint)).size;
}

/** How many times something was logged in the last `hours` hours, resolved or not. */
export async function countRows(hours: number): Promise<number> {
  const { count, error } = await createSupabaseAdmin()
    .from(ERROR_LOG_TABLE)
    .select("id", { count: "exact", head: true })
    .gte("created_at", since(hours));
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** How many different problems are still unresolved, whenever they happened (within the 90 days kept). */
export async function countUnresolved(): Promise<number> {
  const rows = await recentRows({ includeResolved: false, days: 90 });
  return groupErrors(rows).length;
}

/** Deletes rows older than 90 days. The database does this daily with Supabase Cron when it is on; this is the fallback. */
export async function deleteOldRows(): Promise<void> {
  const { error } = await createSupabaseAdmin().from(ERROR_LOG_TABLE).delete().lt("created_at", retentionCutoff());
  if (error) throw new Error(error.message);
}

/** The email addresses of the people who are admins in the app (their sign-in email). At most 5. */
export async function adminEmails(): Promise<string[]> {
  const db = createSupabaseAdmin();
  const { data, error } = await db.from("profiles").select("id").eq("is_admin", true).limit(5);
  if (error) throw new Error(error.message);
  const out: string[] = [];
  for (const row of data ?? []) {
    const { data: found } = await db.auth.admin.getUserById(row.id);
    if (found?.user?.email) out.push(found.user.email);
  }
  return out;
}
