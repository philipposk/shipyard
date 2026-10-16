import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/constants";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { getLogsAdmin } from "@/lib/errors/admin";
import { markResolved } from "@/lib/errors/store";
import { serverError } from "@/lib/errors/report";

export const runtime = "nodejs";

/** Admin only: marks one problem as resolved. Body: { fingerprint }. Everyone else gets "not found". */
export async function POST(request: Request) {
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.json({ error: "This request did not come from the app." }, { status: 403 });
  }
  if (!(await getLogsAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : "";
  if (!fingerprint || fingerprint.length > 300) return NextResponse.json({ error: "Say which problem to mark." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, resolved: await markResolved(fingerprint) });
  } catch (error) {
    return serverError("admin:logs:resolve", error, "mark that as resolved");
  }
}
