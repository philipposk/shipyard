import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getIsAdmin, getSessionUser } from "@/lib/session";
import { SIGNUP_MODE } from "@/lib/constants";
import { emailIsProven } from "@/lib/newsletter/core.mjs";
import { NewsletterToggle } from "./NewsletterToggle";

/** The "Email updates" part of the Settings page: the opt-in box, and for the owner a link to write an update. */
export async function NewsletterSettings() {
  const user = await getSessionUser();
  if (!user) return null;
  const supabase = await createSupabaseServer();
  const { data } = await supabase.from("newsletter_subscribers").select("status").eq("user_id", user.id).maybeSingle();
  const admin = await getIsAdmin();
  const subscribed = data?.status === "subscribed";
  const canSubscribe = emailIsProven({ signupMode: SIGNUP_MODE, identities: user.identities });

  return (
    <section className="card card-pad space-y-4" aria-labelledby="newsletter-heading">
      <h2 id="newsletter-heading" className="m-0">Email updates</h2>
      {canSubscribe || subscribed ? (
        <NewsletterToggle initial={subscribed} />
      ) : (
        <p className="m-0 muted">Email updates are not open yet. They start once sign-ups need a confirmed email address.</p>
      )}
      {admin && (
        <Link href="/admin/newsletter" className="btn btn-secondary">
          Send an update
        </Link>
      )}
    </section>
  );
}
