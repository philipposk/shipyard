import { NextResponse } from "next/server";
import { HEALTH_CHECKS } from "@/lib/health/checks";
import { runChecks } from "@/lib/health/run.mjs";
import { buildSummary, checkCronAccess } from "@/lib/errors/core.mjs";
import { countRows, countUnresolved, deleteOldRows } from "@/lib/errors/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * For the scheduled health check (a GitHub Action): ids and statuses of the Health page's checks plus two numbers.
 * Never messages, names or addresses. Closed unless CRON_SECRET is set (16 characters or more), and then only open to
 * a request that sends the same value in the x-cron-secret header.
 */
export async function GET(request: Request) {
  const access = checkCronAccess({ expected: process.env.CRON_SECRET, given: request.headers.get("x-cron-secret") });
  if (!access.ok) return reply({ error: access.status === 404 ? "Not found" : "Unauthorized" }, access.status);

  const results = await runChecks(HEALTH_CHECKS, { timeoutMs: 5000 });

  let errors24h: number | null = null;
  let unresolved: number | null = null;
  try {
    [errors24h, unresolved] = await Promise.all([countRows(24), countUnresolved()]);
    // Old rows are removed daily by Supabase Cron when it is on. Doing it here as well costs nothing and covers the rest.
    await deleteOldRows().catch(() => undefined);
  } catch {
    // The numbers stay empty; the errors check above already says the log can not be read.
  }
  return reply(buildSummary(results, { errors24h, unresolved }), 200);
}
