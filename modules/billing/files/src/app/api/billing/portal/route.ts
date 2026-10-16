import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { SITE_URL } from "@/lib/constants";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { billingEnabled, getStripe } from "@/lib/billing/stripe";
import { ownCustomerId } from "@/lib/billing/customers";

export const runtime = "nodejs";

/** Opens Stripe's customer portal (cancel, change card, invoices) for the signed-in person. */
export async function POST(request: Request) {
  if (!billingEnabled()) return NextResponse.json({ error: "Payments are not switched on yet." }, { status: 503 });
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.json({ error: "This request did not come from the app." }, { status: 403 });
  }

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const customer = await ownCustomerId();
  if (!customer) return NextResponse.json({ error: "There is nothing to manage yet. Pick a plan first." }, { status: 400 });

  try {
    const configuration = process.env.STRIPE_PORTAL_CONFIGURATION || undefined;
    const session = await getStripe().billingPortal.sessions.create({
      customer,
      return_url: `${SITE_URL}/settings/billing`,
      ...(configuration ? { configuration } : {}),
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("[billing] portal failed:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Could not open billing. Try again in a minute." }, { status: 502 });
  }
}
