import { parseSignupMode } from "@/lib/auth/signup-mode.mjs";

/** Central app identity. Shipyard fills the placeholders once when it creates the app; change values here later. */
export const SITE_SLUG = "<APP_SLUG>";
export const SITE_NAME = "<APP_NAME>";
export const SITE_SHORT_NAME = "<APP_SHORT_NAME>";
export const SITE_DESCRIPTION = "<APP_DESCRIPTION>";
export const SITE_TAGLINE = "<APP_TAGLINE>";
/** Public address of the app. Falls back to localhost while you build. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");

/** Use BRAND everywhere the app name, slogan or address appears. Never type them into a component. */
export const BRAND = {
  slug: SITE_SLUG,
  name: SITE_NAME,
  shortName: SITE_SHORT_NAME,
  description: SITE_DESCRIPTION,
  tagline: SITE_TAGLINE,
  url: SITE_URL,
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
/** Where people write to the person who runs the app. Shown on the legal pages. Public on purpose. */
export const CONTACT_EMAIL = (process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "").trim();
