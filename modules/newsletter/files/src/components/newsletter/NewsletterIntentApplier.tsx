"use client";

import { useEffect } from "react";
import { clearPendingOptIn, readPendingOptIn } from "@/lib/newsletter/intent";

/**
 * Applies the "email me updates" tick from the sign-up form, once, the first time the person is signed in.
 * Renders nothing. Without a saved tick it does nothing at all.
 */
export function NewsletterIntentApplier() {
  useEffect(() => {
    const pending = readPendingOptIn();
    if (!pending) return;
    fetch("/api/newsletter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed: true, source: "signup", expectEmail: pending.email }),
    })
      .then((res) => {
        // Not signed in yet or a server hiccup: keep the tick and try again on a later page.
        if (res.status === 401 || res.status >= 500) return;
        // Saved, or the tick was for another account: either way it is settled.
        clearPendingOptIn();
      })
      .catch(() => {
        // offline: keep it for next time
      });
  }, []);
  return null;
}
