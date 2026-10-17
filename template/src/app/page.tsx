import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { HOME_PATTERNS } from "@/components/home";
import { getSessionUser } from "@/lib/session";
import { SITE_DESCRIPTION } from "@/lib/constants";
import { HOME_STYLE } from "@/lib/theme";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ notice?: string | string[] }> }) {
  const user = await getSessionUser();
  const { notice } = await searchParams;

  if (user) {
    return (
      <AppShell signedIn userLabel={user.email ?? undefined}>
        <div className="page-header">
          <h1 className="page-title">Home</h1>
        </div>
        <div className="card card-pad">
          <p className="m-0 mb-4">{SITE_DESCRIPTION}</p>
          <Link href="/items" className="btn btn-primary">
            Open items
          </Link>
        </div>
      </AppShell>
    );
  }

  // Visitors who are not signed in see the landing page. HOME_STYLE (set by the design step) picks the pattern,
  // and src/lib/home-content.ts holds the words.
  const Home = HOME_PATTERNS[HOME_STYLE];
  return (
    <AppShell>
      {notice === "account-deleted" ? (
        <p className="card card-pad mt-0 mb-4" role="status">
          Your account has been deleted.
        </p>
      ) : null}
      {notice === "account-data-deleted" ? (
        <p className="card card-pad mt-0 mb-4" role="status">
          Your data in this app has been deleted. Your login stays, because other apps use it too.
        </p>
      ) : null}
      <Home />
    </AppShell>
  );
}
