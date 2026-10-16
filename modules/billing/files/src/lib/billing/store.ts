import "server-only";
import { createSupabaseAdmin } from "@/lib/admin";

// The only file that writes billing data. It uses the secret server key because the tables accept no writes from
// signed-in people (see the billing migration): only Stripe's messages, checked by the webhook, may change them.

export interface SubscriptionRow {
  userId: string;
  customerId: string | null;
  subscriptionId: string;
  planId: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  eventAt: string;
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** The webhook's view of the database. */
export function supabaseBillingStore() {
  const db = createSupabaseAdmin();

  return {
    async isHandled(id: string): Promise<boolean> {
      const { data, error } = await db.from("stripe_events").select("id").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },

    async markHandled(id: string, type: string): Promise<void> {
      const { error } = await db.from("stripe_events").upsert({ id, type }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    },

    async userIdForCustomer(customerId: string): Promise<string | null> {
      const { data, error } = await db.from("billing_customers").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.user_id ?? null;
    },

    async customerIdForUser(userId: string): Promise<string | null> {
      const { data, error } = await db.from("billing_customers").select("stripe_customer_id").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.stripe_customer_id ?? null;
    },

    async getSubscription(userId: string) {
      const { data, error } = await db
        .from("subscriptions")
        .select("stripe_subscription_id, status, updated_from_event_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },

    /** Remembers which Stripe customer is this person. Never replaces a link that exists. */
    async linkCustomer(userId: string, customerId: string): Promise<void> {
      const { error } = await db
        .from("billing_customers")
        .upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: "user_id", ignoreDuplicates: true });
      // A customer id that already belongs to someone else is left alone.
      if (error && error.code !== UNIQUE_VIOLATION) throw new Error(error.message);
    },

    /** "ok", "stale" (the stored data is newer) or "no_user" (no such account here). */
    async upsertSubscription(row: SubscriptionRow): Promise<string> {
      const record = {
        plan_id: row.planId,
        status: row.status,
        current_period_end: row.currentPeriodEnd,
        cancel_at_period_end: row.cancelAtPeriodEnd,
        stripe_subscription_id: row.subscriptionId,
        updated_from_event_at: row.eventAt,
        updated_at: new Date().toISOString(),
      };
      const { data: existing, error: readError } = await db.from("subscriptions").select("user_id").eq("user_id", row.userId).maybeSingle();
      if (readError) throw new Error(readError.message);
      if (!existing) {
        const { error } = await db.from("subscriptions").insert({ user_id: row.userId, ...record });
        if (!error) return "ok";
        if (error.code === FOREIGN_KEY_VIOLATION) return "no_user";
        if (error.code !== UNIQUE_VIOLATION) throw new Error(error.message);
        // Two messages for the same person arrived together: fall through and update.
      }
      // Only overwrite data that is not newer than this event.
      const { data, error } = await db
        .from("subscriptions")
        .update(record)
        .eq("user_id", row.userId)
        .or(`updated_from_event_at.is.null,updated_from_event_at.lte.${row.eventAt}`)
        .select("user_id");
      if (error) throw new Error(error.message);
      return data && data.length > 0 ? "ok" : "stale";
    },
  };
}

export type BillingStore = ReturnType<typeof supabaseBillingStore>;
