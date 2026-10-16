import { stripeKeyMode } from "@/lib/billing/stripe";
import { getIsAdmin } from "@/lib/session";

/** Shown to the owner only, and only while the Stripe key is a test key. Visitors never see it. */
export async function TestModeBanner() {
  if (stripeKeyMode() !== "test") return null;
  if (!(await getIsAdmin())) return null;
  return (
    <div className="card card-pad" role="status">
      <p className="m-0 text-sm">
        <strong>Test mode.</strong> Nobody is charged. To try a payment, use the card 4242 4242 4242 4242 with any date in the future and any 3 digits.
      </p>
    </div>
  );
}
