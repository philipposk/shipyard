import { test } from "node:test";
import assert from "node:assert/strict";
import { handleStripeWebhook, HANDLED_EVENT_TYPES, isOurSubscription, planIdOf, subscriptionRow, isStale, invoiceSubscriptionId } from "../src/lib/billing/webhook.mjs";

const SLUG = "shop";
const PLANS = [
  { id: "free", name: "Free", priceCents: 0, currency: "EUR", interval: "month", features: [] },
  { id: "pro", name: "Pro", priceCents: 900, currency: "EUR", interval: "month", lookupKey: "shop_pro_monthly", features: [] },
  { id: "team", name: "Team", priceCents: 2900, currency: "EUR", interval: "month", lookupKey: "shop_team_monthly", features: [] },
];
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const SECRET = "whsec_test";

const sub = (over = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  metadata: { user_id: USER, plan_id: "pro", shipyard_app: SLUG },
  cancel_at_period_end: false,
  items: { data: [{ current_period_end: 1800000000, price: { id: "price_pro", lookup_key: "shop_pro_monthly" } }] },
  ...over,
});

const event = (type, object, over = {}) => ({ id: `evt_${Math.random().toString(36).slice(2)}`, type, created: 1700000000, data: { object }, ...over });

/** A fake Stripe: constructEvent returns the event whose raw body it is given, unless the signature is "bad". */
function fakeStripe({ subs = {}, failRetrieve = null } = {}) {
  const retrieved = [];
  return {
    retrieved,
    webhooks: {
      constructEvent(payload, header, secret) {
        if (header === "bad" || secret !== SECRET) throw new Error("No signatures found matching the expected signature");
        return JSON.parse(payload);
      },
    },
    subscriptions: {
      async retrieve(id) {
        retrieved.push(id);
        if (failRetrieve) throw failRetrieve;
        if (!subs[id]) throw Object.assign(new Error("No such subscription"), { code: "resource_missing", type: "StripeInvalidRequestError" });
        return subs[id];
      },
    },
  };
}

/** A fake store with the same rules as the real one (store.ts): a newer stored time wins. */
function fakeStore({ customers = {}, failMark = false, failUpsert = false } = {}) {
  const state = { events: new Map(), subs: new Map(), customers: new Map(Object.entries(customers)), upserts: 0 };
  return {
    state,
    async isHandled(id) {
      return state.events.has(id);
    },
    async markHandled(id, type) {
      if (failMark) throw new Error("db down");
      state.events.set(id, type);
    },
    async userIdForCustomer(customerId) {
      return state.customers.get(customerId) ?? null;
    },
    async getSubscription(userId) {
      const row = state.subs.get(userId);
      return row ? { stripe_subscription_id: row.subscriptionId, status: row.status, updated_from_event_at: row.eventAt } : null;
    },
    async upsertSubscription(row) {
      if (failUpsert) throw new Error("db down");
      if (row.userId === "00000000-0000-4000-8000-000000000000") return "no_user";
      const old = state.subs.get(row.userId);
      if (old && Date.parse(old.eventAt) > Date.parse(row.eventAt)) return "stale";
      state.upserts += 1;
      state.subs.set(row.userId, row);
      return "ok";
    },
    async linkCustomer(userId, customerId) {
      if (!state.customers.has(customerId)) state.customers.set(customerId, userId);
    },
  };
}

async function send(ev, { stripe = fakeStripe(), store = fakeStore(), signature = "good", secret = SECRET, logs = [] } = {}) {
  const result = await handleStripeWebhook({
    rawBody: JSON.stringify(ev), signature, secret, stripe, store, plans: PLANS, appSlug: SLUG, log: (m) => logs.push(m),
  });
  return { result, stripe, store, logs };
}

test("a bad signature is a 400 and nothing is stored", async () => {
  const store = fakeStore();
  const { result } = await send(event("customer.subscription.updated", sub()), { store, signature: "bad" });
  assert.equal(result.status, 400);
  assert.equal(store.state.subs.size, 0);
  assert.equal(store.state.events.size, 0);
});

test("a missing signature is a 400, a missing secret a 503", async () => {
  const ev = event("customer.subscription.updated", sub());
  assert.equal((await send(ev, { signature: null })).result.status, 400);
  assert.equal((await send(ev, { secret: null })).result.status, 503);
  assert.equal((await send(ev, { secret: "" })).result.status, 503);
});

test("events the app does not use are answered 200 and ignored", async () => {
  for (const type of ["customer.created", "charge.succeeded", "payment_intent.created", "invoice.created"]) {
    const store = fakeStore();
    const { result } = await send(event(type, { id: "x" }), { store });
    assert.equal(result.status, 200, type);
    assert.equal(result.body.ignored, true);
    assert.equal(store.state.events.size, 0);
  }
});

