import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/admin";

// Public uptime probe. 200 when the database answers a one-row read within 5 seconds, 503 otherwise.
// The body is only ok / not ok and how long it took. No row is returned.
// Supabase's /auth/v1/health keeps answering 200 while the database is stuck, so it cannot be the probe.
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 5000;
const NO_STORE = { "Cache-Control": "no-store" };

function fail(db: "unconfigured" | "error" | "timeout", ms: number) {
  return NextResponse.json({ ok: false, db, ms }, { status: 503, headers: NO_STORE });
}

export async function GET() {
  const started = Date.now();
  let admin;
  try {
    admin = createSupabaseAdmin();
  } catch {
    return fail("unconfigured", Date.now() - started);
  }
  try {
    const query = admin
      .from("profiles")
      .select("id", { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    const raced = await Promise.race([
      query.then((result) => ({ kind: "done" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), DB_TIMEOUT_MS)),
    ]);
    const ms = Date.now() - started;
    if (raced.kind === "timeout") return fail("timeout", ms);
    if (raced.result.error) return fail("error", ms);
    return NextResponse.json({ ok: true, ms }, { headers: NO_STORE });
  } catch {
    return fail("timeout", Date.now() - started);
  }
}
