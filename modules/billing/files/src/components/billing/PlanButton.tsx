"use client";

import { useState } from "react";

/** Starts the payment for one paid plan: asks the server for a Stripe Checkout address, then goes there. */
export function PlanButton({ planId, label }: { planId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string") {
        window.location.assign(data.url);
        return;
      }
      setError(data.error || "Could not start the payment. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-primary w-full" onClick={() => void start()} disabled={busy}>
        {busy ? "One moment…" : label}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