test("the handled event list is exactly what the module promises", () => {
  assert.deepEqual([...HANDLED_EVENT_TYPES].sort(), [
    "checkout.session.completed", "customer.subscription.created", "customer.subscription.deleted",
    "customer.subscription.updated", "invoice.paid", "invoice.payment_failed",
  ]);
});

test("customer.subscription.created stores the plan and links the customer", async () => {
  const stripe = fakeStripe({ subs: { sub_1: sub() } });
  const { result, store } = await send(event("customer.subscription.created", sub()), { stripe });
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "ok");
  const row = store.state.subs.get(USER);
  assert.equal(row.planId, "pro");
  assert.equal(row.status, "active");
  assert.equal(row.currentPeriodEnd, new Date(1800000000 * 1000).toISOString());
  assert.equal(row.cancelAtPeriodEnd, false);
  assert.equal(store.state.customers.get("cus_1"), USER);
});

test("a repeated event id is a duplicate: answered 200, not processed twice", async () => {
  const stripe = fakeStripe({ subs: { sub_1: sub() } });
  const store = fakeStore();
  const ev = event("customer.subscription.updated", sub());
  const first = await send(ev, { stripe, store });
  assert.equal(first.result.body.outcome, "ok");
  const upserts = store.state.upserts;
  const again = await send(ev, { stripe, store });
  assert.equal(again.result.status, 200);
  assert.equal(again.result.body.duplicate, true);
  assert.equal(store.state.upserts, upserts);
});

test("an older event never overwrites newer data (out of order)", async () => {
  const newer = sub({ status: "active" });
  const stripe = fakeStripe({ subs: { sub_1: newer } });
  const store = fakeStore();
  assert.equal((await send(event("customer.subscription.updated", newer, { created: 1700000500 }), { stripe, store })).result.body.outcome, "ok");
  const older = await send(event("customer.subscription.updated", sub({ status: "incomplete" }), { created: 1700000100 }), { stripe, store });
  assert.equal(older.result.status, 200);
  assert.equal(older.result.body.outcome, "stale");
  assert.equal(store.state.subs.get(USER).status, "active");
});

test("an old cancelled subscription does not wipe out a newer live one", async () => {
  const live = sub({ id: "sub_2", status: "active" });
  const store = fakeStore();
  await send(event("customer.subscription.created", live, { created: 1700001000 }), { stripe: fakeStripe({ subs: { sub_2: live } }), store });
  const oldDeleted = sub({ id: "sub_1", status: "canceled" });
  const { result } = await send(event("customer.subscription.deleted", oldDeleted, { created: 1700002000 }), { store });
  assert.equal(result.body.outcome, "stale");
  assert.equal(store.state.subs.get(USER).subscriptionId, "sub_2");
  assert.equal(store.state.subs.get(USER).status, "active");
});

test("customer.subscription.deleted stores a cancelled subscription from the event itself", async () => {
  const store = fakeStore();
  const stripe = fakeStripe(); // retrieve would fail: the event is final and must not need it
  const { result } = await send(event("customer.subscription.deleted", sub({ status: "canceled" })), { stripe, store });
  assert.equal(result.body.outcome, "ok");
  assert.equal(store.state.subs.get(USER).status, "canceled");
  assert.equal(store.state.subs.get(USER).cancelAtPeriodEnd, false);
  assert.deepEqual(stripe.retrieved, []);
});

test("updated events use the subscription as Stripe has it now, not the copy inside the event", async () => {
  const stripe = fakeStripe({ subs: { sub_1: sub({ status: "active" }) } });
  const { store } = await send(event("customer.subscription.updated", sub({ status: "incomplete" })), { stripe });
  assert.equal(store.state.subs.get(USER).status, "active");
  assert.deepEqual(stripe.retrieved, ["sub_1"]);
});

test("checkout.session.completed links the customer and stores the subscription", async () => {
  const session = { id: "cs_1", mode: "subscription", subscription: "sub_1", customer: "cus_9", client_reference_id: USER, metadata: { user_id: USER } };
  const stripe = fakeStripe({ subs: { sub_1: sub({ customer: "cus_9", metadata: { shipyard_app: SLUG, plan_id: "pro" } }) } });
  const { result, store } = await send(event("checkout.session.completed", session), { stripe });
  assert.equal(result.body.outcome, "ok");
  assert.equal(store.state.customers.get("cus_9"), USER);
  assert.equal(store.state.subs.get(USER).planId, "pro");
});

test("checkout.session.completed ignores payments that are not subscriptions", async () => {
  const { result, store } = await send(event("checkout.session.completed", { id: "cs_2", mode: "payment", customer: "cus_9", client_reference_id: USER }));
  assert.equal(result.body.outcome, "ignored");
  assert.equal(store.state.subs.size, 0);
});

