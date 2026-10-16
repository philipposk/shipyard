"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { PasswordInput } from "@/components/PasswordInput";
import { BRAND } from "@/lib/constants";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/validate.mjs";

/**
 * Reached from a recovery email via /auth/confirm, which checked the one-time token and signed the
 * person in. The password changes only through that session; no session, no form.
 */
export default function ResetPasswordPage() {
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    createSupabaseBrowser()
      .auth.getUser()
      .then(({ data: { user } }) => setEmail(user?.email ?? null))
      .finally(() => setChecking(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const supabase = createSupabaseBrowser();
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) {
        setError(updateErr.message);
        return;
      }
      // Sign this account out on every other device; this browser stays signed in.
      await supabase.auth.signOut({ scope: "others" });
      setDone(true);
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <main id="main-content" className="flex flex-col items-center justify-center min-h-[100dvh] px-6">
        <p className="text-sm muted">Checking your reset link…</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="max-w-sm mx-auto px-6 py-12">
      <h1 className="page-title mb-2 text-center">{BRAND.name}</h1>

      {!email ? (
        <>
          <p className="text-sm text-center mb-6 muted">This reset link is invalid or has expired. Each link works once.</p>
          <Link href="/sign-in?mode=forgot" className="btn btn-primary w-full">Request a new link</Link>
        </>
      ) : done ? (
        <>
          <p className="text-sm text-center mb-6 muted">Password updated.</p>
          <Link href="/" className="btn btn-primary w-full">Continue</Link>
        </>
      ) : (
        <>
          <p className="text-sm text-center mb-6 muted">
            Set a new password for <strong>{email}</strong>
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="new-password" className="field-label">New password</label>
              <PasswordInput id="new-password" value={password} onChange={setPassword} placeholder="New password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
            </div>
            <div>
              <label htmlFor="confirm-password" className="field-label">Repeat new password</label>
              <PasswordInput id="confirm-password" value={confirm} onChange={setConfirm} placeholder="Repeat new password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-primary w-full" disabled={loading}>
              {loading ? "Please wait…" : "Save new password"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
