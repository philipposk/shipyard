import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { hasSessionCookie } from "@/lib/session";
import { SITE_NAME } from "@/lib/constants";

export const metadata: Metadata = { title: "Help" };

export default async function HelpPage() {
  return (
    <AppShell signedIn={await hasSessionCookie()}>
      <h1 className="page-title mb-4">Help</h1>
      <div className="space-y-3 muted">
        <p>
          Cannot sign in? Choose &ldquo;Forgot password?&rdquo; on the{" "}
          <Link href="/sign-in" className="link">
            sign-in page
          </Link>
          .
        </p>
        <p>For anything else, contact the person who runs {SITE_NAME}.</p>
      </div>
    </AppShell>
  );
}