test("checkout.session.completed trusts only a valid user id in client_reference_id", async () => {
  const session = { id: "cs_3", mode: "subscription", subscription: "sub_1", customer: "cus_9", client_reference_id: "not-a-uuid" };
  const stripe = fakeStripe({ subs: { sub_1: sub({ customer: "cus_9", metadata: { shipyard_app: SLUG, plan_id: "pro" } }) } });
  const { result, store } = await send(event("checkout.session.completed", session), { stripe });
  assert.equal(result.body.outcome, "no_user");
  assert.equal(store.state.subs.size, 0);
});

test("invoice.paid and invoice.payment_failed refresh the subscription (new and old invoice shapes)", async () => {
  const stripe = fakeStripe({ subs: { sub_1: sub({ status: "past_due" }) } });
  const newShape = { id: "in_1", parent: { subscription_details: { subscription: "sub_1" } } };
  const oldShape = { id: "in_2", subscription: "sub_1" };
  assert.equal(invoiceSubscriptionId(newShape), "sub_1");
  assert.equal(invoiceSubscriptionId(oldShape), "sub_1");
  assert.equal(invoiceSubscriptionId({ id: "in_3" }), null);
  for (const [type, invoice] of [["invoice.payment_failed", newShape], ["invoice.paid", oldShape]]) {
    const { result, store } = await send(event(type, invoice), { stripe });
    assert.equal(result.body.outcome, "ok", type);
    assert.equal(store.state.subs.get(USER).status, "past_due");
  }
  const none = await send(event("invoice.paid", { id: "in_4" }), { stripe });
  assert.equal(none.result.body.outcome, "ignored");
});

test("subscriptions of another app on the same Stripe account are ignored", async () => {
  const foreign = sub({ metadata: { user_id: OTHER_USER, shipyard_app: "someone-elses-app" }, items: { data: [{ price: { lookup_key: "other_pro_monthly" } }] } });
  const store = fakeStore();
  const { result } = await send(event("customer.subscription.updated", foreign), { store });
  assert.equal(result.body.outcome, "not_ours");
  assert.equal(store.state.subs.size, 0);
  // Even a subscription with our lookup key is refused when it is stamped for another app.
  const tagged = sub({ metadata: { user_id: USER, shipyard_app: "other" } });
  assert.equal(isOurSubscription(tagged, PLANS, SLUG), false);
});

test("a subscription without our stamp is ours only when its price is one of our plans", () => {
  assert.equal(isOurSubscription(sub({ metadata: {} }), PLANS, SLUG), true);
  assert.equal(isOurSubscription(sub({ metadata: {}, items: { data: [{ price: { lookup_key: "x" } }] } }), PLANS, SLUG), false);
  assert.equal(isOurSubscription({ items: { data: [] } }, PLANS, SLUG), false);
});

test("the person is found from the stored customer link when the subscription carries no user id", async () => {
  const bare = sub({ metadata: { shipyard_app: SLUG, plan_id: "pro" } });
  const stripe = fakeStripe({ subs: { sub_1: bare } });
  const store = fakeStore({ customers: { cus_1: USER } });
  const { result } = await send(event("customer.subscription.updated", bare), { stripe, store });
  assert.equal(result.body.outcome, "ok");
  assert.ok(store.state.subs.has(USER));
});

test("no way to find the person: nothing stored, event acknowledged (not retried forever)", async () => {
  const bare = sub({ metadata: { shipyard_app: SLUG, plan_id: "pro" } });
  const stripe = fakeStripe({ subs: { sub_1: bare } });
  const { result, store, logs } = await send(event("customer.subscription.updated", bare), { stripe });
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "no_user");
  assert.equal(store.state.subs.size, 0);
  assert.match(logs.join("\n"), /no_user/);
});

test("an account that does not exist here is acknowledged, not retried", async () => {
  const ghost = sub({ metadata: { user_id: "00000000-0000-4000-8000-000000000000", shipyard_app: SLUG, plan_id: "pro" } });
  const { result } = await send(event("customer.subscription.deleted", ghost));
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "no_user");
});

test("a price we do not know gives no access: unknown_plan, logged", async () => {
  const odd = sub({ metadata: { user_id: USER, shipyard_app: SLUG }, items: { data: [{ price: { lookup_key: "mystery" } }] } });
  const { result, store } = await send(event("customer.subscription.deleted", odd));
  assert.equal(result.body.outcome, "unknown_plan");
  assert.equal(store.state.subs.size, 0);
});

test("switching plan in the portal follows the price; the stamped plan is the fallback", () => {
  const switched = sub({ metadata: { plan_id: "pro", shipyard_app: SLUG }, items: { data: [{ price: { lookup_key: "shop_team_monthly" } }] } });
  assert.equal(planIdOf(switched, PLANS), "team");
  const oldPrice = sub({ items: { data: [{ price: { lookup_key: null } }] } });
  assert.equal(planIdOf(oldPrice, PLANS), "pro");
  assert.equal(planIdOf(sub({ metadata: { plan_id: "free" }, items: { data: [] } }), PLANS), null);
});

