import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getNewsletterAdmin } from "@/lib/newsletter/admin";
import { NewsletterComposer } from "@/components/newsletter/NewsletterComposer";

export const metadata: Metadata = { title: "Send an update", robots: { index: false, follow: false } };

// Admin only. Everyone else sees the normal "page not found".
export default async function NewsletterAdminPage() {
  const admin = await getNewsletterAdmin();
  if (!admin?.email) notFound();
  return (
    <AppShell signedIn userLabel={admin.email}>
      <div className="page-header">
        <h1 className="page-title">Send an update</h1>
      </div>
      <NewsletterComposer adminEmail={admin.email} />
    </AppShell>
  );
}
