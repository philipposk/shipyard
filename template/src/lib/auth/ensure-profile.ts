import "server-only";
import { cache } from "react";
import { createSupabaseAdmin } from "@/lib/admin";
import { ensureProfileWith } from "@/lib/auth/ensure-profile.mjs";

/**
 * Makes sure the signed-in person has a `profiles` row, creating it if it is missing. Call it where the app first
 * needs the profile (the profile page, `/api/profile`, right after sign-up), only when a lookup found nothing.
 * Needed when the app shares a Supabase project and has no sign-up trigger; harmless when the trigger exists.
 * Returns false (and never throws) if it could not, for example when the server key is not set.
 */
export const ensureProfile = cache(async (userId: string, email?: string | null): Promise<boolean> => {
  try {
    return await ensureProfileWith(createSupabaseAdmin(), userId, { email });
  } catch {
    return false;
  }
});
