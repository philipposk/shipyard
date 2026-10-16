// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// The checks and helpers behind src/lib/billing/plans.ts. The plans themselves live in plans.ts.

/**
 * @typedef {{ amount: number, unit: string }} FreeQuota
 * @typedef {{
 *   id: string,
 *   name: string,
 *   priceCents: number,
 *   currency: string,
 *   interval: "month" | "year",
 *   lookupKey?: string,
 *   features: string[],
 *   freeQuota?: FreeQuota,
 * }} Plan
 */

const ID_RE = /^[a-z][a-z0-9_]{1,30}$/;
const LOOKUP_RE = /^[a-z0-9][a-z0-9_.-]{2,100}$/;
const MAX_CENTS = 99999999;

/**
 * Checks the plans written in plans.ts and returns them. Throws an error that says in plain English what to fix.
 * There must be exactly one free plan (priceCents 0): it is what people get with no subscription.
 * @param {unknown} list
 * @returns {Plan[]}
 */
export function validatePlans(list) {
  const fail = (msg) => {
    throw new Error(`plans.ts: ${msg}`);
  };
  if (!Array.isArray(list) || list.length === 0 || list.length > 6) fail("write between 1 and 6 plans.");
  const ids = new Set();
  const keys = new Set();
  let free = 0;
  let currency = "";
  for (const raw of list) {
    const p = /** @type {Record<string, unknown>} */ (raw);
    if (!p || typeof p !== "object") fail("every plan must be an object.");
    const label = `plan "${String(p.id)}"`;
    if (typeof p.id !== "string" || !ID_RE.test(p.id)) fail(`${label}: id must be lowercase letters, numbers and underscores, starting with a letter.`);
    if (ids.has(p.id)) fail(`${label}: two plans share this id.`);
    ids.add(p.id);
    if (typeof p.name !== "string" || p.name.trim() === "" || p.name.length > 40) fail(`${label}: name must be 1 to 40 characters.`);
    if (!Number.isInteger(p.priceCents) || p.priceCents < 0 || p.priceCents > MAX_CENTS) fail(`${label}: priceCents must be a whole number of cents, 0 or more (for example 900 for 9.00).`);
    if (typeof p.currency !== "string" || !/^[A-Za-z]{3}$/.test(p.currency)) fail(`${label}: currency must be a 3-letter code such as EUR.`);
    const code = p.currency.toUpperCase();
    if (currency && currency !== code) fail(`${label}: all plans must use the same currency.`);
    currency = code;
    if (p.interval !== "month" && p.interval !== "year") fail(`${label}: interval must be "month" or "year".`);
    if (!Array.isArray(p.features) || p.features.length > 10 || !p.features.every((f) => typeof f === "string" && f.trim() !== "" && f.length <= 120)) {
      fail(`${label}: features must be a list of up to 10 short sentences.`);
    }
    if (p.freeQuota !== undefined) {
      const q = /** @type {Record<string, unknown>} */ (p.freeQuota);
      if (!q || !Number.isInteger(q.amount) || q.amount < 0 || typeof q.unit !== "string" || q.unit.trim() === "") fail(`${label}: freeQuota must look like { "amount": 10, "unit": "items" }.`);
    }
    if (p.priceCents === 0) {
      free += 1;
      if (p.lookupKey) fail(`${label}: the free plan has no lookupKey (it is not sold).`);
    } else {
      if (typeof p.lookupKey !== "string" || !LOOKUP_RE.test(p.lookupKey)) fail(`${label}: a paid plan needs a lookupKey of lowercase letters, numbers, dashes and underscores (3 to 100 characters).`);
      if (keys.has(p.lookupKey)) fail(`${label}: two plans share this lookupKey.`);
      keys.add(p.lookupKey);
    }
  }
  if (free !== 1) fail(`exactly one plan must be free (priceCents 0), not ${free}.`);
  return /** @type {Plan[]} */ (list);
}

/** @param {readonly Plan[]} plans */
export const freePlan = (plans) => /** @type {Plan} */ (plans.find((p) => p.priceCents === 0));

/** @param {readonly Plan[]} plans */
export const paidPlans = (plans) => plans.filter((p) => p.priceCents > 0);

/** @param {readonly Plan[]} plans @param {unknown} id */
export const planById = (plans, id) => plans.find((p) => p.id === id) ?? null;

/** @param {readonly Plan[]} plans @param {unknown} key */
export const planByLookupKey = (plans, key) => (typeof key === "string" && key ? plans.find((p) => p.lookupKey === key) ?? null : null);

/** "Free", "€9", "€9.50". The interval is shown separately. @param {Plan} plan */
export function formatPrice(plan, locale = "en") {
  if (plan.priceCents === 0) return "Free";
  const whole = plan.priceCents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: plan.currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(plan.priceCents / 100);
}

/** @param {Plan} plan */
export const intervalLabel = (plan) => (plan.interval === "year" ? "year" : "month");

// ---------------------------------------------------------------------------------------------
// Who has which plan

/** A subscription in these states still gives access. past_due = a renewal payment failed and Stripe is still retrying. */
export const ACCESS_STATUSES = ["active", "trialing", "past_due"];

/** If the renewal message never arrives, access ends this long after the paid period. */
export const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The plan a person has right now, from their row in the subscriptions table (or null for no row).
 * @param {{ plan_id?: string | null, status?: string | null, current_period_end?: string | null } | null | undefined} row
 * @param {readonly Plan[]} plans
 * @param {number} [now]
 * @returns {Plan}
 */
export function planForSubscription(row, plans, now = Date.now()) {
  const free = freePlan(plans);
  if (!row || !row.status || !ACCESS_STATUSES.includes(row.status)) return free;
  const plan = planById(plans, row.plan_id);
  if (!plan || plan.priceCents === 0) return free;
  const end = row.current_period_end ? Date.parse(row.current_period_end) : NaN;
  if (Number.isFinite(end) && end + GRACE_MS < now) return free;
  return plan;
}

/**
 * What the billing section tells the person about their subscription.
 * @param {{ plan_id?: string | null, status?: string | null, current_period_end?: string | null, cancel_at_period_end?: boolean | null } | null | undefined} row
 * @param {readonly Plan[]} plans
 * @param {number} [now]
 */
export function describeSubscription(row, plans, now = Date.now()) {
  const plan = planForSubscription(row, plans, now);
  const paid = plan.priceCents > 0;
  return {
    plan,
    paid,
    pastDue: paid && row?.status === "past_due",
    cancelsAtPeriodEnd: paid && row?.cancel_at_period_end === true,
    periodEnd: paid && row?.current_period_end ? row.current_period_end : null,
  };
}
