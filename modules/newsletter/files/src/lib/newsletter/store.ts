import "server-only";
import { createSupabaseAdmin } from "@/lib/admin";
import { consentNotBefore, consentedRecipients, hashToken, tokenSecret, unsubscribeTokenFor } from "./core.mjs";

// The only file that writes the email list. It uses the secret server key: people change their own subscription
// through /api/newsletter, which first checks who is signed in and only ever touches that person's row.

export interface Recipient {
  user_id: string;
  email: string;
  status: string;
  consent_at: string | null;
  unsubscribe_token_hash: string;
}

export interface SendRecord {
  id: string;
  subject: string;
  test: boolean;
  recipients: number;
  sent_at: string;
}

const secretOrThrow = () => {
  const found = tokenSecret(process.env);
  if (!found) throw new Error("Newsletter secret is missing");
  return found.secret;
};

/** Saves a yes or no from one person. A yes keeps the first consent time if they had already said yes. */
export async function setConsent(input: { userId: string; email: string; subscribed: boolean; source: string }): Promise<void> {
  const db = createSupabaseAdmin();
  const now = new Date().toISOString();
  const { data: existing, error: readError } = await db
    .from("newsletter_subscribers")
    .select("status, consent_at, consent_source")
    .eq("user_id", input.userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const token = unsubscribeTokenFor(secretOrThrow(), input.userId);
  const keepConsent = input.subscribed && existing?.status === "subscribed" && existing.consent_at;
  const row = {
    user_id: input.userId,
    email: input.email,
    status: input.subscribed ? "subscribed" : "unsubscribed",
    consent_at: input.subscribed ? (keepConsent ? existing.consent_at : now) : (existing?.consent_at ?? null),
    consent_source: input.subscribed ? (keepConsent ? existing.consent_source : input.source) : (existing?.consent_source ?? null),
    unsubscribed_at: input.subscribed ? null : now,
    unsubscribe_token_hash: hashToken(token),
    updated_at: now,
  };
  const { error } = await db.from("newsletter_subscribers").upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}

/** "done" also for someone who already unsubscribed: clicking the link twice is not an error. */
export async function unsubscribeByToken(token: string): Promise<"done" | "invalid"> {
  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from("newsletter_subscribers")
    .select("user_id, status")
    .eq("unsubscribe_token_hash", hashToken(token))
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return "invalid";
  if (data.status === "subscribed") {
    const now = new Date().toISOString();
    const { error: updateError } = await db
      .from("newsletter_subscribers")
      .update({ status: "unsubscribed", unsubscribed_at: now, updated_at: now })
      .eq("user_id", data.user_id);
    if (updateError) throw new Error(updateError.message);
  }
  return "done";
}

/** Everyone who said yes, in pages (one request returns at most 1000 rows). */
export async function listConsented(): Promise<Recipient[]> {
  const db = createSupabaseAdmin();
  const all: Recipient[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("newsletter_subscribers")
      .select("user_id, email, status, consent_at, unsubscribe_token_hash")
      .eq("status", "subscribed")
      .not("consent_at", "is", null)
      .order("user_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as Recipient[]));
    if (!data || data.length < PAGE) break;
  }
  // Checked again in code: nobody who did not say yes is ever returned.
  return consentedRecipients(all, consentNotBefore(process.env)) as Recipient[];
}

export async function countConsented(): Promise<number> {
  return (await listConsented()).length;
}

/**
 * The unsubscribe token for each recipient. If the secret changed since someone signed up, their stored fingerprint
 * is renewed so the link in this email works.
 */
export async function tokensFor(recipients: Recipient[]): Promise<Map<string, string>> {
  const db = createSupabaseAdmin();
  const secret = secretOrThrow();
  const tokens = new Map<string, string>();
  for (const r of recipients) {
    const token = unsubscribeTokenFor(secret, r.user_id);
    tokens.set(r.user_id, token);
    const hash = hashToken(token);
    if (r.unsubscribe_token_hash !== hash) {
      await db.from("newsletter_subscribers").update({ unsubscribe_token_hash: hash }).eq("user_id", r.user_id);
    }
  }
  return tokens;
}

/** One person's own subscription as the admin sees it (used for the test email's footer). */
export async function tokenForUser(userId: string): Promise<string | null> {
  const db = createSupabaseAdmin();
  const { data } = await db.from("newsletter_subscribers").select("status").eq("user_id", userId).maybeSingle();
  return data?.status === "subscribed" ? unsubscribeTokenFor(secretOrThrow(), userId) : null;
}

export async function recordSend(input: { subject: string; bodyMd: string; sentBy: string; test: boolean; recipients: number }): Promise<string> {
  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from("newsletter_sends")
    .insert({ subject: input.subject, body_md: input.bodyMd, sent_by: input.sentBy, test: input.test, recipients: input.recipients })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not record the send");
  return data.id as string;
}

export async function setSendRecipients(id: string, recipients: number): Promise<void> {
  const db = createSupabaseAdmin();
  await db.from("newsletter_sends").update({ recipients }).eq("id", id);
}

export async function recentSends(limit = 10): Promise<SendRecord[]> {
  const db = createSupabaseAdmin();
  const { data } = await db.from("newsletter_sends").select("id, subject, test, recipients, sent_at").order("sent_at", { ascending: false }).limit(limit);
  return (data ?? []) as SendRecord[];
}

/** Was this subject already sent for real in the last few minutes? (double click, retried request) */
export async function sentRecently(subject: string, minutes = 15): Promise<boolean> {
  const db = createSupabaseAdmin();
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data } = await db.from("newsletter_sends").select("id").eq("test", false).eq("subject", subject).gte("sent_at", since).limit(1);
  return Boolean(data?.length);
}
