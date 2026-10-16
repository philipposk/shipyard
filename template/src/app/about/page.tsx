import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { hasSessionCookie } from "@/lib/session";
import { SITE_NAME, SITE_DESCRIPTION } from "@/lib/constants";

export const metadata: Metadata = { title: "About" };

export default async function AboutPage() {
  return (
    <AppShell signedIn={await hasSessionCookie()}>
      <h1 className="page-title mb-4">About {SITE_NAME}</h1>
      <p className="muted">{SITE_DESCRIPTION}</p>
    </AppShell>
  );
}
