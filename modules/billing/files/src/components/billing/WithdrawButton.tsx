"use client";

import { useState } from "react";

/** "Withdraw from contract here": ends the plan at once, inside the first 14 days, and asks for the unused share back. */
export function WithdrawButton() {
  const [step, setStep] = useState<"idle" | "ask" | "busy" | "done">("idle");
  const [emailed, setEmailed] = useState(false);
  const [error, setError] = useState("");

  async function withdraw() {
    setStep("busy");
    setError("");
    try {
      const res = await fetch("/api/billing/withdraw", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setEmailed(Boolean(data.emailed));
        setStep("done");
        return;
      }
      setError(data.error || "Could not process the withdrawal. Try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setStep("ask");
  }

  if (step === "done") {
    return (
      <p role="status" className="m-0">
        Your withdrawal is received and your plan has ended. You get back what you paid, minus the days you used, within 14 days.
        {emailed ? " We sent you an email as confirmation." : " Keep this message as your confirmation."}
      </p>
    );
  }

  if (step === "idle") {
    return (
      <button type="button" className="btn btn-secondary" onClick={() => setStep("ask")}>
        Withdraw from contract
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <p className="m-0">
        This ends your plan now. You pay only for the days you used and get the rest back. This cannot be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => void withdraw()} disabled={step === "busy"}>
          {step === "busy" ? "One moment…" : "Yes, withdraw from contract"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setStep("idle")} disabled={step === "busy"}>
          Keep my plan
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
