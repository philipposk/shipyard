import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { LegalDocument } from "@/components/LegalDocument";
import { controller, terms, updatedAt } from "@/lib/legal-content";
import { hasSessionCookie } from "@/lib/session";

export const metadata: Metadata = { title: "Terms of Service" };

// The words live in src/lib/legal-content.ts (written by Shipyard's legal-generate script).
export default async function TermsPage() {
  return (
    <AppShell signedIn={await hasSessionCookie()}>
      <LegalDocument title="Terms of Service" sections={terms} updatedAt={updatedAt} controller={controller} />
    </AppShell>
  );
}
