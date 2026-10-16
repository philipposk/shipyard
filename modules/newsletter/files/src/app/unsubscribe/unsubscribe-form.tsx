"use client";

import { useState } from "react";
import Link from "next/link";

export function UnsubscribeForm({ token, brandName }: { token: string; brandName: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "invalid" | "error">("idle");

  async function unsubscribe() {
    setState("busy");
    try {
      const res = await fetch(`/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      setState(res.ok ? "done" : res.status === 404 ? "invalid" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="space-y-3" role="status">
        <p className="m-0">You are unsubscribed. {brandName} will not send you update emails any more. Your account is not affected.</p>
        <p className="m-0 muted">
          Changed your mind? Switch updates back on in <Link href="/settings" className="link">Settings</Link>.
        </p>
      </div>
    );
  }
  if (state === "invalid") {
    return <p className="m-0 form-error" role="alert">This link did not work. Sign in and switch updates off in Settings instead.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="m-0 muted">You will not get any more update emails from {brandName}.</p>
      <button type="button" className="btn btn-primary" onClick={() => void unsubscribe()} disabled={state === "busy"}>
        {state === "busy" ? "One moment…" : "Unsubscribe"}
      </button>
      {state === "error" && <p className="form-error" role="alert">That did not work. Try again in a minute.</p>}
    </div>
  );
}
