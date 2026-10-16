import { NextResponse } from "next/server";
import { BRAND, SITE_URL } from "@/lib/constants";
import { isSameOrigin } from "@/lib/same-origin.mjs";
import { getNewsletterAdmin } from "@/lib/newsletter/admin";
import { checkCompose, consentedRecipients, listUnsubscribeHeaders, tokenSecret, unsubscribeApiUrl, unsubscribePageUrl } from "@/lib/newsletter/core.mjs";
import { renderNewsletterEmail } from "@/lib/newsletter/email-render.mjs";
import { sendBatches, sendOne } from "@/lib/newsletter/send.mjs";
import { countConsented, listConsented, recentSends, recordSend, sentRecently, setSendRecipients, tokenForUser, tokensFor } from "@/lib/newsletter/store";

export const runtime = "nodejs";
// A real send walks the list 100 people at a time with a short pause between requests.
export const maxDuration = 60;

// Only an admin may use this. Everyone else gets "not found", so the address does not advertise itself.
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET() {
  if (!(await getNewsletterAdmin())) return notFound();
  return NextResponse.json({
    subscribers: await countConsented(),
    sends: await recentSends(),
    emailConfigured: Boolean(process.env.RESEND_API_KEY),
    senderConfigured: Boolean(process.env.RESEND_FROM),
  });
}

// Body: { subject, bodyMd, test?: boolean, confirmCount?: number }
// Without an explicit test:false this only ever emails the admin. A real send also needs confirmCount to match the
// number of subscribers right now, so a page left open can not email more people than it showed.
export async function POST(request: Request) {
  if (!isSameOrigin(request.headers, request.url, SITE_URL)) {
    return NextResponse.json({ error: "This request did not come from the app." }, { status: 403 });
  }
  const admin = await getNewsletterAdmin();
  if (!admin?.email) return notFound();

  const body = await request.json().catch(() => null);
  const composed = checkCompose({ subject: body?.subject, bodyMd: body?.bodyMd });
  if (!composed.ok) return NextResponse.json({ error: composed.error }, { status: 400 });
  const { subject, bodyMd } = composed;
  const test = body?.test !== false;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Email sending is not set up yet." }, { status: 503 });
  if (!tokenSecret(process.env)) return NextResponse.json({ error: "Unsubscribe links are not set up yet." }, { status: 503 });

  const settingsUrl = `${SITE_URL}/settings`;

  if (test) {
    const token = await tokenForUser(admin.id);
    const { html, text } = renderNewsletterEmail({ subject: `[Test] ${subject}`, bodyMd, unsubscribeUrl: unsubscribePageUrl(SITE_URL, token), brandName: BRAND.name, settingsUrl });
    const sent = await sendOne({
      apiKey,
      // The shared test sender only delivers to the account owner, which is fine for a test to yourself.
      from: process.env.RESEND_FROM || `${BRAND.name} <onboarding@resend.dev>`,
      message: { to: admin.email, subject: `[Test] ${subject}`, html, text, headers: token ? listUnsubscribeHeaders(unsubscribeApiUrl(SITE_URL, token)) : undefined },
    });
    if (!sent.ok) return NextResponse.json({ error: `Could not send the test (${sent.error}).` }, { status: 502 });
    await recordSend({ subject, bodyMd, sentBy: admin.id, test: true, recipients: 1 });
    return NextResponse.json({ ok: true, test: true, sent: 1, to: admin.email });
  }

  const from = process.env.RESEND_FROM;
  if (!from) {
    return NextResponse.json(
      { error: "No sender address is set. Verify your domain with the email setup in Shipyard first: the shared test sender can only email you." },
      { status: 400 },
    );
  }

  const recipients = consentedRecipients(await listConsented());
  if (recipients.length === 0) return NextResponse.json({ error: "Nobody has said yes to updates yet." }, { status: 400 });
  if (Number(body?.confirmCount) !== recipients.length) {
    return NextResponse.json({ error: `There are ${recipients.length} subscribers now. Check the number and confirm again.`, subscribers: recipients.length }, { status: 409 });
  }
  if (await sentRecently(subject)) {
    return NextResponse.json({ error: "This subject was sent less than 15 minutes ago. Change the subject if you really want to send it again." }, { status: 409 });
  }

  // Written down BEFORE sending: it is the record even if the server stops half way, and the check above sees it straight away.
  const sendId = await recordSend({ subject, bodyMd, sentBy: admin.id, test: false, recipients: 0 });
  const tokens = await tokensFor(recipients);
  const messages = recipients.map((r) => {
    const token = tokens.get(r.user_id) as string;
    const { html, text } = renderNewsletterEmail({ subject, bodyMd, unsubscribeUrl: unsubscribePageUrl(SITE_URL, token), brandName: BRAND.name, settingsUrl });
    return { to: r.email, subject, html, text, headers: listUnsubscribeHeaders(unsubscribeApiUrl(SITE_URL, token)) };
  });
  const result = await sendBatches({ apiKey, from, messages, idempotencyKey: `newsletter-${sendId}` });
  await setSendRecipients(sendId, result.sent);
  return NextResponse.json(
    { ok: result.ok, test: false, sent: result.sent, failed: result.failed, errors: result.errors.slice(0, 3) },
    { status: result.sent > 0 || result.ok ? 200 : 502 },
  );
}
