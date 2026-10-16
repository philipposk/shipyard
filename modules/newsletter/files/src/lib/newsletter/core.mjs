// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// The rules of the email list: who may be emailed, how unsubscribe links are made and checked, what a message may
// contain. Server code only (it uses node:crypto). The page that previews an email uses email-render.mjs instead.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const SUBJECT_MAX = 200;
export const BODY_MAX = 50000;
export const SOURCES = ["signup", "settings"];

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PURPOSE = "shipyard-newsletter-unsubscribe";

/** @param {unknown} value */
export function isValidEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value);
}

// ---------------------------------------------------------------------------------------------
// Unsubscribe tokens
//
// A token is a keyed fingerprint of the subscriber's id: nobody can make one without the secret, and it needs no
// storage to send. The database keeps only the SHA-256 of it, so a leaked copy of the table lets nobody unsubscribe
// anyone. The secret is NEWSLETTER_SECRET (made when the module is added). Keep it: links already sent stop
// working if it changes.

/**
 * The secret used to make tokens: NEWSLETTER_SECRET (at least 16 characters), or null if it is missing.
 * @param {Record<string, string | undefined>} env
 * @returns {{ secret: string } | null}
 */
export function tokenSecret(env) {
  const secret = env.NEWSLETTER_SECRET;
  return secret && secret.length >= 16 ? { secret } : null;
}

/** @param {string} secret @param {string} subscriberId */
export function unsubscribeTokenFor(secret, subscriberId) {
  return createHmac("sha256", secret).update(`${PURPOSE}:${subscriberId}`).digest("base64url");
}

/** What the database stores. @param {string} token */
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** @param {unknown} token */
export const looksLikeToken = (token) => typeof token === "string" && TOKEN_RE.test(token);

/** Does this token belong to this subscriber? (constant-time) */
export function tokenMatches(secret, subscriberId, token) {
  if (!looksLikeToken(token)) return false;
  const expected = Buffer.from(unsubscribeTokenFor(secret, subscriberId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const trimSlash = (url) => String(url).replace(/\/+$/, "");

/** The address in the footer of every email: a page with one button. */
export const unsubscribePageUrl = (siteUrl, token) => `${trimSlash(siteUrl)}/unsubscribe${token ? `?token=${encodeURIComponent(token)}` : ""}`;

/** The address mail programs call by themselves for "unsubscribe" buttons (RFC 8058). */
export const unsubscribeApiUrl = (siteUrl, token) => `${trimSlash(siteUrl)}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;

/** Headers that give Gmail, Apple Mail and others their own unsubscribe button. @param {string} apiUrl */
export function listUnsubscribeHeaders(apiUrl) {
  return { "List-Unsubscribe": `<${apiUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

// ---------------------------------------------------------------------------------------------
// Who may be emailed

/**
 * Is this person's email address proven to be theirs? Only then may their "yes" count.
 * In the starter sign-up mode anyone can make an account with any address (nothing is emailed), so a tick proves
 * nothing: someone could sign up as a stranger's address and tick the box. In verified mode the person had to open a
 * link sent to that address. A Google account also proves it.
 * @param {{ signupMode?: string, identities?: readonly { provider?: string }[] | null }} input
 */
export function emailIsProven({ signupMode, identities }) {
  if (signupMode === "verified") return true;
  return (identities ?? []).some((i) => i?.provider === "google");
}

/**
 * Consent given before this moment does not count. launch-email sets NEWSLETTER_CONSENT_NOT_BEFORE when it switches
 * sign-ups to verified, so ticks collected while addresses were not proven are ignored until the person ticks again.
 * @param {Record<string, string | undefined>} env
 * @returns {number | null} a time in milliseconds
 */
export function consentNotBefore(env) {
  const t = Date.parse(env.NEWSLETTER_CONSENT_NOT_BEFORE ?? "");
  return Number.isFinite(t) ? t : null;
}

/**
 * A row may be emailed only if the person said yes (status subscribed with a consent time) and the address is valid.
 * @param {any} row @param {number | null} [notBefore] consent given earlier than this (ms) does not count
 */
export function isConsented(row, notBefore = null) {
  if (!row || row.status !== "subscribed" || !isValidEmail(row.email)) return false;
  const at = Date.parse(row.consent_at ?? "");
  return Number.isFinite(at) && (notBefore === null || at >= notBefore);
}

/**
 * The rows to send to: consented only, one per address.
 * @param {readonly any[] | undefined} rows @param {number | null} [notBefore] consent given earlier than this (ms) does not count
 */
export function consentedRecipients(rows, notBefore = null) {
  const seen = new Set();
  const out = [];
  for (const row of rows ?? []) {
    if (!isConsented(row, notBefore)) continue;
    const key = row.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What an author may send

/**
 * @param {{ subject?: unknown, bodyMd?: unknown }} input
 * @returns {{ ok: true, subject: string, bodyMd: string } | { ok: false, error: string }}
 */
export function checkCompose({ subject, bodyMd }) {
  const cleanSubject = String(subject ?? "").replace(/\s+/g, " ").trim();
  const body = String(bodyMd ?? "");
  if (!cleanSubject || cleanSubject.length > SUBJECT_MAX) return { ok: false, error: `The subject must be 1 to ${SUBJECT_MAX} characters.` };
  if (!body.trim()) return { ok: false, error: "Write the message first." };
  if (body.length > BODY_MAX) return { ok: false, error: `The message is too long (up to ${BODY_MAX} characters).` };
  return { ok: true, subject: cleanSubject, bodyMd: body };
}

/** @param {unknown} value */
export const parseSource = (value) => (SOURCES.includes(String(value)) ? String(value) : "settings");

// ---------------------------------------------------------------------------------------------
// Health page results

/** @typedef {{ status: "ok" | "warn" | "fail" | "skip", detail: string, fix?: string }} HealthResult */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {HealthResult}
 */
export function sendingResult(env) {
  if (!env.RESEND_API_KEY) return { status: "skip", detail: "Email sending is not set up, so newsletters can not be sent yet." };
  if (!env.RESEND_FROM) {
    return {
      status: "warn",
      detail: "No sender address is set (RESEND_FROM), so you can send yourself a test but not the whole list.",
      fix: "Verify your domain with the email setup in Shipyard.",
    };
  }
  return { status: "ok", detail: "Newsletters can be sent." };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {HealthResult}
 */
export function secretResult(env) {
  if (!tokenSecret(env)) {
    return {
      status: "fail",
      detail: "Unsubscribe links have no secret to be made with, so updates can not be sent.",
      fix: "Add NEWSLETTER_SECRET to the app's settings: run provision-vercel.mjs again, or add it by hand in Vercel.",
    };
  }
  return { status: "ok", detail: "Unsubscribe links are set up." };
}
