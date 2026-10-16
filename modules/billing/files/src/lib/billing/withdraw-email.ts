import "server-only";

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

async function send(payload: Record<string, unknown>): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, ...payload }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Tells the person their withdrawal arrived (the written confirmation the law asks for) and tells the owner to refund.
 * Returns whether the person's email was sent. Needs the email setup (RESEND_API_KEY and RESEND_FROM); without it the
 * withdrawal still works and the page shows the confirmation on screen.
 */
export async function sendWithdrawalEmails(input: {
  to: string;
  appName: string;
  requestedAt: string;
  refundCents: number;
  currency: string;
  invoiceId: string;
}): Promise<boolean> {
  const owner = process.env.NEXT_PUBLIC_CONTACT_EMAIL || process.env.ADMIN_EMAIL || "";
  const when = new Date(input.requestedAt).toUTCString();
  const refund = money(input.refundCents, input.currency);
  const sentToPerson = input.to
    ? await send({
        to: [input.to],
        ...(owner ? { reply_to: owner } : {}),
        subject: `We received your withdrawal from ${input.appName}`,
        text: [
          `We received your withdrawal from ${input.appName} on ${when}.`,
          "Your plan has ended. You will get back what you paid, minus the days you already used, within 14 days.",
          `Expected refund: ${refund}.`,
          owner ? `Questions: write to ${owner}.` : "",
        ].filter(Boolean).join("\n\n"),
      })
    : false;
  if (owner) {
    await send({
      to: [owner],
      subject: `Withdrawal in ${input.appName}: refund ${refund}`,
      text: [
        `Someone withdrew from their plan in ${input.appName} on ${when}.`,
        `Refund due within 14 days: ${refund} (what they paid minus the days used). Invoice: ${input.invoiceId || "unknown"}.`,
        "Refund it in the Stripe dashboard: Payments, open the payment, Refund. Their plan is already cancelled.",
      ].join("\n\n"),
    });
  }
  return sentToPerson;
}
