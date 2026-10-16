import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { getIsAdmin, getSessionUser } from "@/lib/session";
import { PLANS } from "@/lib/billing/plans";
import { formatPrice, intervalLabel } from "@/lib/billing/plans-core.mjs";
import { billingEnabled } from "@/lib/billing/stripe";
import { getPlan } from "@/lib/billing/entitlement";
import { PlanButton } from "@/components/billing/PlanButton";
import { PortalButton } from "@/components/billing/PortalButton";
import { TestModeBanner } from "@/components/billing/TestModeBanner";

export const metadata: Metadata = { title: "Pricing" };

export default async function PricingPage() {
  const user = await getSessionUser();
  const current = user ? await getPlan(user.id) : null;
  const enabled = billingEnabled();
  const admin = await getIsAdmin();

  return (
    <AppShell signedIn={Boolean(user)} userLabel={user?.email ?? undefined}>
      <div className="page-header">
        <h1 className="page-title">Pricing</h1>
      </div>
      <div className="space-y-4">
        <TestModeBanner />
        {!enabled && (
          <p className="m-0 muted" role="status">
            Paid plans are not available yet.
            {admin ? " Finish the payments setup in Shipyard, then this page starts working." : ""}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {PLANS.map((plan) => {
            const isCurrent = current?.id === plan.id;
            const paid = plan.priceCents > 0;
            return (
              <section key={plan.id} className="card card-pad flex flex-col gap-4" aria-labelledby={`plan-${plan.id}`}>
                <div>
                  <h2 id={`plan-${plan.id}`} className="m-0">{plan.name}</h2>
                  <p className="m-0 mt-2">
                    <span className="text-3xl font-semibold">{formatPrice(plan)}</span>
                    {paid && <span className="muted"> a {intervalLabel(plan)}</span>}
                  </p>
                </div>
                <ul className="m-0 space-y-2 pl-5 list-disc grow">
                  {plan.freeQuota && <li>Up to {plan.freeQuota.amount} {plan.freeQuota.unit}</li>}
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                {isCurrent && paid ? (
                  <PortalButton />
                ) : isCurrent ? (
                  <span className="btn btn-secondary w-full" aria-disabled="true">Your plan</span>
                ) : !paid ? (
                  user ? null : (
                    <Link href="/sign-in" className="btn btn-secondary w-full">
                      Get started
                    </Link>
                  )
                ) : !user ? (
                  <Link href="/sign-in?next=/pricing" className="btn btn-primary w-full">
                    Sign in to upgrade
                  </Link>
                ) : enabled ? (
                  <PlanButton planId={plan.id} label={`Choose ${plan.name}`} />
                ) : (
                  <span className="btn btn-secondary w-full" aria-disabled="true">Not available yet</span>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
