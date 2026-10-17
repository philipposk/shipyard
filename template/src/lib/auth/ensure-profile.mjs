// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
//
// Makes sure a person has a row in `profiles`. Normally a database trigger creates it when they sign up.
// When the app lives in a Supabase project shared with other apps ("shared" mode) Shipyard does not add that trigger
// (it would run for every app's sign-ups), so the app creates the row itself, the first time it needs it.
// It is safe to call any number of times, with or without the trigger: an existing row is never touched.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The name a new profile starts with. Same rule as the sign-up trigger in 0001_profiles.sql:
 * the full name if there is one, else the part of the email before the @, else "User".
 * @param {{ email?: string | null, fullName?: string | null }} [hint]
 * @returns {string}
 */
export function defaultDisplayName(hint = {}) {
  const full = typeof hint.fullName === "string" ? hint.fullName.trim() : "";
  if (full) return full.slice(0, 100);
  const email = typeof hint.email === "string" ? hint.email : "";
  const local = email.split("@")[0].trim();
  return local ? local.slice(0, 100) : "User";
}

/**
 * Inserts the profile row if it is missing (`insert ... on conflict do nothing`). Never throws.
 * @param {{ from: (table: string) => { upsert: (row: object, options: object) => PromiseLike<{ error: unknown }> } }} admin
 *   a Supabase client that uses the secret server key (the person's own key cannot be trusted to do this for them)
 * @param {string} userId
 * @param {{ email?: string | null, fullName?: string | null }} [hint]
 * @returns {Promise<boolean>} true when the row exists afterwards
 */
export async function ensureProfileWith(admin, userId, hint = {}) {
  if (typeof userId !== "string" || !UUID.test(userId)) return false;
  try {
    const { error } = await admin
      .from("profiles")
      .upsert({ id: userId, display_name: defaultDisplayName(hint) }, { onConflict: "id", ignoreDuplicates: true });
    return !error;
  } catch {
    return false;
  }
}
