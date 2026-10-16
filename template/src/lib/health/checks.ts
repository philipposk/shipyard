import "server-only";
import { createSupabaseServer } from "@/lib/supabase/server";
import { CONTACT_EMAIL, SIGNUP_MODE, SITE_URL } from "@/lib/constants";
import * as legal from "@/lib/legal-content";
import { createTemplateChecks } from "@/lib/health/template-checks.mjs";

export type HealthStatus = "ok" | "warn" | "fail" | "skip";

export interface HealthResult {
  status: HealthStatus;
  /** What was found, in plain English. Never a key, password or token. */
  detail: string;
  /** What to do about it, in plain English. Only for warn and fail. */
  fix?: string;
}

/** One line on the admin Health page. `run` only reads; it is stopped after 5 seconds. */
export interface HealthCheck {
  id: string;
  label: string;
  run: (ctx: { signal: AbortSignal }) => Promise<HealthResult>;
}

/** A simple read as the signed-in admin: proves the app can reach its database. */
async function queryDatabase() {
  try {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.from("profiles").select("id").limit(1);
    return error ? { ok: false, message: error.code ?? "database error" } : { ok: true };
  } catch {
    return { ok: false, message: "no connection" };
  }
}

/**
 * Everything the Health page runs, in this order. Modules append their own checks (billing adds the Stripe ones);
 * Shipyard's add-module finds the list by the name HEALTH_CHECKS, so keep the name.
 * Each check reads only; none may show a secret value.
 */
export const HEALTH_CHECKS: HealthCheck[] = [
  ...createTemplateChecks({
    env: process.env,
    fetch,
    siteUrl: SITE_URL,
    signupMode: SIGNUP_MODE,
    contactEmail: CONTACT_EMAIL,
    legal,
    queryDatabase,
  }),
];
