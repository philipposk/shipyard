// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// The rules around buying a plan and withdrawing from it (the EU 14-day right), with no Stripe or database calls.

/** Subscription states that mean "this person already has, or is about to have, a paid plan". */
export const BLOCKING_STATUSES = ["active", "trialing", "past_due", "incomplete", "unpaid"];

/**
 * True if any of the customer's Stripe subscriptions still counts. Looking at Stripe itself (not the app's own copy,
 * which only updates when Stripe's message arrives) stops a double click, or a second tab, from charging someone twice.
 * @param {readonly { status?: string }[]} subscriptions
 */
export function hasLiveSubscription(subscriptions) {
  return (subscriptions ?? []).some((s) => BLOCKING_STATUSES.includes(String(s?.status)));
}

/**
 * A key that is the same for the same person and plan within one 10-minute window, so Stripe returns the same
 * checkout instead of making a second one if the request is sent twice.
 */
export function checkoutIdempotencyKey(userId, planId, now = Date.now()) {
  return `checkout-${userId}-${planId}-${Math.floor(now / 600_000)}`;
}

/**
 * The tick box above Stripe's pay button. In the EU the seller may keep the part of the price for days already used
 * after a withdrawal only if the buyer clearly asked for the service to start at once and was told so before paying
 * (Consumer Rights Directive, Articles 7(3) and 14(3)). Stripe shows this text and records the tick with the payment.
 * Stripe needs the terms address saved once in the Stripe dashboard (Settings > Business > Public details).
 */
export function termsConsent(siteUrl) {
  const terms = `${String(siteUrl).replace(/\/+$/, "")}/terms`;
  return {
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I agree to the [Terms](${terms}) and I ask for the service to start now. If I withdraw within 14 days I pay for the days I used.`,
      },
    },
  };
}

/** True if Stripe refused the checkout because no terms address is saved in the dashboard. */
export function isMissingTermsUrlError(error) {
  const text = String(error?.message ?? "");
  return /terms of service/i.test(text) && /url|public/i.test(text);
}

export const WITHDRAWAL_DAYS = 14;

/**
 * Is the person still inside the 14-day withdrawal window? It starts when the subscription starts.
 * @param {number | undefined} startedAtSeconds Stripe's start_date (seconds)
 */
export function withinWithdrawalWindow(startedAtSeconds, now = Date.now()) {
  if (!Number.isFinite(startedAtSeconds)) return false;
  return now < (startedAtSeconds + WITHDRAWAL_DAYS * 86_400) * 1000;
}

/**
 * What to give back after a withdrawal: the amount paid minus the share of the period already used.
 * Rounded in the buyer's favour (the used share is rounded down). Never negative, never more than was paid.
 */
export function withdrawalRefundCents({ amountPaidCents, periodStartSeconds, periodEndSeconds, now = Date.now() }) {
  if (!Number.isFinite(amountPaidCents) || amountPaidCents <= 0) return 0;
  const span = periodEndSeconds - periodStartSeconds;
  if (!Number.isFinite(span) || span <= 0) return amountPaidCents;
  const usedFraction = Math.min(1, Math.max(0, (now / 1000 - periodStartSeconds) / span));
  return Math.min(amountPaidCents, Math.max(0, amountPaidCents - Math.floor(amountPaidCents * usedFraction)));
}
