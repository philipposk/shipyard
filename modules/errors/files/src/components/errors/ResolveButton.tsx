"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "Mark resolved" on one problem in the error log. */
export function ResolveButton({ fingerprint }: { fingerprint: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function resolve() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/errors/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Could not mark it. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-secondary" onClick={() => void resolve()} disabled={busy}>
        {busy ? "One moment…" : "Mark resolved"}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
