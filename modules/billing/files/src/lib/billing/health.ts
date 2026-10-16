import "server-only";
import { SITE_URL } from "@/lib/constants";
import { billingEnabled, getStripe } from "./stripe";
import { PLANS } from "./plans";
import { paidPlans } from "./plans-core.mjs";
import { terms } from "@/lib/legal-content";
import { keyModeResult, pricesResult, webhookResult, portalResult, termsResult } from "./health-core.mjs";

type Result = { status: "ok" | "warn" | "fail" | "skip"; detail: string; fix?: string };

// Stripe answers are cut off after 4 seconds, inside the Health page's own 5 second limit.
const STRIPE_OPTIONS = { timeout: 4000, maxNetworkRetries: 0 };

/** Asks Stripe something. If Stripe can not be reached the check fails with a plain sentence, never a key. */
async function withStripe(ask: (stripe: ReturnType<typeof getStripe>) => Promise<Result>): Promise<Result> {
  if (!billingEnabled()) return { status: "skip", detail: "Payments are not set up yet." };
  try {
    return await ask(getStripe());
  } catch {
    return { status: "fail", detail: "Could not ask Stripe.", fix: "Check that the Stripe key is still valid, then check again." };
  }
}

/** Added to HEALTH_CHECKS (src/lib/health/checks.ts) when the billing module is added. */
export const billingHealthChecks = [
  {
    id: "billing-keys",
    label: "Payments: Stripe key",
    run: async (): Promise<Result> => keyModeResult(process.env.STRIPE_SECRET_KEY),
  },
  {
    id: "billing-prices",
    label: "Payments: prices exist",
    run: (): Promise<Result> =>
      withStripe(async (stripe) => {
        const keys = paidPlans(PLANS).map((p) => p.lookupKey as string);
        const found = new Set<string>();
        for (let i = 0; i < keys.length; i += 10) {
          const page = await stripe.prices.list({ lookup_keys: keys.slice(i, i + 10), active: true, limit: 100 }, STRIPE_OPTIONS);
          for (const price of page.data) if (price.lookup_key) found.add(price.lookup_key);
        }
        return pricesResult(PLANS, found);
      }),
  },
  {
    id: "billing-webhook",
    label: "Payments: Stripe can reach this site",
    run: (): Promise<Result> =>
      withStripe(async (stripe) => {
        const list = await stripe.webhookEndpoints.list({ limit: 100 }, STRIPE_OPTIONS);
        return webhookResult(list.data, `${SITE_URL}/api/billing/webhook`, Boolean(process.env.STRIPE_WEBHOOK_SECRET));
      }),
  },
  {
    id: "billing-terms",
    label: "Payments: terms and privacy policy",
    run: async (): Promise<Result> => termsResult(terms),
  },
  {
    id: "billing-portal",
    label: "Payments: customer portal",
    run: (): Promise<Result> =>
      withStripe(async (stripe) => {
        const list = await stripe.billingPortal.configurations.list({ active: true, limit: 1 }, STRIPE_OPTIONS);
        return portalResult(list.data);
      }),
  },
];