test("subscriptionRow reads the period end from items or from the old subscription field, and the cancel flags", () => {
  const base = { userId: USER, planId: "pro", eventCreated: 1700000000 };
  assert.equal(subscriptionRow(sub(), base).currentPeriodEnd, new Date(1800000000 * 1000).toISOString());
  const legacy = sub({ items: { data: [{ price: {} }] }, current_period_end: 1790000000 });
  assert.equal(subscriptionRow(legacy, base).currentPeriodEnd, new Date(1790000000 * 1000).toISOString());
  assert.equal(subscriptionRow(sub({ cancel_at_period_end: true }), base).cancelAtPeriodEnd, true);
  assert.equal(subscriptionRow(sub({ cancel_at: 1800000000 }), base).cancelAtPeriodEnd, true);
  assert.equal(subscriptionRow(sub({ cancel_at_period_end: true, status: "canceled" }), base).cancelAtPeriodEnd, false);
  assert.equal(subscriptionRow(sub(), { ...base, deleted: true }).status, "canceled");
  assert.equal(subscriptionRow(sub({ status: "Weird Status!" }), base).status, "unknown");
  assert.equal(subscriptionRow(sub({ customer: { id: "cus_x" } }), base).customerId, "cus_x");
});

test("isStale", () => {
  const row = { subscriptionId: "sub_1", status: "active", eventAt: "2027-01-02T00:00:00.000Z" };
  assert.equal(isStale(null, row), false);
  assert.equal(isStale({ stripe_subscription_id: "sub_1", status: "active", updated_from_event_at: "2027-01-03T00:00:00.000Z" }, row), true);
  assert.equal(isStale({ stripe_subscription_id: "sub_1", status: "active", updated_from_event_at: "2027-01-02T00:00:00.000Z" }, row), false);
  assert.equal(isStale({ stripe_subscription_id: "sub_1", status: "active", updated_from_event_at: null }, row), false);
  assert.equal(isStale({ stripe_subscription_id: "sub_0", status: "active", updated_from_event_at: "2020-01-01T00:00:00Z" }, { ...row, status: "canceled" }), true);
  assert.equal(isStale({ stripe_subscription_id: "sub_0", status: "canceled", updated_from_event_at: "2020-01-01T00:00:00Z" }, { ...row, status: "canceled" }), false);
  assert.equal(isStale({ stripe_subscription_id: "sub_0", status: "active", updated_from_event_at: "2020-01-01T00:00:00Z" }, row), false);
});

test("a failure while processing is a 500 and the event is not written down, so Stripe retries", async () => {
  const stripe = fakeStripe({ subs: { sub_1: sub() } });
  const store = fakeStore({ failUpsert: true });
  const { result, logs } = await send(event("customer.subscription.updated", sub()), { stripe, store });
  assert.equal(result.status, 500);
  assert.equal(store.state.events.size, 0);
  assert.match(logs.join("\n"), /failed/);
});

test("a Stripe error while retrieving is a 500 (retry), but a missing subscription falls back to the event", async () => {
  const boom = Object.assign(new Error("rate limit"), { type: "StripeRateLimitError" });
  const failing = await send(event("customer.subscription.updated", sub()), { stripe: fakeStripe({ failRetrieve: boom }) });
  assert.equal(failing.result.status, 500);
  assert.match(failing.logs.join("\n"), /StripeRateLimitError/);
  const missing = await send(event("customer.subscription.updated", sub()), { stripe: fakeStripe({ subs: {} }) });
  assert.equal(missing.result.status, 200);
  assert.equal(missing.result.body.outcome, "ok");
});

test("failing to write the event id down still answers 200 (the work is done)", async () => {
  const stripe = fakeStripe({ subs: { sub_1: sub() } });
  const store = fakeStore({ failMark: true });
  const { result, logs } = await send(event("customer.subscription.updated", sub()), { stripe, store });
  assert.equal(result.status, 200);
  assert.match(logs.join("\n"), /could not write down/);
});

test("logs never contain emails, ids of people or keys", async () => {
  const fakeKey = ["sk", "test", "abcdefghijklmnop"].join("_"); // put together here so the key-leak scan has nothing to find
  const stripe = fakeStripe({ failRetrieve: Object.assign(new Error(`failed for ${USER} sam@example.com ${fakeKey}`), { type: "StripeAPIError" }) });
  const { logs } = await send(event("customer.subscription.updated", sub()), { stripe });
  const all = logs.join("\n");
  assert.doesNotMatch(all, /sam@example\.com|sk_test_|11111111/);
});
