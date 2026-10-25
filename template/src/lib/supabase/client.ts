import { createBrowserClient } from "@supabase/ssr";
import { authTimeoutFetch } from "./auth-fetch.mjs";
import { authCookieOptions } from "./cookies";
import { SUPABASE_SCHEMA } from "./schema.mjs";

/** Supabase for code that runs in the browser. Uses the public key, so every query obeys the privacy rules (RLS). Auth calls time out (auth-fetch.mjs); storage uploads do not. */
export function createSupabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: authCookieOptions, db: { schema: SUPABASE_SCHEMA }, global: { fetch: authTimeoutFetch() } }
  );
}

export type AppSupabaseClient = ReturnType<typeof createSupabaseBrowser>;
