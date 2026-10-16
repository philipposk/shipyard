import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { BRAND, SITE_URL } from "@/lib/constants";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { billingEnabled, getStripe } from "@/lib/billing/stripe";
import { planById } from "@/lib/billing/plans";
import { getOrCreateCustomer } from "@/lib/billing/customers";
import { getPlan, isPaidPlan } from "@/lib/billing/entitlement";
import { checkoutIdempotencyKey, hasLiveSubscription, isMissingTermsUrlError, termsConsent } from "@/lib/billing/checkout-core.mjs";

export const runtime = "nodejs";

/**
 * Starts a Stripe Checkout for one paid plan. Only a signed-in person, only from this site's own pages.
 * The price is found by the plan's lookupKey, so changing a price in Stripe needs no code change.
 */
export async function POST(request: Request) {
  if (!billingEnabled()) return NextResponse.json({ error: "Payments are not switched on yet." }, { status: 503 });
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.json({ error: "This request did not come from the app." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const plan = planById(body?.planId);
  if (!plan || plan.priceCents === 0 || !plan.lookupKey) return NextResponse.json({ error: "Pick one of the paid plans." }, { status: 400 });

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Never start a second subscription for someone who already pays: they change plan in the customer portal.
  if (isPaidPlan(await getPlan(user.id))) {
    return NextResponse.json({ error: "You already have a paid plan. Use Manage billing to change it.", portal: true }, { status: 409 });
  }

  try {
    const stripe = getStripe();
    const prices = await stripe.prices.list({ lookup_keys: [plan.lookupKey], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) return NextResponse.json({ error: "This plan is not ready to buy yet." }, { status: 503 });

    const customer = await getOrCreateCustomer(stripe, user);

    // The app's own copy of the subscription is only updated when Stripe's message arrives, which can be seconds late.
    // Ask Stripe itself, so a second click or a second tab can not start a second paying subscription.
    const existing = await stripe.subscriptions.list({ customer, status: "all", limit: 10 });
    if (hasLiveSubscription(existing.data)) {
      return NextResponse.json({ error: "You already have a paid plan. Use Manage billing to change it.", portal: true }, { status: 409 });
    }

    const metadata = { user_id: user.id, plan_id: plan.id, shipyard_app: BRAND.slug };
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        line_items: [{ price: price.id, quantity: 1 }],
        client_reference_id: user.id,
        metadata,
        subscription_data: { metadata },
        allow_promotion_codes: false,
        // The tick box "I agree to the Terms and ask for the service to start now". The terms promise a refund minus
        // the days used only because the buyer ticks this before paying.
        ...termsConsent(SITE_URL),
        success_url: `${SITE_URL}/settings/billing?checkout=success`,
        cancel_url: `${SITE_URL}/pricing`,
      },
      { idempotencyKey: checkoutIdempotencyKey(user.id, plan.id) },
    );
    if (!session.url) throw new Error("no url");
    return NextResponse.json({ url: session.url });
  } catch (error) {
    if (isMissingTermsUrlError(error)) {
      console.error("[billing] checkout failed: the terms address is not saved in the Stripe dashboard");
      return NextResponse.json({ error: "Payments are almost ready. The owner still has to add the Terms link in Stripe (Settings, Business, Public details)." }, { status: 503 });
    }
    console.error("[billing] checkout failed:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Could not start the payment. Try again in a minute." }, { status: 502 });
  }
}
