// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// The health checks every app has. Each one only READS: it never changes anything and never puts a key,
// password or token into its answer (names of settings and public addresses only).
import { normalizeEmail } from "../validate.mjs";
import { missingControllerFields, sectionsWithPlaceholders, validateSections } from "../legal-helpers.mjs";

/** @typedef {import("./run.mjs").HealthCheck} HealthCheck */

const DRAFT_REMINDER = "Reminder: the legal text is a draft. Have a lawyer or an accountant check it before you take payments.";
const SECURITY_HEADERS = ["x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy", "permissions-policy"];

/** @param {string | undefined} value */
function parseUrl(value) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

/** @param {string} host */
function isLocalHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

/** The domain of a sender like `App <noreply@send.example.org>`. @param {string | undefined} from */
export function senderDomain(from) {
  const m = /@([^\s>]+)>?\s*$/.exec(String(from ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   fetch: typeof fetch,
 *   siteUrl: string,
 *   signupMode: "starter" | "verified",
 *   contactEmail: string,
 *   legal: { controller: { name: string, address: string, email: string, country: string }, privacy: any[], terms: any[] },
 *   queryDatabase: () => Promise<{ ok: boolean, message?: string }>,
 * }} deps
 * @returns {HealthCheck[]}
 */
export function createTemplateChecks({ env, fetch: doFetch, siteUrl, signupMode, contactEmail, legal, queryDatabase }) {
  const site = parseUrl(siteUrl);
  const production = env.VERCEL_ENV ? env.VERCEL_ENV === "production" : env.NODE_ENV === "production";
  const supabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  return [
    {
      id: "database",
      label: "Database",
      async run() {
        if (!supabaseUrl || !anonKey) {
          return { status: "fail", detail: "The app does not know where its database is.", fix: "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the Vercel settings, then redeploy." };
        }
        const r = await queryDatabase();
        if (r.ok) return { status: "ok", detail: "The database answers." };
        return { status: "fail", detail: `The database did not answer a simple question${r.message ? ` (${r.message})` : ""}.`, fix: "Check that the Supabase project is running and not paused, then reload this page." };
      },
    },
    {
      id: "signup-mode",
      label: "Sign-up",
      async run({ signal }) {
        if (signupMode !== "verified") {
          return {
            status: "warn",
            detail: "Anyone can sign up without confirming their email.",
            fix: "Before real people use the app, set up email with the launch skill, then set NEXT_PUBLIC_SIGNUP_MODE=verified in Vercel and redeploy.",
          };
        }
        if (supabaseUrl && anonKey) {
          try {
            const res = await doFetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: anonKey }, signal });
            if (res.ok) {
              const settings = await res.json().catch(() => null);
              if (settings?.mailer_autoconfirm === true) {
                return {
                  status: "fail",
                  detail: "The app asks for email confirmation, but Supabase is set to skip it, so sign-ups are not checked.",
                  fix: "In Supabase open Authentication, then Sign In / Providers, then Email, and turn on Confirm email.",
                };
              }
              return { status: "ok", detail: "New accounts must confirm their email first." };
            }
          } catch (e) {
            if (signal.aborted) throw e;
          }
        }
        return { status: "warn", detail: "The app asks for email confirmation. Supabase's own setting could not be checked.", fix: "In Supabase, Authentication, Sign In / Providers, Email: make sure Confirm email is on." };
      },
    },
    {
      id: "site-url",
      label: "Public address",
      async run() {
        if (!production) return { status: "skip", detail: "Not checked while you build on your own computer." };
        if (!site) return { status: "fail", detail: "NEXT_PUBLIC_SITE_URL is missing or is not a web address.", fix: "Set NEXT_PUBLIC_SITE_URL in the Vercel settings to your live address and redeploy." };
        if (isLocalHost(site.hostname)) {
          return { status: "fail", detail: "The app still thinks its address is localhost, so email links and sign-in return would point to your computer.", fix: "Set NEXT_PUBLIC_SITE_URL in the Vercel settings to your live address and redeploy." };
        }
        if (site.protocol !== "https:") return { status: "fail", detail: `The public address ${site.origin} is not https.`, fix: "Use an address that starts with https://." };
        if (site.hostname.endsWith(".vercel.app")) {
          return { status: "warn", detail: `The app is still on its test address (${site.hostname}).`, fix: "Add your own domain with the launch skill before you take payments." };
        }
        return { status: "ok", detail: `The public address is ${site.origin}.` };
      },
    },
    {
      id: "contact-email",
      label: "Contact email",
      async run() {
        const fromEnv = normalizeEmail(contactEmail);
        const fromLegal = normalizeEmail(legal.controller.email);
        if (fromEnv || fromLegal) return { status: "ok", detail: `People are told to write to ${fromLegal || fromEnv}.` };
        if (contactEmail.trim()) return { status: "warn", detail: "NEXT_PUBLIC_CONTACT_EMAIL is set but does not look like an email address.", fix: "Fix NEXT_PUBLIC_CONTACT_EMAIL in the Vercel settings and redeploy." };
        return { status: "warn", detail: "No contact email is set, so the legal pages cannot say how to reach you.", fix: "Set NEXT_PUBLIC_CONTACT_EMAIL in the Vercel settings to an address you read, then redeploy." };
      },
    },
    {
      id: "legal-controller",
      label: "Legal pages",
      async run() {
        const missing = missingControllerFields(legal.controller);
        const textProblems = [...validateSections(legal.privacy).map((p) => `Privacy: ${p}`), ...validateSections(legal.terms).map((p) => `Terms: ${p}`)];
        const unfinished = [...sectionsWithPlaceholders(legal.privacy), ...sectionsWithPlaceholders(legal.terms)];
        if (textProblems.length > 0 || unfinished.length > 0) {
          const bits = [...textProblems, ...(unfinished.length ? [`unfinished text in ${unfinished.join(", ")}`] : [])];
          return { status: "warn", detail: `The legal text has problems: ${bits.join("; ")}.`, fix: "Run the launch skill's legal step again to write the text fresh." };
        }
        if (missing.length > 0) {
          return {
            status: "warn",
            detail: `The legal pages do not say who runs the app yet (missing: ${missing.join(", ")}). They show the app name instead. ${DRAFT_REMINDER}`,
            fix: "Run the launch skill's legal step. It asks for these details and writes the pages.",
          };
        }
        return { status: "ok", detail: `The legal pages name ${legal.controller.name}. ${DRAFT_REMINDER}` };
      },
    },
    {
      id: "email-sending",
      label: "Email sending",
      async run({ signal }) {
        const key = env.RESEND_API_KEY;
        if (!key) return { status: "skip", detail: "No email sending is set up, so the app sends no emails of its own.", fix: "To send password-reset and welcome emails, set up email with the launch skill." };
        const from = env.RESEND_FROM;
        if (!from) {
          return { status: "warn", detail: "RESEND_FROM is not set, so emails come from Resend's test address, which only reaches you.", fix: "Set RESEND_FROM to an address on your verified sending domain." };
        }
        const domain = senderDomain(from);
        if (!domain || domain === "resend.dev") {
          return { status: "warn", detail: "Emails are sent from Resend's test address, which only reaches you.", fix: "Verify your own sending domain with the launch skill and use an address on it." };
        }
        let res;
        try {
          res = await doFetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` }, signal });
        } catch (e) {
          if (signal.aborted) throw e;
          return { status: "warn", detail: "Resend could not be reached to check the sending domain.", fix: "Reload this page in a minute." };
        }
        if (res.status === 401 || res.status === 403) {
          return { status: "warn", detail: "The Resend key can send emails but is not allowed to list domains, so the domain could not be checked.", fix: "Check the domain in the Resend dashboard, under Domains." };
        }
        if (!res.ok) return { status: "warn", detail: `Resend answered ${res.status} when asked about domains.`, fix: "Reload this page in a minute." };
        const body = await res.json().catch(() => null);
        const list = Array.isArray(body?.data) ? body.data : [];
        const match = list.find((d) => typeof d?.name === "string" && (domain === d.name.toLowerCase() || domain.endsWith(`.${d.name.toLowerCase()}`)));
        if (!match) return { status: "warn", detail: `Resend does not know the sending domain ${domain}.`, fix: "Add and verify it with the launch skill (launch-email)." };
        if (match.status === "verified") return { status: "ok", detail: `The sending domain ${domain} is verified.` };
        return { status: "warn", detail: `The sending domain ${domain} is not verified yet (Resend says: ${String(match.status)}).`, fix: "Add the DNS records Resend shows at your domain registrar, then run launch-email with --check." };
      },
    },
    {
      id: "security-headers",
      label: "Security headers",
      async run({ signal }) {
        if (!site || isLocalHost(site.hostname)) return { status: "skip", detail: "Not checked while the public address is localhost." };
        let res;
        try {
          res = await doFetch(`${site.origin}/api/health`, { signal });
        } catch (e) {
          if (signal.aborted) throw e;
          return { status: "skip", detail: "The app could not reach its own public address to check." };
        }
        const missing = SECURITY_HEADERS.filter((h) => !res.headers.get(h));
        if (missing.length === 0) return { status: "ok", detail: "The protective headers are on every page." };
        return { status: "warn", detail: `These protective headers are missing: ${missing.join(", ")}.`, fix: "They are set in next.config.ts. Restore them, or check that nothing in front of the app strips them." };
      },
    },
  ];
}
