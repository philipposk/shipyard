import "server-only";
import type { User } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { createSupabaseServer } from "@/lib/supabase/server";
import { supabaseBillingStore } from "./store";

/** The Stripe customer of the signed-in person, or null. Read with their own login: privacy rules apply. */
export async function ownCustomerId(): Promise<string | null> {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.from("billing_customers").select("stripe_customer_id").maybeSingle();
  return data?.stripe_customer_id ?? null;
}

/**
 * The Stripe customer for this person, made on first use. The same customer is reused every time, so a person who
 * cancels and comes back keeps one history. If two clicks race, one customer wins and the other is left unused.
 */
export async function getOrCreateCustomer(stripe: Stripe, user: User): Promise<string> {
  const known = await ownCustomerId();
  if (known) return known;
  const customer = await stripe.customers.create(
    { email: user.email ?? undefined, metadata: { user_id: user.id } },
    { idempotencyKey: `customer-${user.id}` },
  );
  const store = supabaseBillingStore();
  await store.linkCustomer(user.id, customer.id);
  return (await store.customerIdForUser(user.id)) ?? customer.id;
}
