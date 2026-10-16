"use client";

import { useEffect, useRef, useState } from "react";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the confirm button stays off until the person types this word (for example "DELETE"). */
  requireText?: string;
  /** Runs when the person confirms. May be async. Show your own error message if it fails. */
  onConfirm: () => void | Promise<void>;
  /** Called when the box should close: after confirm (success or not), Cancel, or Escape. */
  onClose: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  requireText,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const typedOk = !requireText || typed.trim().toUpperCase() === requireText.toUpperCase();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  async function handleConfirm() {
    if (!typedOk) return;
    setBusy(true);
    try {
      await onConfirm();
    } catch (error) {
      console.error("ConfirmModal: onConfirm failed", error);
    } finally {
      // Always close, so a failed action can never leave a dark overlay stuck on the screen.
      setBusy(false);
      setTyped("");
      onClose();
    }
  }

  if (!open) return null;

  const close = () => {
    setTyped("");
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="fixed inset-0 z-[70] m-auto w-[calc(100%-2rem)] max-w-sm rounded-[var(--radius)] border p-0 backdrop:bg-[var(--overlay)]"
      style={{ background: "var(--card)", color: "var(--foreground)", borderColor: "var(--line)" }}
      onClose={close}
      aria-labelledby="confirm-title"
    >
      <div className="card-pad">
        <h2 id="confirm-title" className="text-lg mb-2">{title}</h2>
        <p className={`text-sm muted ${requireText ? "mb-4" : "mb-5"}`}>{message}</p>
        {requireText ? (
          <div className="mb-5">
            <label htmlFor="confirm-typed" className="field-label">
              Type {requireText} to confirm
            </label>
            <input
              id="confirm-typed"
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </div>
        ) : null}
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => void handleConfirm()}
            disabled={busy || !typedOk}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
