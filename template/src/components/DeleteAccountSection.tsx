"use client";

import { useState } from "react";
import { ConfirmModal } from "./ConfirmModal";

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
        window.location.replace("/?notice=account-deleted");
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
      <p className="m-0 muted">This removes your account and everything you saved. It cannot be undone.</p>
      <div>
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
          Delete my account
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <ConfirmModal
        open={open}
        title="Delete your account?"
        message="Your account and everything you saved will be removed for good. You will be signed out."
        confirmLabel="Delete my account"
        danger
        requireText="DELETE"
        onConfirm={deleteAccount}
        onClose={() => setOpen(false)}
      />
    </section>
  );
}
