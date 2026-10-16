import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { BRAND, SITE_URL } from "@/lib/constants";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { billingEnabled, getStripe } from "@/lib/billing/stripe";
import { ownCustomerId } from "@/lib/billing/customers";
import { BLOCKING_STATUSES, withdrawalRefundCents, withinWithdrawalWindow } from "@/lib/billing/checkout-core.mjs";
import { sendWithdrawalEmails } from "@/lib/billing/withdraw-email";

export const runtime = "nodejs";

/**
 * "Withdraw from contract here": the online button the EU asks for (Directive 2023/2673, Article 11a of the Consumer
 * Rights Directive). A signed-in person inside the first 14 days ends their subscription at once. This route cancels it
 * in Stripe, writes the request on the Stripe subscription and customer (a record that outlives the account), and
 * emails a confirmation to the person and a note to the owner, who refunds the unused share in the Stripe dashboard.
 */
export async function POST(request: Request) {
  if (!billingEnabled()) return NextResponse.json({ error: "Payments are not switched on yet." }, { status: 503 });
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.json({ error: "This request did not come from the app." }, { status: 403 });
  }

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const customer = await ownCustomerId();
  if (!customer) return NextResponse.json({ error: "There is no paid plan to withdraw from." }, { status: 400 });

  try {
    const stripe = getStripe();
    const list = await stripe.subscriptions.list({ customer, status: "all", limit: 10 });
    const live = list.data.find((s) => BLOCKING_STATUSES.includes(s.status));
    if (!live) return NextResponse.json({ error: "There is no paid plan to withdraw from." }, { status: 400 });
    if (!withinWithdrawalWindow(live.start_date)) {
      return NextResponse.json({ error: "The 14 days to withdraw are over. You can still cancel with Manage billing and keep your plan until the period ends." }, { status: 400 });
    }

    const now = new Date();
    const requestedAt = now.toISOString();
    // Last paid invoice of this subscription, to work out what the owner should give back.
    const invoices = await stripe.invoices.list({ customer, status: "paid", limit: 5 });
    const invoice = invoices.data[0];
    const line = invoice?.lines?.data?.[0];
    const refundCents = withdrawalRefundCents({
      amountPaidCents: invoice?.amount_paid ?? 0,
      periodStartSeconds: line?.period?.start ?? live.start_date,
      periodEndSeconds: line?.period?.end ?? live.start_date,
      now: now.getTime(),
    });

    // Write the request down first, then cancel. If cancelling fails the person can press the button again.
    await stripe.subscriptions.update(live.id, { metadata: { withdrawal_requested_at: requestedAt } });
    await stripe.customers.update(customer, { metadata: { withdrawal_requested_at: requestedAt, withdrawal_subscription: live.id } });
    await stripe.subscriptions.cancel(live.id, { prorate: false, invoice_now: false });

    const emailed = await sendWithdrawalEmails({
      to: user.email ?? "",
      appName: BRAND.name,
      requestedAt,
      refundCents,
      currency: invoice?.currency ?? "eur",
      invoiceId: invoice?.id ?? "",
    });
    return NextResponse.json({ ok: true, emailed, refundCents });
  } catch (error) {
    console.error("[billing] withdrawal failed:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Could not process the withdrawal. Try again in a minute, or write to us." }, { status: 502 });
  }
}
