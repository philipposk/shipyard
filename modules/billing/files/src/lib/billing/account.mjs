// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// Closing a person's subscriptions when their account is deleted.

const FINISHED = ["canceled", "incomplete_expired"];

/**
 * Cancels every subscription of a Stripe customer that is not already finished. Nothing is refunded or invoiced.
 * Throws if Stripe refuses, so the caller can stop the account deletion rather than keep charging someone.
 * @param {{ subscriptions: { list(params: object): Promise<any>, cancel(id: string, params?: object): Promise<any> } }} stripe
 * @param {string} customerId
 * @returns {Promise<string[]>} the ids of the subscriptions that were cancelled
 */
export async function cancelCustomerSubscriptions(stripe, customerId) {
  const cancelled = [];
  let startingAfter;
  for (let page = 0; page < 20; page++) {
    const result = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const data = result?.data ?? [];
    for (const sub of data) {
      if (FINISHED.includes(sub.status)) continue;
      await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false });
      cancelled.push(sub.id);
    }
    if (!result?.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return cancelled;
}

/**
 * Decides whether an account may be deleted without touching Stripe. A person with a Stripe customer can only be
 * deleted when payments are switched on, because otherwise their subscription could not be cancelled and Stripe
 * would keep charging someone whose account is gone. A person who never paid has no customer and is not affected.
 * @param {{ customerId: string | null, enabled: boolean }} input
 */
export function assertCanCloseBilling({ customerId, enabled }) {
  if (customerId && !enabled) {
    throw new Error("Payments are switched off (STRIPE_SECRET_KEY is missing), so this person's subscription could not be cancelled.");
  }
}
