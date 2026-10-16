// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// Turns what Stripe answered into the plain-English results the admin Health page shows.
// Each function returns { status: "ok" | "warn" | "fail" | "skip", detail, fix? }. `fix` is only for warn and fail.
// No secret value is ever put in a detail.

import { paidPlans } from "./plans-core.mjs";
import { HANDLED_EVENT_TYPES } from "./webhook.mjs";

/** @typedef {{ status: "ok" | "warn" | "fail" | "skip", detail: string, fix?: string }} HealthResult */

const SETUP = "Run the Stripe setup in Shipyard.";

/**
 * @param {string | undefined} secretKey
 * @returns {HealthResult}
 */
export function keyModeResult(secretKey) {
  if (!secretKey) return { status: "skip", detail: "Payments are not set up yet." };
  if (/^(?:sk|rk)_test_/.test(secretKey)) {
    return {
      status: "warn",
      detail: "Payments are in test mode. Nobody is charged real money.",
      fix: "When you are ready to sell, follow Shipyard's go-live steps to switch to live payments.",
    };
  }
  if (/^(?:sk|rk)_live_/.test(secretKey)) return { status: "ok", detail: "Payments are live. Real money is taken." };
  return {
    status: "fail",
    detail: "The Stripe key does not look right.",
    fix: "It should start with sk_test_ or sk_live_. Check it in the app's settings on Vercel.",
  };
}

/**
 * @param {readonly any[]} plans
 * @param {Set<string> | string[]} activeLookupKeys lookup keys that have an active price in Stripe
 * @returns {HealthResult}
 */
export function pricesResult(plans, activeLookupKeys) {
  const have = new Set(activeLookupKeys);
  const missing = paidPlans(plans).filter((p) => !have.has(p.lookupKey));
  if (paidPlans(plans).length === 0) return { status: "skip", detail: "There is no paid plan in plans.ts." };
  if (missing.length === 0) return { status: "ok", detail: "Every paid plan has a price in Stripe." };
  return {
    status: "fail",
    detail: `Stripe has no active price for: ${missing.map((p) => p.name).join(", ")}.`,
    fix: `${SETUP} It makes Stripe match plans.ts.`,
  };
}

/**
 * @param {readonly { url?: string, status?: string, enabled_events?: string[] }[]} endpoints
 * @param {string} webhookUrl the address Stripe should call
 * @param {boolean} secretSet is STRIPE_WEBHOOK_SECRET set in the app
 * @returns {HealthResult}
 */
export function webhookResult(endpoints, webhookUrl, secretSet) {
  const mine = endpoints.find((e) => e.url === webhookUrl);
  if (!mine) {
    return { status: "fail", detail: `Stripe does not know this site's address (${webhookUrl}), so payments will not show up in the app.`, fix: SETUP };
  }
  if (mine.status !== "enabled") {
    return { status: "fail", detail: "Stripe's connection to this site is switched off.", fix: `Turn it on in the Stripe dashboard, or ${SETUP.toLowerCase()}` };
  }
  const listed = mine.enabled_events ?? [];
  const missing = listed.includes("*") ? [] : HANDLED_EVENT_TYPES.filter((t) => !listed.includes(t));
  if (missing.length > 0) return { status: "fail", detail: `Stripe does not send these updates: ${missing.join(", ")}.`, fix: SETUP };
  if (!secretSet) {
    return { status: "fail", detail: "The app has no webhook secret (STRIPE_WEBHOOK_SECRET), so it will refuse Stripe's messages.", fix: SETUP };
  }
  return { status: "ok", detail: "Stripe can tell this site about payments." };
}

/**
 * @param {readonly unknown[]} configurations active customer portal configurations
 * @returns {HealthResult}
 */
export function portalResult(configurations) {
  if (configurations.length > 0) return { status: "ok", detail: "Customers can manage their subscription: cancel, change card, see invoices." };
  return { status: "fail", detail: "Stripe has no customer portal set up, so the Manage billing button will fail.", fix: SETUP };
}

/**
 * Do the generated terms cover payments? Without the withdrawal section the terms were written before billing was added.
 * @param {readonly { id?: string }[]} termsSections the `terms` list from legal-content.ts
 * @returns {HealthResult}
 */
export function termsResult(termsSections) {
  if ((termsSections ?? []).some((s) => s?.id === "right-to-withdraw")) {
    return { status: "ok", detail: "The terms cover subscriptions and the 14-day right to withdraw." };
  }
  return {
    status: "warn",
    detail: "The terms and privacy policy were written before payments were added: they say nothing about subscriptions, refunds or Stripe.",
    fix: "Run legal-generate.mjs in Shipyard again.",
  };
}
