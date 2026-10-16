import { validatePlans, freePlan as pickFree, paidPlans as pickPaid, planById as pickById, planByLookupKey as pickByKey } from "./plans-core.mjs";
import type { Plan } from "./plans-core.mjs";

export type { Plan };

/**
 * The plans you sell. Edit the block between the two markers: it is plain JSON (double quotes, no trailing commas),
 * because Shipyard's Stripe setup reads exactly this block to create your products and prices.
 *
 *   id          short name used in the database, never change it once people have paid
 *   priceCents  price in cents (900 = 9.00). 0 means the free plan: there must be exactly one
 *   currency    3-letter code, the same for every plan
 *   interval    "month" or "year"
 *   lookupKey   the name Stripe finds the price by. Keep it unique; changing the price later keeps the key
 *   features    short sentences shown on the pricing page
 *   freeQuota   optional, what the free plan allows, for example { "amount": 10, "unit": "items" }
 *
 * After changing prices, run Shipyard's Stripe setup again so Stripe matches this file.
 */
export const PLANS: readonly Plan[] = validatePlans(
// shipyard:plans:start
[
  {
    "id": "free",
    "name": "Free",
    "priceCents": 0,
    "currency": "EUR",
    "interval": "month",
    "features": ["Everything you need to get started"],
    "freeQuota": { "amount": 10, "unit": "items" }
  },
  {
    "id": "pro",
    "name": "Pro",
    "priceCents": 900,
    "currency": "EUR",
    "interval": "month",
    "lookupKey": "<APP_SLUG>_pro_monthly",
    "features": ["No limits", "Priority support"]
  }
]
// shipyard:plans:end
);

export const freePlan = (): Plan => pickFree(PLANS);
export const paidPlans = (): Plan[] => pickPaid(PLANS);
export const planById = (id: unknown): Plan | null => pickById(PLANS, id);
export const planByLookupKey = (key: unknown): Plan | null => pickByKey(PLANS, key);
