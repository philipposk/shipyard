// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// Sends emails through Resend. The network call is passed in (`fetchImpl`), so tests never reach the internet.
// Error messages never contain the key.

export const BATCH_SIZE = 100;
const API = "https://api.resend.com";

/** A short, safe description of a failed Resend answer. */
async function describeFailure(res) {
  let name = "";
  try {
    const body = await res.json();
    name = typeof body?.name === "string" ? body.name.replace(/[^\w ]/g, "").slice(0, 60) : "";
  } catch {
    // no JSON body
  }
  return `Resend ${res.status}${name ? ` (${name})` : ""}`;
}

const asMessage = (from, m) => ({
  from,
  to: [m.to],
  subject: m.subject,
  html: m.html,
  text: m.text,
  ...(m.headers ? { headers: m.headers } : {}),
});

/**
 * Sends one email. @param {{ apiKey: string, from: string, message: object, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendOne({ apiKey, from, message, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${API}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(asMessage(from, message)),
    });
    return res.ok ? { ok: true } : { ok: false, error: await describeFailure(res) };
  } catch {
    return { ok: false, error: "Could not reach Resend" };
  }
}

/**
 * Sends many emails, one per person, 100 at a time, waiting between requests to stay inside Resend's rate limit.
 * A request that is refused for being too fast is tried again twice. `idempotencyKey` makes a repeated request safe.
 * @param {{
 *   apiKey: string,
 *   from: string,
 *   messages: { to: string, subject: string, html: string, text?: string, headers?: Record<string, string> }[],
 *   idempotencyKey?: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   pauseMs?: number,
 * }} input
 * @returns {Promise<{ ok: boolean, sent: number, failed: number, errors: string[] }>}
 */
export async function sendBatches({ apiKey, from, messages, idempotencyKey, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 600 }) {
  let sent = 0;
  let failed = 0;
  const errors = [];
  for (let start = 0, index = 0; start < messages.length; start += BATCH_SIZE, index++) {
    const chunk = messages.slice(start, start + BATCH_SIZE);
    if (index > 0) await sleep(pauseMs);
    let outcome = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(`${API}/emails/batch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": `${idempotencyKey}-${index}` } : {}),
          },
          body: JSON.stringify(chunk.map((m) => asMessage(from, m))),
        });
        if (res.ok) {
          outcome = { ok: true };
          break;
        }
        if (res.status === 429 && attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        outcome = { ok: false, error: await describeFailure(res) };
        break;
      } catch {
        outcome = { ok: false, error: "Could not reach Resend" };
        break;
      }
    }
    if (outcome?.ok) sent += chunk.length;
    else {
      failed += chunk.length;
      const message = outcome?.error ?? "Resend did not answer";
      if (!errors.includes(message)) errors.push(message);
    }
  }
  return { ok: failed === 0, sent, failed, errors };
}
