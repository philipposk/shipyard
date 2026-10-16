import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { HEALTH_CHECKS } from "@/lib/health/checks";
import { STATUS_WORDS, runChecks, summarize } from "@/lib/health/run.mjs";
import { getIsAdmin, getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Health", robots: { index: false, follow: false } };
// Runs the checks fresh on every visit.
export const dynamic = "force-dynamic";

/** Admin only. Anyone else (signed in or not) gets the ordinary 404 page, as if this page did not exist. */
export default async function HealthPage() {
  const user = await getSessionUser();
  if (!user || !(await getIsAdmin())) notFound();

  const results = await runChecks(HEALTH_CHECKS, { timeoutMs: 5000 });
  const { headline } = summarize(results);

  return (
    <AppShell signedIn userLabel={user.email ?? undefined} isAdmin>
      <div className="page-header">
        <h1 className="page-title">Health</h1>
        <a href="/admin/health" className="btn btn-secondary">
          Check again
        </a>
      </div>
      <p className="mt-0 mb-4" role="status">
        {headline}
      </p>
      <section className="card" aria-label="Checks">
        <ul className="health-list">
          {results.map((r) => (
            <li key={r.id} className={`health-item health-${r.status}`}>
              <span className="health-badge">{STATUS_WORDS[r.status as keyof typeof STATUS_WORDS]}</span>
              <div className="min-w-0">
                <p className="health-label">{r.label}</p>
                <p className="health-detail">{r.detail}</p>
                {r.fix ? <p className="health-fix">What to do: {r.fix}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}
