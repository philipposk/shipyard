import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSupabaseServer } from "@/lib/supabase/server";
import { deleteAccount } from "@/lib/auth/delete-account";
import { AUTH_COOKIE_NAME } from "@/lib/supabase/cookies";
import { SITE_SLUG, SITE_URL } from "@/lib/constants";
import { isDeleteConfirmation } from "@/lib/account/run-hooks.mjs";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { createLimiter } from "@/lib/rate-limit.mjs";

/**
 * Deletes the signed-in person's own account for good. Store reviewers (Apple, Google) require this.
 * Needs: a login, a request from this same site, and the word DELETE typed by the person.
 * The proxy already answers 401 to signed-out callers; this route checks again and never takes a user id from the request.
 */

const tries = createLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

export async function POST(request: Request) {
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.json({ error: "This request did not come from the app." }, { status: 403 });
  }

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!isDeleteConfirmation(body?.confirm)) {
    return NextResponse.json({ error: "Type DELETE to confirm." }, { status: 400 });
  }

  const limit = tries.check(user.id);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many tries. Wait a while and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }
  tries.record(user.id);

  const result = await deleteAccount(user);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // The account is gone: also drop the login cookies from this browser.
  const response = NextResponse.json({ ok: true });
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  for (const c of (await cookies()).getAll()) {
    if (c.name.startsWith(AUTH_COOKIE_NAME)) response.cookies.set(c.name, "", { path: "/", maxAge: 0 });
  }
  response.cookies.set(`${SITE_SLUG}_onboarded`, "", { path: "/", maxAge: 0 });
  return response;
}
