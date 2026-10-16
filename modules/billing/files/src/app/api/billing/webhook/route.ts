import { NextResponse } from "next/server";
import { BRAND } from "@/lib/constants";
import { billingEnabled, getStripe } from "@/lib/billing/stripe";
import { supabaseBillingStore } from "@/lib/billing/store";
import { PLANS } from "@/lib/billing/plans";
import { handleStripeWebhook } from "@/lib/billing/webhook.mjs";

export const runtime = "nodejs";

/**
 * Stripe calls this when a payment or subscription changes. It has no login cookie, so src/proxy.ts lets it through;
 * the Stripe signature is what proves the message is real. The logic is in src/lib/billing/webhook.mjs (with tests).
 */
export async function POST(request: Request) {
  if (!billingEnabled()) return NextResponse.json({ error: "Payments are not set up." }, { status: 503 });
  const rawBody = await request.text();
  const result = await handleStripeWebhook({
    rawBody,
    signature: request.headers.get("stripe-signature"),
    secret: process.env.STRIPE_WEBHOOK_SECRET,
    stripe: getStripe(),
    store: supabaseBillingStore(),
    plans: PLANS,
    appSlug: BRAND.slug,
  });
  return NextResponse.json(result.body, { status: result.status });
}
