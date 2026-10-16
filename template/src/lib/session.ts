import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createSupabaseServer } from "@/lib/supabase/server";
import { hasAuthCookie } from "@/lib/supabase/cookies";

/** The verified signed-in user (Supabase checks the login), or null. Cached for one request. */
export const getSessionUser = cache(async () => {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** Cheap check for public pages that only need to pick a header: is there a login cookie? Does not call Supabase. */
export async function hasSessionCookie(): Promise<boolean> {
  return hasAuthCookie((await cookies()).getAll());
}

/**
 * Is the signed-in person an admin? Reads their own profile row with their own login (no server key).
 * Only used to decide whether to show an admin link; the admin pages check again themselves.
 */
export const getIsAdmin = cache(async (): Promise<boolean> => {
  try {
    const user = await getSessionUser();
    if (!user) return false;
    const supabase = await createSupabaseServer();
    const { data } = await supabase.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
    return data?.is_admin === true;
  } catch {
    return false;
  }
});
