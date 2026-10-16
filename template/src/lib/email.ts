import "server-only";
import { BRAND } from "@/lib/constants";

/** Sends one email through Resend. Without RESEND_API_KEY it does nothing and says `disabled`. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<{ ok: boolean; disabled?: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, disabled: true };
  // onboarding@resend.dev only delivers to the Resend account owner; set RESEND_FROM once you verify a domain.
  const from = process.env.RESEND_FROM || `${BRAND.name} <onboarding@resend.dev>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text }),
    });
    if (!r.ok) return { ok: false, error: `Resend ${r.status}` };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}
