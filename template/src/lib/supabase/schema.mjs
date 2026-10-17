// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
//
// Which database "folder" (Postgres schema) this app's tables live in. Almost always `public`.
// When Shipyard puts the app inside a Supabase project that other apps already use ("shared" mode), the app gets
// its own schema (for example `app_notes`) and Shipyard sets NEXT_PUBLIC_SUPABASE_SCHEMA to its name.
// Every Supabase client in the app (browser, server, proxy, admin) reads it from here, so they always agree.

/** Lowercase letters, digits and underscores, starting with a letter. The same rule Shipyard uses to create it. */
const SCHEMA_NAME = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * Turns the raw setting into a schema name. Empty or missing means `public`.
 * A value that is not a valid name stops the app with a plain message, instead of quietly using `public`
 * (which in a shared project belongs to other apps).
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function resolveSchema(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "" || value === "public") return "public";
  if (!SCHEMA_NAME.test(value)) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_SCHEMA is not a valid database schema name. Use lowercase letters, digits and underscores (for example app_notes), or leave it empty."
    );
  }
  return value;
}

/** The schema every Supabase client in this app uses. (The literal env name below is what lets the browser build see it.) */
export const SUPABASE_SCHEMA = resolveSchema(process.env.NEXT_PUBLIC_SUPABASE_SCHEMA);
