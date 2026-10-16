import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { hasSessionCookie } from "@/lib/session";
import { BRAND } from "@/lib/constants";
import { looksLikeToken } from "@/lib/newsletter/core.mjs";
import { UnsubscribeForm } from "./unsubscribe-form";

export const metadata: Metadata = { title: "Email updates", robots: { index: false } };

// Where the link at the bottom of every update email leads. Anyone can open it, signed in or not.
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const valid = looksLikeToken(token);
  return (
    <AppShell signedIn={await hasSessionCookie()}>
      <div className="mx-auto max-w-md py-8 space-y-4">
        <h1 className="page-title">{valid ? "Stop update emails?" : "This link did not work"}</h1>
        {valid ? (
          <UnsubscribeForm token={token as string} brandName={BRAND.name} />
        ) : (
          <>
            <p className="m-0 muted">The link is incomplete or out of date. Sign in and switch updates off in Settings instead.</p>
            <Link href="/settings" className="btn btn-primary">
              Open Settings
            </Link>
          </>
        )}
      </div>
    </AppShell>
  );
}
