import { parseSignupMode } from "@/lib/auth/signup-mode.mjs";

// ---------------------------------------------------------------------------------------------
// The app's identity: the ONE place to change its name, slogan, address and contact email.
//
// Every page, email, legal page, the browser tab, the share card and the home page read BRAND below.
// public/manifest.webmanifest and public/llms.txt are copied from it by `npm run sync:brand`, which also runs
// before every `npm run dev` and `npm run build`. Shipyard's own scripts (phone and desktop apps, emails,
// Stripe, legal pages, verify) read it too, so renaming the app is one edit here. A phone or desktop app that
// is already made picks up the new name the next time Shipyard's add-shell runs.
//
// What lives elsewhere, on purpose:
// - Colours, fonts and shapes: src/lib/theme.ts and src/app/globals.css, changed with /shipyard:design.
// - The live address and contact email: NEXT_PUBLIC_SITE_URL and NEXT_PUBLIC_CONTACT_EMAIL (.env.local and Vercel),
//   because they differ between your computer and the live site.
// - SITE_SLUG and the phone app id (.shipyard-app.json, "shells") are permanent ids: the web address, database,
//   login cookie and installed phone apps depend on them. Changing the name never changes them.
// ---------------------------------------------------------------------------------------------

/** Permanent id of the app (folder, repository, login cookie). Not shown to visitors. */
export const SITE_SLUG = "<APP_SLUG>";
/** The name people see. */
export const SITE_NAME = "<APP_NAME>";
/** Under the app icon on a phone: 12 characters at most. */
export const SITE_SHORT_NAME = "<APP_SHORT_NAME>";
/** One or two sentences: search results, share cards, the install prompt, llms.txt. */
export const SITE_DESCRIPTION = "<APP_DESCRIPTION>";
/** The short line under the name on the home page. */
export const SITE_TAGLINE = "<APP_TAGLINE>";
/** Public address of the app. Falls back to localhost while you build. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
/** Where people write to the person who runs the app. Shown on the legal pages. Public on purpose. */
export const CONTACT_EMAIL = (process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "").trim();

/** Use BRAND everywhere the app name, slogan, address or contact email appears. Never type them into a component. */
export const BRAND = {
  slug: SITE_SLUG,
  name: SITE_NAME,
  shortName: SITE_SHORT_NAME,
  description: SITE_DESCRIPTION,
  tagline: SITE_TAGLINE,
  url: SITE_URL,
  contactEmail: CONTACT_EMAIL,
} as const;

export type Layout = "bottom-nav" | "sidebar" | "top-nav";

/**
 * "bottom-nav" = top bar + tab bar on phones (phone-first apps).
 * "sidebar" = left menu on wide screens (tools and dashboards).
 * "top-nav" = links in the top bar on wide screens, tab bar on phones (websites, content, shops).
 */
export const LAYOUT = "<APP_LAYOUT>" as "bottom-nav" | "sidebar" | "top-nav";

/** Set NEXT_PUBLIC_ENABLE_PWA=false to turn off the install banner and offline support. */
export const ENABLE_PWA = process.env.NEXT_PUBLIC_ENABLE_PWA !== "false";
/** Private app: hidden from search engines (see next.config.ts), empty sitemap. */
export const SITE_PRIVATE = process.env.NEXT_PUBLIC_SITE_PRIVATE === "true";
/** Off by default: Google sign-in needs a Google client created for this app first. */
export const GOOGLE_SIGNIN_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_SIGNIN_ENABLED === "true";

/**
 * How people sign up: "starter" (default, no email needed, the email is not proven to be theirs) or "verified"
 * (Supabase emails a confirmation link). Set NEXT_PUBLIC_SIGNUP_MODE=verified and redeploy once email sending works.
 */
export const SIGNUP_MODE: "starter" | "verified" = parseSignupMode(process.env.NEXT_PUBLIC_SIGNUP_MODE);
