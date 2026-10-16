import "server-only";
import type { User } from "@supabase/supabase-js";
import { getIsAdmin, getSessionUser } from "@/lib/session";

/** The signed-in person if they are an admin, otherwise null. Pages answer "not found" and routes 404 for everyone else. */
export async function getNewsletterAdmin(): Promise<User | null> {
  const user = await getSessionUser();
  return user && (await getIsAdmin()) ? user : null;
}
