import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { LegalDocument } from "@/components/LegalDocument";
import { controller, privacy, updatedAt } from "@/lib/legal-content";
import { hasSessionCookie } from "@/lib/session";

export const metadata: Metadata = { title: "Privacy Policy" };

// The words live in src/lib/legal-content.ts (written by Shipyard's legal-generate script).
export default async function PrivacyPage() {
  return (
    <AppShell signedIn={await hasSessionCookie()}>
      <LegalDocument title="Privacy Policy" sections={privacy} updatedAt={updatedAt} controller={controller} />
    </AppShell>
  );
}
