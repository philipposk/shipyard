import { PENDING_KEY, parsePending, serializePending } from "./intent.mjs";

// Browser-only helpers around intent.mjs. Every call is wrapped: private windows and blocked storage must never break sign-up.

export function savePendingOptIn(email: string): void {
  try {
    localStorage.setItem(PENDING_KEY, serializePending(email));
  } catch {
    // storage blocked: the tick is simply not remembered
  }
}

export function clearPendingOptIn(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

export function readPendingOptIn(): { email: string; at: number } | null {
  try {
    return parsePending(localStorage.getItem(PENDING_KEY));
  } catch {
    return null;
  }
}
