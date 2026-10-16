import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { PLANS } from "@/lib/billing/plans";
import { describeSubscription, formatPrice, intervalLabel } from "@/lib/billing/plans-core.mjs";
import { billingEnabled } from "@/lib/billing/stripe";
import { PortalButton } from "./PortalButton";
import { WithdrawButton } from "./WithdrawButton";
import { RefreshWhilePending } from "./RefreshWhilePending";

const longDate = (iso: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(new Date(iso));

/**
 * The billing part of the Settings page: the current plan, how to change it, and how to manage the card and invoices.
 * Set `justPaid` right after returning from Stripe: the page then reloads itself until the new plan shows.
 */
export async function BillingSection({ justPaid = false }: { justPaid?: boolean }) {
  const user = await getSessionUser();
  if (!user) return null;

  const supabase = await createSupabaseServer();
  const [{ data: subscription }, { data: customer }] = await Promise.all([
    supabase.from("subscriptions").select("plan_id, status, current_period_end, cancel_at_period_end").eq("user_id", user.id).maybeSingle(),
    supabase.from("billing_customers").select("stripe_customer_id").eq("user_id", user.id).maybeSingle(),
  ]);
  const info = describeSubscription(subscription, PLANS);
  const enabled = billingEnabled();

  let line: string;
  if (!enabled && !info.paid) line = "Paid plans are not available yet.";
  else if (!info.paid) line = justPaid ? "Payment received. Your plan is being set up." : "You are on the free plan.";
  else if (info.pastDue) line = "The last payment did not go through. Update your card with Manage billing.";
  else if (info.cancelsAtPeriodEnd && info.periodEnd) line = `Your plan ends on ${longDate(info.periodEnd)}. You keep it until then.`;
  else if (info.periodEnd) line = `Renews on ${longDate(info.periodEnd)} at ${formatPrice(info.plan)} a ${intervalLabel(info.plan)}.`;
  else line = "Your plan is active.";

  return (
    <section className="card card-pad space-y-4" aria-labelledby="billing-heading">
      <RefreshWhilePending active={justPaid && !info.paid} />
      <h2 id="billing-heading" className="m-0">Billing</h2>
      <div>
        <p className="m-0"><strong>{info.plan.name}</strong></p>
        <p className="m-0 muted">{line}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {customer?.stripe_customer_id && enabled && <PortalButton />}
        {!info.paid && enabled && (
          <Link href="/pricing" className="btn btn-primary">
            See plans
          </Link>
        )}
      </div>
      {info.paid && enabled && (
        <div className="space-y-2">
          <h3 className="m-0">Changed your mind?</h3>
          <p className="m-0 muted">In the first 14 days after you buy, you can withdraw from the contract. You pay only for the days you used.</p>
          <WithdrawButton />
        </div>
      )}
    </section>
  );
}
