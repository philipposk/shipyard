import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DeleteAccountSection } from "@/components/DeleteAccountSection";
import { SignOutButton } from "@/components/SignOutButton";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getSessionUser();

  return (
    <AppShell signedIn userLabel={user?.email ?? undefined}>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>
      <div className="space-y-4">
        <section className="card card-pad space-y-4" aria-labelledby="account-heading">
          <h2 id="account-heading" className="m-0">Account</h2>
          <p className="m-0 muted break-words">{user?.email}</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/profile/edit" className="btn btn-secondary">
              Edit profile
            </Link>
            <SignOutButton />
          </div>
        </section>
        {/* shipyard:settings-sections:start (modules add their sections here, for example Billing) */}
        {/* shipyard:settings-sections:end */}
        <DeleteAccountSection />
      </div>
    </AppShell>
  );
}
