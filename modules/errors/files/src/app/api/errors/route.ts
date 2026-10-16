import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/constants";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { getSessionUser } from "@/lib/session";
import { CLIENT_REPORTS_PER_MINUTE, MAX_REPORT_BYTES, clientAlert, clientKey, createRateLimit, parseClientReport } from "@/lib/errors/core.mjs";
import { reportError } from "@/lib/errors/report";

export const runtime = "nodejs";

// Anyone can post here (a visitor's page crashed), so it is small and slow on purpose: 4 KB at most, the answer is
// always the same, each address gets 5 reports a minute, and all addresses together get 60. In memory, so it is a
// brake, not a guarantee. The owner's email about a crash is always the same generic text, at most one per
// ERROR_ALERT_HOURS for all visitors together (see clientAlert): a stranger can fill the log, never the inbox.
const perAddress = createRateLimit({ windowMs: 60_000, max: 5 });
const overall = createRateLimit({ windowMs: 60_000, max: CLIENT_REPORTS_PER_MINUTE, maxKeys: 1 });

/** A crashed page tells the owner. Body: { message, route, digest?, source? }. */
export async function POST(request: Request) {
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.json({ error: "This request did not come from the app." }, { status: 403 });
  }
  if (!perAddress.hit(clientKey(request.headers))) {
    return NextResponse.json({ error: "Too many reports. Try again in a minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }
  if (!overall.hit("all")) {
    return NextResponse.json({ error: "Too many reports. Try again in a minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REPORT_BYTES) return NextResponse.json({ error: "Report too big." }, { status: 413 });

  const parsed = parseClientReport(await request.text().catch(() => ""));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const { report } = parsed;

  let userId: string | null = null;
  try {
    userId = (await getSessionUser())?.id ?? null;
  } catch {
    // Signed out, or the login service is down: the report is still useful.
  }
  await reportError({
    area: report.area,
    fingerprint: report.fingerprint,
    message: `${report.message}\nPage: ${report.route}${report.digest ? `\nError code: ${report.digest}` : ""}`,
    userId,
    detail: { route: report.route, source: report.source },
    ...clientAlert(),
  });
  return NextResponse.json({ ok: true });
}
