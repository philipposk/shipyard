"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ConfirmModal } from "@/components/ConfirmModal";
import { BRAND } from "@/lib/constants";
import { renderNewsletterEmail } from "@/lib/newsletter/email-render.mjs";

interface SendRecord {
  id: string;
  subject: string;
  test: boolean;
  recipients: number;
  sent_at: string;
}

interface State {
  subscribers: number;
  sends: SendRecord[];
  emailConfigured: boolean;
  senderConfigured: boolean;
}

const DRAFT_KEY = "newsletter-draft";

const noSubscribe = () => () => {};
function readDraftText(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function parseDraft(text: string): { subject: string; bodyMd: string } {
  try {
    const draft = JSON.parse(text || "null");
    return { subject: String(draft?.subject ?? ""), bodyMd: String(draft?.bodyMd ?? "") };
  } catch {
    return { subject: "", bodyMd: "" };
  }
}

/** Write an update, see exactly what will be sent, send yourself a test, then send it to everyone who said yes. */
export function NewsletterComposer({ adminEmail }: { adminEmail: string }) {
  // The saved draft lives in this browser, so it can only be read after the page has loaded (null until then).
  const saved = useSyncExternalStore<string | null>(noSubscribe, readDraftText, () => null);
  if (saved === null) return <p className="m-0 muted">Loading…</p>;
  return <ComposerForm adminEmail={adminEmail} draft={parseDraft(saved)} />;
}

function ComposerForm({ adminEmail, draft }: { adminEmail: string; draft: { subject: string; bodyMd: string } }) {
  const [state, setState] = useState<State | null>(null);
  const [subject, setSubject] = useState(draft.subject);
  const [bodyMd, setBodyMd] = useState(draft.bodyMd);
  const [busy, setBusy] = useState<"" | "test" | "send">("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Keep an unsent draft in this browser: a long update lost to a closed tab is painful to write again.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ subject, bodyMd }));
      } catch {
        // storage blocked
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [subject, bodyMd]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/newsletter/admin")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setState(data);
      })
      .catch(() => {
        // the page still works without the numbers
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    try {
      const res = await fetch("/api/newsletter/admin");
      if (res.ok) setState(await res.json());
    } catch {
      // the page still works without the numbers
    }
  }

  // The same code the server uses, so the preview is the email. Links point nowhere here.
  const preview = useMemo(
    () => renderNewsletterEmail({ subject: subject || "(no subject)", bodyMd, unsubscribeUrl: "#", brandName: BRAND.name, settingsUrl: "#" }).html,
    [subject, bodyMd],
  );

  const count = state?.subscribers ?? 0;
  const people = `${count} ${count === 1 ? "person" : "people"}`;
  const ready = Boolean(subject.trim() && bodyMd.trim());

  async function post(extra: Record<string, unknown>) {
    const res = await fetch("/api/newsletter/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, bodyMd, ...extra }),
    });
    return { res, data: await res.json().catch(() => ({})) };
  }

  async function sendTest() {
    setMessage(null);
    setBusy("test");
    try {
      const { res, data } = await post({ test: true });
      if (!res.ok) throw new Error(data.error || "Could not send the test.");
      setMessage({ text: `Test sent to ${adminEmail}.`, error: false });
      void refresh();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Could not send the test.", error: true });
    }
    setBusy("");
  }

  async function sendToAll() {
    setMessage(null);
    setBusy("send");
    try {
      const { res, data } = await post({ test: false, confirmCount: count });
      if (res.status === 409 && typeof data.subscribers === "number") setState((s) => (s ? { ...s, subscribers: data.subscribers } : s));
      if (!res.ok) throw new Error(data.error || "Could not send.");
      setMessage({
        text: data.failed ? `Sent to ${data.sent}. ${data.failed} did not go through (${(data.errors || [])[0] || "see your email provider"}).` : `Sent to ${data.sent}.`,
        error: Boolean(data.failed),
      });
      // Clear the draft so the same update can not go out twice by accident. The list of sends keeps a copy.
      setSubject("");
      setBodyMd("");
      void refresh();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Could not send.", error: true });
    }
    setBusy("");
  }

  return (
    <div className="space-y-6">
      <p className="m-0 muted">{state ? `${people} said yes to updates.` : "Loading…"}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card card-pad space-y-4" aria-labelledby="compose-heading">
          <h2 id="compose-heading" className="m-0">Write</h2>
          <div>
            <label htmlFor="nl-subject" className="field-label">Subject</label>
            <input id="nl-subject" className="input" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <label htmlFor="nl-body" className="field-label">Message</label>
            <textarea id="nl-body" className="input" rows={14} value={bodyMd} onChange={(e) => setBodyMd(e.target.value)} />
            <p className="m-0 mt-2 text-sm muted"># Heading, **bold**, *italic*, [link](https://example.com), - list item</p>
          </div>
          {message && <p className={message.error ? "form-error" : "m-0"} role={message.error ? "alert" : "status"}>{message.text}</p>}
          {state && !state.emailConfigured && <p className="form-error" role="alert">Email sending is not set up yet.</p>}
          {state && state.emailConfigured && !state.senderConfigured && (
            <p className="m-0 muted">Sending to everyone is off until you verify your domain. You can still send yourself a test.</p>
          )}
          {state && state.senderConfigured && count === 0 && <p className="m-0 muted">Nobody has said yes to updates yet.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => void sendTest()} disabled={!ready || Boolean(busy) || !state?.emailConfigured}>
              {busy === "test" ? "Sending…" : "Send a test to me"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setConfirming(true)}
              disabled={!ready || Boolean(busy) || count === 0 || !state?.emailConfigured || !state?.senderConfigured}
            >
              {busy === "send" ? "Sending…" : `Send to ${people}`}
            </button>
          </div>
        </section>

        <section className="card card-pad space-y-4" aria-labelledby="preview-heading">
          <h2 id="preview-heading" className="m-0">Preview</h2>
          <iframe title="Email preview" sandbox="" srcDoc={preview} className="w-full border-0 rounded-[var(--radius-sm)]" style={{ height: 520 }} />
        </section>
      </div>

      <section className="card" aria-labelledby="sends-heading">
        <h2 id="sends-heading" className="card-pad m-0">Sent so far</h2>
        {state && state.sends.length === 0 ? (
          <p className="card-pad m-0 muted">Nothing sent yet.</p>
        ) : (
          state?.sends.map((send) => (
            <div key={send.id} className="list-row">
              <span className="grow break-words">{send.subject}{send.test ? " (test)" : ""}</span>
              <span className="muted shrink-0">{send.recipients} sent</span>
              <span className="muted shrink-0">{new Date(send.sent_at).toLocaleDateString("en-GB")}</span>
            </div>
          ))
        )}
      </section>

      <ConfirmModal
        open={confirming}
        title={`Send to ${people}?`}
        message={`"${subject.trim()}" goes out now to ${people} who said yes. This cannot be undone.`}
        confirmLabel={`Send to ${count}`}
        danger
        onConfirm={sendToAll}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
