// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
//
// What happens when Stripe tells the app something (a payment, a cancellation). It knows nothing about Next.js or
// the database, so tests can run it with fakes. POST /api/billing/webhook hands it the raw request body, the
// Stripe-Signature header, a Stripe client and a store (store.ts).
//
//   1. The signature is checked first. A bad or missing one is a 400 and nothing else happens.
//   2. Events the app does not use are answered with 200 and ignored.
//   3. An event id seen before is a duplicate: 200, nothing done twice.
//   4. The event is processed, then its id is written down. If processing fails the answer is 500 and the id is not
//      written, so Stripe retries. Doing it twice is harmless: the subscription is stored as Stripe has it now.
//   5. Subscriptions that belong to another app on the same Stripe account are ignored.
//   6. An older event never overwrites newer data (compared by the event time Stripe stamps on it).
//
// Nothing here trusts data from the browser: the person is found from what the server put into the Checkout
// session (client_reference_id, metadata) or from the stored link between customer and person.

import { planByLookupKey, planById } from "./plans-core.mjs";

/** The events the app listens to. The Stripe setup script registers exactly these on the webhook endpoint. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ["active", "trialing", "past_due"];

const uuidOrNull = (v) => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);

/** Stripe fields are either an id string or the expanded object. */
function idOf(v) {
  if (typeof v === "string" && v) return v;
  if (v && typeof v === "object" && typeof v.id === "string") return v.id;
  return null;
}

const isoOrNull = (seconds) => (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);

/** Does this subscription belong to this app? (Another app may share the Stripe account.) */
export function isOurSubscription(sub, plans, appSlug) {
  const tag = sub?.metadata?.shipyard_app;
  if (tag) return tag === appSlug;
  return (sub?.items?.data ?? []).some((item) => planByLookupKey(plans, item?.price?.lookup_key) !== null);
}

/**
 * Which of our plans a subscription is on. The price on the subscription wins (it changes when someone switches
 * plan in the customer portal); the id we stamped at checkout is the fallback for a price whose key moved on.
 */
export function planIdOf(sub, plans) {
  for (const item of sub?.items?.data ?? []) {
    const plan = planByLookupKey(plans, item?.price?.lookup_key);
    if (plan) return plan.id;
  }
  const stamped = planById(plans, sub?.metadata?.plan_id);
  return stamped && stamped.priceCents > 0 ? stamped.id : null;
}

/** The values stored for a subscription. */
export function subscriptionRow(sub, { userId, planId, eventCreated, deleted = false }) {
  const items = sub.items?.data ?? [];
  // The paid-until time is on each item in current Stripe versions and on the subscription in older ones.
  const ends = items.map((i) => i?.current_period_end).filter((n) => typeof n === "number");
  const periodEnd = ends.length > 0 ? Math.max(...ends) : sub.current_period_end;
  const status = deleted ? "canceled" : String(sub.status ?? "");
  return {
    userId,
    customerId: idOf(sub.customer),
    subscriptionId: sub.id,
    planId,
    status: /^[a-z_]{1,40}$/.test(status) ? status : "unknown",
    currentPeriodEnd: isoOrNull(periodEnd),
    // The portal's "cancel at the end of the period" sets cancel_at_period_end, or cancel_at in newer setups.
    cancelAtPeriodEnd: status !== "canceled" && (sub.cancel_at_period_end === true || typeof sub.cancel_at === "number"),
    eventAt: isoOrNull(eventCreated) ?? new Date().toISOString(),
  };
}

/** The subscription an invoice is for (current Stripe versions: parent.subscription_details; older: subscription). */
export function invoiceSubscriptionId(invoice) {
  return idOf(invoice?.parent?.subscription_details?.subscription) ?? idOf(invoice?.subscription);
}

/**
 * True when stored data is newer than this event, or when an old, finished subscription would wipe out a newer one.
 * @param {{ stripe_subscription_id?: string | null, status?: string | null, updated_from_event_at?: string | null } | null} current
 */
export function isStale(current, row) {
  if (!current) return false;
  const storedAt = current.updated_from_event_at ? Date.parse(current.updated_from_event_at) : NaN;
  const sameSubscription = !current.stripe_subscription_id || current.stripe_subscription_id === row.subscriptionId;
  if (sameSubscription) return Number.isFinite(storedAt) && Date.parse(row.eventAt) < storedAt;
  // A different subscription is stored. Only let this one replace it when it is live, or when the stored one is not.
  const storedLive = LIVE.includes(current.status ?? "");
  return storedLive && !LIVE.includes(row.status);
}

async function currentSubscription(stripe, id, fallback) {
  try {
    return await stripe.subscriptions.retrieve(id);
  } catch (err) {
    if (fallback && err && typeof err === "object" && err.code === "resource_missing") return fallback;
    throw err;
  }
}

