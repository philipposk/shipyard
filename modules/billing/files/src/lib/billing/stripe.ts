import "server-only";
import Stripe from "stripe";

/**
 * Payments are on only when the Stripe secret key is set. Without it the app still builds and runs,
 * and the billing screens say payments are not set up yet.
 */
export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** "test" while you try things out with fake cards, "live" when real money moves, null with no key. */
export function stripeKeyMode(): "test" | "live" | null {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (/^(?:sk|rk)_test_/.test(key)) return "test";
  if (/^(?:sk|rk)_live_/.test(key)) return "live";
  return null;
}

let client: Stripe | null = null;

/** The Stripe client, made on first use (Stripe refuses an empty key, so it can not be made at load time). */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Payments are not set up: STRIPE_SECRET_KEY is missing.");
  if (!client) client = new Stripe(key);
  return client;
}
