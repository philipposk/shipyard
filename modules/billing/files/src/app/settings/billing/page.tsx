import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getSessionUser } from "@/lib/session";
import { BillingSection } from "@/components/billing/BillingSection";
import { TestModeBanner } from "@/components/billing/TestModeBanner";

export const metadata: Metadata = { title: "Billing" };

// Where Stripe sends people back to after paying or managing their subscription.
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in?next=/settings/billing");
  const { checkout } = await searchParams;

  return (
    <AppShell signedIn userLabel={user.email ?? undefined}>
      <div className="page-header">
        <h1 className="page-title">Billing</h1>
      </div>
      <div className="space-y-4">
        <TestModeBanner />
        <BillingSection justPaid={checkout === "success"} />
      </div>
    </AppShell>
  );
}
