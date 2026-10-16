import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { SIGNUP_MODE, SITE_URL } from "@/lib/constants";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { emailIsProven, parseSource, tokenSecret } from "@/lib/newsletter/core.mjs";
import { setConsent } from "@/lib/newsletter/store";

export const runtime = "nodejs";

// The signed-in person's own choice about update emails. No row means they never said yes.

export async function GET() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { data } = await supabase.from("newsletter_subscribers").select("status").eq("user_id", user.id).maybeSingle();
  return NextResponse.json({ subscribed: data?.status === "subscribed" });
}

// Body: { subscribed: boolean, source?: "signup" | "settings", expectEmail?: string }
// expectEmail comes from the box on the sign-up form: it only counts if it was ticked for this same account.
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
  if (typeof body?.subscribed !== "boolean") return NextResponse.json({ error: "Say yes or no." }, { status: 400 });
  if (!user.email) return NextResponse.json({ error: "Your account has no email address." }, { status: 400 });
  if (typeof body.expectEmail === "string" && body.expectEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "That choice was made for a different account.", mismatch: true }, { status: 409 });
  }
  // A yes only counts when the address is proven to be theirs (see emailIsProven). Saying no is always allowed.
  if (body.subscribed && !emailIsProven({ signupMode: SIGNUP_MODE, identities: user.identities })) {
    return NextResponse.json(
      { error: "Email updates switch on once sign-ups need a confirmed email address, so nobody can sign up someone else.", needsVerified: true },
      { status: 409 },
    );
  }
  if (!tokenSecret(process.env)) return NextResponse.json({ error: "Updates are not set up yet." }, { status: 503 });

  try {
    await setConsent({ userId: user.id, email: user.email, subscribed: body.subscribed, source: parseSource(body.source) });
  } catch {
    return NextResponse.json({ error: "Could not save your choice. Try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, subscribed: body.subscribed });
}