async function resolveUser(ctx, sub, hint) {
  const direct = hint ?? uuidOrNull(sub.metadata?.user_id);
  if (direct) return direct;
  const customerId = idOf(sub.customer);
  return customerId ? ctx.store.userIdForCustomer(customerId) : null;
}

async function storeSubscription(ctx, sub, event, { hint = null, deleted = false } = {}) {
  if (!isOurSubscription(sub, ctx.plans, ctx.appSlug)) return "not_ours";
  const userId = await resolveUser(ctx, sub, hint);
  if (!userId) return "no_user";
  const planId = planIdOf(sub, ctx.plans);
  if (!planId) return "unknown_plan";
  const row = subscriptionRow(sub, { userId, planId, eventCreated: event.created, deleted });
  if (isStale(await ctx.store.getSubscription(userId), row)) return "stale";
  const outcome = await ctx.store.upsertSubscription(row);
  if (outcome === "ok" && row.customerId) await ctx.store.linkCustomer(userId, row.customerId);
  return outcome;
}

async function processEvent(ctx, event) {
  const object = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed": {
      if (object.mode !== "subscription") return "ignored";
      const subId = idOf(object.subscription);
      if (!subId) return "ignored";
      const hint = uuidOrNull(object.client_reference_id) ?? uuidOrNull(object.metadata?.user_id);
      const customerId = idOf(object.customer);
      const sub = await currentSubscription(ctx.stripe, subId, null);
      // Link the customer to the person even when the subscription turns out to be stale.
      if (hint && customerId && isOurSubscription(sub, ctx.plans, ctx.appSlug)) await ctx.store.linkCustomer(hint, customerId);
      return storeSubscription(ctx, sub, event, { hint });
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      if (!isOurSubscription(object, ctx.plans, ctx.appSlug)) return "not_ours";
      // Stripe does not deliver events in order and event times have a one-second resolution, so use the
      // subscription as it is now rather than the copy inside the event.
      const sub = await currentSubscription(ctx.stripe, object.id, object);
      return storeSubscription(ctx, sub, event);
    }
    case "customer.subscription.deleted":
      // Final: the copy inside the event is the last word.
      return storeSubscription(ctx, object, event, { deleted: true });
    case "invoice.paid":
    case "invoice.payment_failed": {
      const subId = invoiceSubscriptionId(object);
      if (!subId) return "ignored";
      const sub = await currentSubscription(ctx.stripe, subId, null);
      return storeSubscription(ctx, sub, event);
    }
    default:
      return "ignored";
  }
}

/**
 * @param {{
 *   rawBody: string,
 *   signature: string | null,
 *   secret: string | undefined,
 *   stripe: { webhooks: { constructEvent(payload: string, header: string, secret: string): any }, subscriptions: { retrieve(id: string): Promise<any> } },
 *   store: {
 *     isHandled(id: string): Promise<boolean>,
 *     markHandled(id: string, type: string): Promise<void>,
 *     userIdForCustomer(customerId: string): Promise<string | null>,
 *     getSubscription(userId: string): Promise<any>,
 *     upsertSubscription(row: any): Promise<string>,
 *     linkCustomer(userId: string, customerId: string): Promise<void>,
 *   },
 *   plans: readonly any[],
 *   appSlug: string,
 *   log?: (message: string) => void,
 * }} input
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function handleStripeWebhook(input) {
  const log = input.log ?? ((m) => console.error(m));
  if (!input.secret) return { status: 503, body: { error: "Payments are not set up." } };
  if (!input.signature) return { status: 400, body: { error: "Missing signature." } };

  let event;
  try {
    event = input.stripe.webhooks.constructEvent(input.rawBody, input.signature, input.secret);
  } catch {
    return { status: 400, body: { error: "Bad signature." } };
  }

  if (!HANDLED_EVENT_TYPES.includes(event.type)) return { status: 200, body: { received: true, ignored: true } };

  const ctx = { stripe: input.stripe, store: input.store, plans: input.plans, appSlug: input.appSlug };
  let outcome;
  try {
    if (await input.store.isHandled(event.id)) return { status: 200, body: { received: true, duplicate: true } };
    outcome = await processEvent(ctx, event);
  } catch (err) {
    // Only the kind of error is logged: never emails, names or keys.
    const tag = err && typeof err === "object" && "type" in err ? String(err.type) : err instanceof Error ? err.name : "unknown";
    log(`[billing] ${event.type} ${event.id} failed: ${tag}`);
    return { status: 500, body: { error: "Could not process the event." } };
  }
  if (outcome !== "ok" && outcome !== "ignored") log(`[billing] ${event.type} ${event.id}: ${outcome}`);
  try {
    await input.store.markHandled(event.id, event.type);
  } catch {
    // Already processed. A retry would only do the same work again.
    log(`[billing] could not write down event ${event.id}`);
  }
  return { status: 200, body: { received: true, outcome } };
}
