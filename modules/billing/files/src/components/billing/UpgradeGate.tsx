import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { getPlan, isPaidPlan } from "@/lib/billing/entitlement";

/**
 * Wrap a part of a page that needs a paid plan:
 *   <UpgradeGate title="Export to PDF">...the paid feature...</UpgradeGate>
 * People on the free plan see a short note and a link to the pricing page instead of the content.
 */
export async function UpgradeGate({ title, children }: { title: string; children: React.ReactNode }) {
  const user = await getSessionUser();
  const plan = user ? await getPlan(user.id) : null;
  if (plan && isPaidPlan(plan)) return <>{children}</>;
  return (
    <div className="card card-pad space-y-3">
      <h2 className="m-0">{title}</h2>
      <p className="m-0 muted">This is part of the paid plan.</p>
      <Link href={user ? "/pricing" : "/sign-in?next=/pricing"} className="btn btn-primary">
        {user ? "See plans" : "Sign in to see plans"}
      </Link>
    </div>
  );
}
