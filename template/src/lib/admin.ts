import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { SUPABASE_SCHEMA } from "@/lib/supabase/schema.mjs";

/**
 * Supabase with the secret server key. It skips every privacy rule (RLS), so use it only in
 * server code (routes, server actions) and always check who is asking first. Never import this file
 * from a "use client" component: `server-only` makes the build fail if you do.
 */
export function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin credentials");

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: SUPABASE_SCHEMA },
  });
}

/**
 * Admin = a profile whose `is_admin` is true. Only the secret server key can change that column
 * (see migration 0001), and Shipyard's `make-owner` script sets it for the owner.
 * Never decide admin from an email address: starter-mode sign-up does not check that the person owns the email.
 */
export async function isAdminUser(user: User): Promise<boolean> {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  return data?.is_admin === true;
}

/** Use at the top of an admin-only route: `const auth = await requireAdmin(); if ("error" in auth) return ...`. */
export async function requireAdmin() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Unauthorized", status: 401 as const };
  if (!(await isAdminUser(user))) return { error: "Forbidden", status: 403 as const };

  return { user };
}
