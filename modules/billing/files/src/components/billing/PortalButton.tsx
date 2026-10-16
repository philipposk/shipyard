"use client";

import { useState } from "react";

/** Opens the page where a customer can cancel, change their card and see invoices. */
export function PortalButton({ label = "Manage billing" }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string") {
        window.location.assign(data.url);
        return;
      }
      setError(data.error || "Could not open billing. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-secondary" onClick={() => void open()} disabled={busy}>
        {busy ? "One moment…" : label}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
