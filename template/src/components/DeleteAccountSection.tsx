"use client";

import { useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import { SUPABASE_SCHEMA } from "@/lib/supabase/schema.mjs";

// In a project shared with other apps the login belongs to those apps too, so only this app's data is deleted.
const SHARED = SUPABASE_SCHEMA !== "public";

/** "Delete my account" in Settings. The person types DELETE; the server checks it again. */
export function DeleteAccountSection() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  async function deleteAccount() {
    setError("");
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (res.ok) {
        // Full page load, so the signed-out state is what the server shows.
        const data = await res.json().catch(() => ({}));
        window.location.replace(data.keptLogin ? "/?notice=account-data-deleted" : "/?notice=account-deleted");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "We could not delete your account. Try again in a minute.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
  }

  return (
    <section className="card card-pad space-y-4" aria-labelledby="delete-heading">
      <h2 id="delete-heading" className="m-0">Delete account</h2>
      <p className="m-0 muted">
        {SHARED
          ? "This removes everything you saved in this app. Your login stays, because other apps use it too. It cannot be undone."
          : "This removes your account and everything you saved. It cannot be undone."}
      </p>
      <div>
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
          Delete my account
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <ConfirmModal
        open={open}
        title="Delete your account?"
        message={
          SHARED
            ? "Everything you saved in this app will be removed for good. Your login stays, because other apps use it. You will be signed out."
            : "Your account and everything you saved will be removed for good. You will be signed out."
        }
        confirmLabel="Delete my account"
        danger
        requireText="DELETE"
        onConfirm={deleteAccount}
        onClose={() => setOpen(false)}
      />
    </section>
  );
}
