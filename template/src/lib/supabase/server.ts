import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions } from "./cookies";
import { SUPABASE_SCHEMA } from "./schema.mjs";

/** Supabase for server code that acts as the signed-in visitor (public key + their login cookie). */
export async function createSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: authCookieOptions,
      db: { schema: SUPABASE_SCHEMA },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Pages cannot write cookies; proxy.ts refreshes the session before they render.
          }
        },
      },
    }
  );
}
