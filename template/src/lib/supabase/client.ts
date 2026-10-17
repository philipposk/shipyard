import { createBrowserClient } from "@supabase/ssr";
import { authCookieOptions } from "./cookies";
import { SUPABASE_SCHEMA } from "./schema.mjs";

/** Supabase for code that runs in the browser. Uses the public key, so every query obeys the privacy rules (RLS). */
export function createSupabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: authCookieOptions, db: { schema: SUPABASE_SCHEMA } }
  );
}

export type AppSupabaseClient = ReturnType<typeof createSupabaseBrowser>;
