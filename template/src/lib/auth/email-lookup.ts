import "server-only";
import { createSupabaseAdmin } from "@/lib/admin";

/** Finds a user's id from their email (server only). Backed by the `auth_user_id_by_email` database function. */
export async function getAuthUserIdByEmail(email: string): Promise<string | null> {
  const admin = createSupabaseAdmin();
  const { data, error } = await admin.rpc("auth_user_id_by_email", {
    email: email.trim().toLowerCase(),
  });

  if (error || !data) return null;
  return data as string;
}
