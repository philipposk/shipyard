"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { PasswordInput } from "@/components/PasswordInput";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { BRAND, SIGNUP_MODE } from "@/lib/constants";
import { isEmailNotConfirmed } from "@/lib/auth/signup-mode.mjs";
import { safeNext } from "@/lib/safe-next.mjs";
import { MIN_PASSWORD_LENGTH } from "@/lib/validate.mjs";

type Mode = "signin" | "signup" | "forgot";

export default function SignInPage() {
  const searchParams = useSearchParams();
  const nextParam = searchParams.get("next");
  const next = safeNext(nextParam, "/");
  const [mode, setMode] = useState<Mode>(searchParams.get("mode") === "forgot" ? "forgot" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(
    searchParams.get("error") === "link_expired"
      ? "That reset link is invalid or has expired. Request a new one."
      : searchParams.get("error") === "confirm_failed"
        ? "That confirmation link did not work. It may have expired or been opened on another device. Sign in, and ask for a new link if asked."
        : searchParams.get("error") === "auth"
          ? "Sign-in did not work. Try again."
          : ""
  );
  // Verified sign-up: the person must open the link we emailed before they can sign in.
  const [confirmSent, setConfirmSent] = useState(false);
  const [offerResend, setOfferResend] = useState(false);
  const [resendNote, setResendNote] = useState("");
  const [resending, setResending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [loading, setLoading] = useState(false);

  function switchMode(m: Mode) {
    setMode(m);
    setError("");
    setResetSent(false);
    setConfirmSent(false);
    setOfferResend(false);
    setResendNote("");
  }

  async function resendConfirmation() {
    setResending(true);
    setResendNote("");
    try {
      const res = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      setResendNote(res.ok ? data.message || "We sent a new link." : data.error || "Could not send the link. Try again.");
    } catch {
      setResendNote("Could not reach the server. Check your connection and try again.");
    } finally {
      setResending(false);
    }
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (mode === "forgot") {
        const res = await fetch("/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) setResetSent(true);
        else setError(data.error || "Could not send a reset link.");
        return;
      }

      const supabase = createSupabaseBrowser();
      if (mode === "signup") {
        const reg = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const regData = await reg.json().catch(() => ({}));
        if (!reg.ok) {
          if (reg.status === 409) setMode("signin");
          setError(regData.error || "Sign-up did not work. Try again.");
          return;
        }
        if (regData.needsConfirmation) {
          setConfirmSent(true);
          return;
        }
        // The account exists and is confirmed, so sign straight in. The proxy sends new people to finish their profile.
        const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
        if (signInErr) setError(signInErr.message);
        else window.location.replace(next);
        return;
      }

      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) {
        if (isEmailNotConfirmed(signInErr)) {
          setError("Your email is not confirmed yet. Open the link we sent you, or ask for a new one.");
          setOfferResend(true);
        } else {
          setError(signInErr.message);
        }
        return;
      }
      // Full page load so the server sees the new login cookie.
      window.location.replace(next);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main id="main-content" className="max-w-sm mx-auto px-6 py-12">
      <h1 className="page-title mb-2 text-center">{BRAND.name}</h1>
      <p className="text-sm text-center mb-6 muted">
        {mode === "signin" ? BRAND.tagline : mode === "signup" ? "Create your account" : "Reset your password"}
      </p>

      {mode !== "forgot" && <GoogleSignInButton next={nextParam} />}

      {confirmSent ? (
        <div className="space-y-4 mt-6">
          <h2 className="text-lg m-0 text-center">Check your email</h2>
          <p className="text-sm text-center">
            We sent a link to <strong>{email}</strong>. Open it to finish creating your account. Check your spam folder too.
          </p>
          <button type="button" className="btn btn-secondary w-full" onClick={() => void resendConfirmation()} disabled={resending}>
            {resending ? "Please wait…" : "Send the link again"}
          </button>
          {resendNote && <p className="text-sm text-center muted" role="status">{resendNote}</p>}
          <button type="button" className="btn btn-ghost w-full" onClick={() => switchMode("signin")}>
            Back to sign in
          </button>
        </div>
      ) : resetSent ? (
        <div className="space-y-4 mt-6">
          <p className="text-sm text-center">
            If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your spam folder too.
          </p>
          <button type="button" className="btn btn-secondary w-full" onClick={() => switchMode("signin")}>
            Back to sign in
          </button>
        </div>
      ) : (
        <form onSubmit={handleEmail} className="space-y-4 mt-6">
          <div>
            <label htmlFor="email" className="field-label">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input"
            />
          </div>
          {mode !== "forgot" && (
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="field-label">Password</label>
                {mode === "signin" && (
                  <button type="button" className="link text-sm" onClick={() => switchMode("forgot")}>
                    Forgot password?
                  </button>
                )}
              </div>
              <PasswordInput
                id="password"
                value={password}
                onChange={setPassword}
                required
                minLength={mode === "signup" ? MIN_PASSWORD_LENGTH : undefined}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </div>
          )}
          {mode === "signup" && SIGNUP_MODE === "verified" && (
            <p className="text-sm muted m-0">We will email you a link to confirm your address.</p>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          {offerResend && mode === "signin" && (
            <div className="space-y-2">
              <button type="button" className="btn btn-secondary w-full" onClick={() => void resendConfirmation()} disabled={resending}>
                {resending ? "Please wait…" : "Send a new confirmation link"}
              </button>
              {resendNote && <p className="text-sm muted m-0" role="status">{resendNote}</p>}
            </div>
          )}
          <button type="submit" className="btn btn-primary w-full" disabled={loading}>
            {loading ? "Please wait…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Sign up" : "Send reset link"}
          </button>
        </form>
      )}

      <p className="text-sm text-center mt-6 muted">
        {mode === "signin" ? (
          <>No account? <button type="button" className="link" onClick={() => switchMode("signup")}>Sign up</button></>
        ) : mode === "signup" ? (
          <>Have an account? <button type="button" className="link" onClick={() => switchMode("signin")}>Sign in</button></>
        ) : (
          <>Remembered it? <button type="button" className="link" onClick={() => switchMode("signin")}>Sign in</button></>
        )}
      </p>
      <p className="text-xs text-center mt-4 muted">
        <Link href="/" className="link">Back to home</Link>
      </p>
    </main>
  );
}
