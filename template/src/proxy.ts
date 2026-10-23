// Next 16 renamed middleware.ts to proxy.ts (the function is called `proxy`). It runs before every page and:
//   1. refreshes the login session so it does not expire while someone is using the app,
//   2. sends signed-out visitors to /sign-in for private pages,
//   3. sends signed-in visitors who have not finished their profile to /profile/edit (pages), or answers
//      403 {"error":"onboarding_required"} (API routes), so skipping the page does not skip onboarding.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { authCookieOptions } from "@/lib/supabase/cookies";
import { SUPABASE_SCHEMA } from "@/lib/supabase/schema.mjs";
import { SITE_SLUG } from "@/lib/constants";
import { safeNext } from "@/lib/safe-next.mjs";
import { onboardedCookieSecret, signOnboarded, verifyOnboarded } from "@/lib/auth/onboarded-cookie.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Pages and routes anyone can open without signing in. Every folder under src/app/api/auth must be listed here,
// or sign-up and password reset break for signed-out visitors.
const PUBLIC_PREFIXES = [
  "/sign-in",
  "/auth/callback",
  "/auth/confirm",
  "/auth/sign-out",
  "/reset-password",
  "/about",
  "/help",
  "/privacy",
  "/terms",
  "/clear-cache",
  "/api/health",
  "/api/auth/signup",
  "/api/auth/forgot-password",
  "/api/auth/resend-confirmation",
];

// API routes that also accept `Authorization: Bearer <access token>` from scripts (and the Shipyard verify tool).
// The route itself must check the token. Keep this list short: any route listed here is reachable without a cookie.
const BEARER_API_PREFIXES = ["/api/profile"];

// A signed-in person who has not finished their profile may only open these (pages and API routes).
// Every API route that the pages below call must be listed too, or they answer 403 before setup is done.
const ONBOARDING_ALLOWED = ["/profile/edit", "/api/profile", "/api/account", "/auth/sign-out", "/settings"];

// Remembers (per browser) which user has a finished profile, so we skip one database lookup per request.
// The value is `<userId>.<signature>` (src/lib/auth/onboarded-cookie.mjs): a plain value could be typed in by anyone.
const ONBOARDED_COOKIE = `${SITE_SLUG}_onboarded`;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function createProxySupabase(req: NextRequest, res: NextResponse) {
  return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookieOptions: authCookieOptions,
    db: { schema: SUPABASE_SCHEMA },
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
        cookiesToSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
}

// A person with no profile row yet counts as not finished: they go to /profile/edit, which creates the row.
async function isOnboarded(supabase: ReturnType<typeof createProxySupabase>, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarding_complete")
    .eq("id", userId)
    .maybeSingle();
  return profile?.onboarding_complete === true;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The design preview page only exists while building: it needs no sign-in and no database there,
  // and in a production build it is a plain 404 (not a redirect to sign-in).
  if (matchesPrefix(pathname, "/design-preview")) {
    return process.env.NODE_ENV === "production" ? new NextResponse(null, { status: 404 }) : NextResponse.next();
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    if (pathname.startsWith("/api/health")) {
      return NextResponse.json({ status: "degraded", app: SITE_SLUG });
    }
    return new NextResponse("Service temporarily unavailable", { status: 503 });
  }

  // Always ask Supabase who this is, so an expiring session gets renewed on its way through.
  const res = NextResponse.next({ request: req });
  const supabase = createProxySupabase(req, res);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Already signed in: skip the sign-in page.
  if (pathname === "/sign-in" && user) {
    const url = req.nextUrl.clone();
    url.pathname = (await isOnboarded(supabase, user.id))
      ? safeNext(req.nextUrl.searchParams.get("next"), "/")
      : "/profile/edit";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    res.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  if (PUBLIC_PREFIXES.some((p) => matchesPrefix(pathname, p))) return res;

  // The home page is public: a landing page for visitors, a dashboard for members.
  if (pathname === "/" && !user) return res;

  if (!user) {
    if (pathname.startsWith("/api/")) {
      const hasBearer = req.headers.get("authorization")?.toLowerCase().startsWith("bearer ");
      if (hasBearer && BEARER_API_PREFIXES.some((p) => matchesPrefix(pathname, p))) return res;
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (ONBOARDING_ALLOWED.some((p) => matchesPrefix(pathname, p))) return res;

  const secret = onboardedCookieSecret();
  if (await verifyOnboarded(req.cookies.get(ONBOARDED_COOKIE)?.value, user.id, secret)) return res;

  if (!(await isOnboarded(supabase, user.id))) {
    // API routes enforce onboarding too: otherwise a script (or the browser console) skips the setup page.
    if (pathname.startsWith("/api/")) {
      const denied = NextResponse.json({ error: "onboarding_required" }, { status: 403 });
      res.cookies.getAll().forEach((c) => denied.cookies.set(c));
      return denied;
    }
    const url = req.nextUrl.clone();
    url.pathname = "/profile/edit";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    res.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  const signed = await signOnboarded(user.id, secret);
  if (signed) {
    res.cookies.set(ONBOARDED_COOKIE, signed, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return res;
}

export const config = {
  matcher: [
    // Skip static files (images, icons, manifest, robots, sitemap, llms.txt) and the service worker.
    "/((?!_next/static|_next/image|favicon.ico|sw.js|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|webmanifest|txt|xml)$).*)",
  ],
};
