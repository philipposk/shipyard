import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePlans, freePlan, paidPlans, planById, planByLookupKey, formatPrice, planForSubscription, describeSubscription, GRACE_MS,
} from "../src/lib/billing/plans-core.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The plans exactly as Shipyard's Stripe setup reads them: the JSON between the two markers in plans.ts. */
function plansFromFile() {
  const text = readFileSync(path.join(root, "src", "lib", "billing", "plans.ts"), "utf8");
  const m = /\/\/ shipyard:plans:start\r?\n([\s\S]*?)\r?\n\/\/ shipyard:plans:end/.exec(text);
  assert.ok(m, "plans.ts has the start and end markers");
  // In the Shipyard plugin the app's name is still a placeholder here; in a real app it is already filled in.
  return JSON.parse(m[1].replaceAll("<APP_SLUG>", "app"));
}

const good = () => [
  { id: "free", name: "Free", priceCents: 0, currency: "EUR", interval: "month", features: [] },
  { id: "pro", name: "Pro", priceCents: 900, currency: "EUR", interval: "month", lookupKey: "app_pro_monthly", features: ["More"] },
];

test("the plans shipped in plans.ts are valid JSON between the markers and pass the checks", () => {
  const plans = validatePlans(plansFromFile());
  assert.equal(freePlan(plans).priceCents, 0);
  assert.equal(paidPlans(plans).length, 1);
  assert.match(paidPlans(plans)[0].lookupKey, /^[a-z0-9][a-z0-9_.-]{2,100}$/);
});

test("validatePlans accepts a normal list and returns it", () => {
  const list = good();
  assert.equal(validatePlans(list), list);
});

test("validatePlans refuses bad plans with a sentence that says what to fix", () => {
  const cases = [
    [[], /between 1 and 6/],
    ["nope", /between 1 and 6/],
    [[...good(), ...good()], /share this id|between 1 and 6/],
    [good().map((p) => ({ ...p, id: "Free Plan" })), /id must be/],
    [good().map((p) => (p.id === "pro" ? { ...p, priceCents: 9.5 } : p)), /whole number of cents/],
    [good().map((p) => (p.id === "pro" ? { ...p, priceCents: -1 } : p)), /whole number of cents/],
    [good().map((p) => (p.id === "pro" ? { ...p, currency: "euro" } : p)), /3-letter/],
    [good().map((p) => (p.id === "pro" ? { ...p, currency: "USD" } : p)), /same currency/],
    [good().map((p) => (p.id === "pro" ? { ...p, interval: "week" } : p)), /"month" or "year"/],
    [good().map((p) => (p.id === "pro" ? { ...p, lookupKey: undefined } : p)), /needs a lookupKey/],
    [good().map((p) => (p.id === "pro" ? { ...p, lookupKey: "Has Spaces" } : p)), /needs a lookupKey/],
    [good().map((p) => (p.id === "free" ? { ...p, lookupKey: "free_key" } : p)), /free plan has no lookupKey/],
    [good().filter((p) => p.id !== "free"), /exactly one plan must be free/],
    [[...good(), { id: "free2", name: "Free two", priceCents: 0, currency: "EUR", interval: "month", features: [] }], /exactly one plan must be free/],
    [[...good(), { id: "team", name: "Team", priceCents: 2000, currency: "EUR", interval: "month", lookupKey: "app_pro_monthly", features: [] }], /share this lookupKey/],
    [good().map((p) => (p.id === "pro" ? { ...p, features: "fast" } : p)), /features/],
    [good().map((p) => (p.id === "pro" ? { ...p, name: "" } : p)), /name must be/],
    [good().map((p) => (p.id === "free" ? { ...p, freeQuota: { amount: "ten", unit: "items" } } : p)), /freeQuota/],
  ];
  for (const [input, pattern] of cases) assert.throws(() => validatePlans(input), pattern, JSON.stringify(input).slice(0, 80));
});

test("lookups by id and lookup key", () => {
  const plans = good();
  assert.equal(planById(plans, "pro").name, "Pro");
  assert.equal(planById(plans, "nope"), null);
  assert.equal(planByLookupKey(plans, "app_pro_monthly").id, "pro");
  assert.equal(planByLookupKey(plans, ""), null);
  assert.equal(planByLookupKey(plans, null), null);
});

test("formatPrice shows free, whole and part prices", () => {
  const [free, pro] = good();
  assert.equal(formatPrice(free), "Free");
  assert.equal(formatPrice(pro), "€9");
  assert.equal(formatPrice({ ...pro, priceCents: 950 }), "€9.50");
  assert.equal(formatPrice({ ...pro, currency: "usd", priceCents: 1200 }), "$12");
});

test("planForSubscription: paid only while the subscription gives access", () => {
  const plans = good();
  const now = Date.parse("2027-01-10T00:00:00Z");
  const row = (over) => ({ plan_id: "pro", status: "active", current_period_end: "2027-02-01T00:00:00Z", ...over });
  assert.equal(planForSubscription(null, plans, now).id, "free");
  assert.equal(planForSubscription(row(), plans, now).id, "pro");
  assert.equal(planForSubscription(row({ status: "trialing" }), plans, now).id, "pro");
  assert.equal(planForSubscription(row({ status: "past_due" }), plans, now).id, "pro");
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "unknown", null]) {
    assert.equal(planForSubscription(row({ status }), plans, now).id, "free", String(status));
  }
  assert.equal(planForSubscription(row({ plan_id: "gone" }), plans, now).id, "free");
  assert.equal(planForSubscription(row({ plan_id: "free" }), plans, now).id, "free");
});

test("planForSubscription: a missed renewal message ends access only after the grace time", () => {
  const plans = good();
  const end = Date.parse("2027-02-01T00:00:00Z");
  const row = { plan_id: "pro", status: "active", current_period_end: new Date(end).toISOString() };
  assert.equal(planForSubscription(row, plans, end + GRACE_MS - 1000).id, "pro");
  assert.equal(planForSubscription(row, plans, end + GRACE_MS + 1000).id, "free");
  assert.equal(planForSubscription({ plan_id: "pro", status: "active", current_period_end: null }, plans, end * 2).id, "pro");
});

test("describeSubscription says what the billing section shows", () => {
  const plans = good();
  const now = Date.parse("2027-01-10T00:00:00Z");
  const base = { plan_id: "pro", status: "active", current_period_end: "2027-02-01T00:00:00Z", cancel_at_period_end: false };
  assert.deepEqual(describeSubscription(null, plans, now), { plan: plans[0], paid: false, pastDue: false, cancelsAtPeriodEnd: false, periodEnd: null });
  const active = describeSubscription(base, plans, now);
  assert.equal(active.paid, true);
  assert.equal(active.periodEnd, base.current_period_end);
  assert.equal(describeSubscription({ ...base, cancel_at_period_end: true }, plans, now).cancelsAtPeriodEnd, true);
  assert.equal(describeSubscription({ ...base, status: "past_due" }, plans, now).pastDue, true);
  assert.equal(describeSubscription({ ...base, status: "canceled" }, plans, now).paid, false);
});
