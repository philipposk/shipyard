import "server-only";
import { billingEnabled, getStripe } from "./stripe";
import { supabaseBillingStore } from "./store";
import { assertCanCloseBilling, cancelCustomerSubscriptions } from "./account.mjs";

/**
 * Runs before an account is deleted (registered in PRE_DELETE_HOOKS, src/lib/account/pre-delete.ts). Cancels the
 * person's Stripe subscriptions so nobody keeps being charged for an account that no longer exists. If Stripe
 * refuses, or payments are switched off while the person has a Stripe customer, it throws and the account is kept, so the person can try again. Safe to run twice.
 */
export async function cancelBillingOnDelete(ctx: { userId: string }): Promise<void> {
  const customerId = await supabaseBillingStore().customerIdForUser(ctx.userId);
  if (!customerId) return;
  // Someone who has paid is never deleted while payments are off: Stripe would keep charging them.
  assertCanCloseBilling({ customerId, enabled: billingEnabled() });
  await cancelCustomerSubscriptions(getStripe(), customerId);
}
