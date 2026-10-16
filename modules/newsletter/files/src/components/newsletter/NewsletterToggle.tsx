"use client";

import { useState } from "react";

/** The "email me updates" box in Settings. Unticked until the person ticks it; saves as soon as it changes. */
export function NewsletterToggle({ initial }: { initial: boolean }) {
  const [subscribed, setSubscribed] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function change(next: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscribed: next, source: "settings" }),
      });
      if (res.ok) setSubscribed(next);
      else setError((await res.json().catch(() => ({}))).error || "Could not save your choice. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0"
          checked={subscribed}
          disabled={busy}
          onChange={(e) => void change(e.target.checked)}
        />
        <span>Email me product updates</span>
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
