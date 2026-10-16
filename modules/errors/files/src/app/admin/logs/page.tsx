import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ResolveButton } from "@/components/errors/ResolveButton";
import { getLogsAdmin } from "@/lib/errors/admin";
import { areasOf, formatWhen, groupErrors } from "@/lib/errors/core.mjs";
import { recentRows } from "@/lib/errors/store";

export const metadata: Metadata = { title: "Error log", robots: { index: false, follow: false } };
// Reads the log fresh on every visit.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ area?: string; resolved?: string }>;

/** Admin only. Anyone else (signed in or not) gets the ordinary 404 page, as if this page did not exist. */
export default async function LogsPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await getLogsAdmin();
  if (!admin) notFound();

  const params = await searchParams;
  const includeResolved = params.resolved === "1";
  const area = typeof params.area === "string" ? params.area.slice(0, 100) : "";

  let rows: Awaited<ReturnType<typeof recentRows>> | null = null;
  try {
    rows = await recentRows({ includeResolved });
  } catch {
    rows = null;
  }
  const groups = rows ? groupErrors(rows, { includeResolved, area }) : [];
  const areas = rows ? areasOf(rows) : [];
  const link = (next: { area?: string; resolved?: boolean }) => {
    const q = new URLSearchParams();
    const a = next.area ?? "";
    if (a) q.set("area", a);
    if (next.resolved) q.set("resolved", "1");
    const text = q.toString();
    return text ? `/admin/logs?${text}` : "/admin/logs";
  };

  return (
    <AppShell signedIn userLabel={admin.email ?? undefined} isAdmin>
      <div className="page-header">
        <h1 className="page-title">Error log</h1>
        <Link href="/admin/health" className="btn btn-secondary">
          Health
        </Link>
      </div>

      {rows === null ? (
        <section className="card card-pad space-y-2" role="alert">
          <h2 className="m-0">The log could not be read</h2>
          <p className="m-0 muted">Run provision-supabase.mjs in Shipyard again so the error_log table exists, then reload this page.</p>
        </section>
      ) : (
        <>
          <nav className="flex flex-wrap gap-2 mb-4" aria-label="Filter">
            <Link href={link({ resolved: includeResolved })} className={area === "" ? "btn btn-primary" : "btn btn-secondary"}>
              All areas
            </Link>
            {areas.map((a) => (
              <Link key={a} href={link({ area: a, resolved: includeResolved })} className={area === a ? "btn btn-primary" : "btn btn-secondary"}>
                {a}
              </Link>
            ))}
            <Link href={link({ area, resolved: !includeResolved })} className="btn btn-ghost">
              {includeResolved ? "Hide resolved" : "Show resolved"}
            </Link>
          </nav>

          {groups.length === 0 ? (
            <section className="card card-pad space-y-2">
              <h2 className="m-0">Nothing to look at</h2>
              <p className="m-0 muted">No problems in the last 30 days{includeResolved ? "" : " that are not marked resolved"}.</p>
            </section>
          ) : (
            <ul className="space-y-3 list-none m-0 p-0" aria-label="Problems">
              {groups.map((g) => (
                <li key={g.fingerprint} className="card card-pad space-y-2">
                  <p className="m-0 muted">
                    {g.area} · {g.count} {g.count === 1 ? "time" : "times"}
                    {g.resolved ? " · resolved" : ""}
                  </p>
                  <p className="m-0 break-words" style={{ whiteSpace: "pre-wrap" }}>{g.message}</p>
                  <p className="m-0 muted">
                    First seen {formatWhen(g.firstSeen)} · last seen {formatWhen(g.lastSeen)}
                  </p>
                  {!g.resolved && <ResolveButton fingerprint={g.fingerprint} />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </AppShell>
  );
}
