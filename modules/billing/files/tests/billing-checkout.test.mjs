import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKING_STATUSES, hasLiveSubscription, checkoutIdempotencyKey, termsConsent, isMissingTermsUrlError,
  withinWithdrawalWindow, withdrawalRefundCents,
} from "../src/lib/billing/checkout-core.mjs";
import { assertCanCloseBilling } from "../src/lib/billing/account.mjs";

test("a second checkout is blocked while any subscription is active, trialing, past due, incomplete or unpaid", () => {
  for (const status of BLOCKING_STATUSES) assert.equal(hasLiveSubscription([{ status: "canceled" }, { status }]), true, status);
  assert.deepEqual(BLOCKING_STATUSES.sort(), ["active", "incomplete", "past_due", "trialing", "unpaid"]);
});

test("finished subscriptions and an empty list do not block a new purchase", () => {
  assert.equal(hasLiveSubscription([{ status: "canceled" }, { status: "incomplete_expired" }]), false);
  assert.equal(hasLiveSubscription([]), false);
  assert.equal(hasLiveSubscription(undefined), false);
});

test("the idempotency key repeats inside a 10-minute window and changes after it, per person and plan", () => {
  const t = Date.UTC(2026, 0, 1, 12, 0, 0);
  const key = checkoutIdempotencyKey("u1", "pro", t);
  assert.equal(checkoutIdempotencyKey("u1", "pro", t + 60_000), key);
  assert.notEqual(checkoutIdempotencyKey("u1", "pro", t + 11 * 60_000), key);
  assert.notEqual(checkoutIdempotencyKey("u2", "pro", t), key);
  assert.notEqual(checkoutIdempotencyKey("u1", "team", t), key);
});

test("checkout asks for the terms tick box with the 'start now' wording and a link to the terms", () => {
  const c = termsConsent("https://example.com/");
  assert.deepEqual(c.consent_collection, { terms_of_service: "required" });
  const message = c.custom_text.terms_of_service_acceptance.message;
  assert.match(message, /\[Terms\]\(https:\/\/example\.com\/terms\)/);
  assert.match(message, /ask for the service to start now/);
  assert.match(message, /withdraw within 14 days I pay for the days I used/);
  assert.ok(message.length < 1200, "Stripe allows 1200 characters");
});

test("a Stripe error about the missing terms address is recognised", () => {
  assert.equal(isMissingTermsUrlError(new Error("You cannot collect consent to your terms of service until a URL is set in your public business details at https://dashboard.stripe.com/settings/public")), true);
  assert.equal(isMissingTermsUrlError(new Error("No such price")), false);
  assert.equal(isMissingTermsUrlError(null), false);
});

test("the withdrawal window is 14 days from the start of the subscription", () => {
  const start = 1_800_000_000;
  assert.equal(withinWithdrawalWindow(start, (start + 13 * 86_400) * 1000), true);
  assert.equal(withinWithdrawalWindow(start, (start + 14 * 86_400 + 1) * 1000), false);
  assert.equal(withinWithdrawalWindow(undefined), false);
});

test("the refund is what was paid minus the share of the period used, never negative or above the price", () => {
  const start = 1_800_000_000;
  const end = start + 30 * 86_400;
  const at = (days) => (start + days * 86_400) * 1000;
  assert.equal(withdrawalRefundCents({ amountPaidCents: 900, periodStartSeconds: start, periodEndSeconds: end, now: at(0) }), 900);
  assert.equal(withdrawalRefundCents({ amountPaidCents: 900, periodStartSeconds: start, periodEndSeconds: end, now: at(3) }), 810);
  assert.equal(withdrawalRefundCents({ amountPaidCents: 900, periodStartSeconds: start, periodEndSeconds: end, now: at(40) }), 0);
  assert.equal(withdrawalRefundCents({ amountPaidCents: 0, periodStartSeconds: start, periodEndSeconds: end, now: at(1) }), 0);
  assert.equal(withdrawalRefundCents({ amountPaidCents: 900, periodStartSeconds: start, periodEndSeconds: start, now: at(1) }), 900);
});

test("a person with a Stripe customer is not deleted while payments are switched off", () => {
  assert.throws(() => assertCanCloseBilling({ customerId: "cus_1", enabled: false }), /could not be cancelled/);
  assert.doesNotThrow(() => assertCanCloseBilling({ customerId: "cus_1", enabled: true }));
  assert.doesNotThrow(() => assertCanCloseBilling({ customerId: null, enabled: false }), "someone who never paid can always be deleted");
});
