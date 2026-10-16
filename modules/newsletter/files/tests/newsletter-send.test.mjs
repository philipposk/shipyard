import { test } from "node:test";
import assert from "node:assert/strict";
import { sendBatches, sendOne, BATCH_SIZE } from "../src/lib/newsletter/send.mjs";

// Put together here so no real-looking key sits in the file (the key-leak scan would complain).
const KEY = ["re", "thiskeyshouldneverappearanywhere"].join("_");
const msg = (i) => ({ to: `user${i}@example.com`, subject: "Hi", html: "<p>x</p>", text: "x", headers: { "List-Unsubscribe": `<https://e.co/u?token=${i}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
const many = (n) => Array.from({ length: n }, (_, i) => msg(i));
const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeFetch(statuses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (next instanceof Error) throw next;
    return reply(next, next >= 400 ? { name: "validation_error", message: `bad ${KEY}` } : { data: [] });
  };
  fn.calls = calls;
  return fn;
}

test("sends one email per person, 100 per request, with the unsubscribe headers on each", async () => {
  const fetchImpl = fakeFetch([200]);
  const sleeps = [];
  const result = await sendBatches({ apiKey: KEY, from: "Shop <hi@shop.example.com>", messages: many(250), idempotencyKey: "newsletter-9", fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(result, { ok: true, sent: 250, failed: 0, errors: [] });
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.length), [BATCH_SIZE, BATCH_SIZE, 50]);
  assert.equal(fetchImpl.calls[0].url, "https://api.resend.com/emails/batch");
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(fetchImpl.calls.map((c) => c.init.headers["Idempotency-Key"]), ["newsletter-9-0", "newsletter-9-1", "newsletter-9-2"]);
  const first = fetchImpl.calls[0].body[0];
  assert.deepEqual(first.to, ["user0@example.com"]);
  assert.equal(first.from, "Shop <hi@shop.example.com>");
  assert.equal(first.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(sleeps.length, 2, "waits between requests, not before the first");
});

test("every recipient is alone in the To field", async () => {
  const fetchImpl = fakeFetch([200]);
  await sendBatches({ apiKey: KEY, from: "a@b.co", messages: many(5), fetchImpl, sleep: async () => {} });
  for (const m of fetchImpl.calls[0].body) assert.equal(m.to.length, 1);
});

test("a refused request counts its people as failed and sending goes on; the key never shows", async () => {
  const fetchImpl = fakeFetch([200, 422, 200]);
  const result = await sendBatches({ apiKey: KEY, from: "a@b.co", messages: many(250), fetchImpl, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 150);
  assert.equal(result.failed, 100);
  assert.deepEqual(result.errors, ["Resend 422 (validation_error)"]);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test("a too-fast answer (429) is tried again, then given up on", async () => {
  const again = fakeFetch([429, 200]);
  const ok = await sendBatches({ apiKey: KEY, from: "a@b.co", messages: many(3), fetchImpl: again, sleep: async () => {} });
  assert.equal(ok.sent, 3);
  assert.equal(again.calls.length, 2);
  const never = fakeFetch([429]);
  const failed = await sendBatches({ apiKey: KEY, from: "a@b.co", messages: many(3), fetchImpl: never, sleep: async () => {} });
  assert.equal(failed.failed, 3);
  assert.equal(never.calls.length, 3);
});

test("a network failure is reported without details", async () => {
  const result = await sendBatches({ apiKey: KEY, from: "a@b.co", messages: many(2), fetchImpl: fakeFetch([new Error(`connect failed for ${KEY}`)]), sleep: async () => {} });
  assert.equal(result.failed, 2);
  assert.deepEqual(result.errors, ["Could not reach Resend"]);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test("nothing to send is a quiet success with no request", async () => {
  const fetchImpl = fakeFetch([200]);
  assert.deepEqual(await sendBatches({ apiKey: KEY, from: "a@b.co", messages: [], fetchImpl }), { ok: true, sent: 0, failed: 0, errors: [] });
  assert.equal(fetchImpl.calls.length, 0);
});

test("sendOne sends a single email and reports a safe error", async () => {
  const ok = fakeFetch([200]);
  assert.deepEqual(await sendOne({ apiKey: KEY, from: "a@b.co", message: msg(1), fetchImpl: ok }), { ok: true });
  assert.equal(ok.calls[0].url, "https://api.resend.com/emails");
  assert.deepEqual(ok.calls[0].body.to, ["user1@example.com"]);
  const bad = await sendOne({ apiKey: KEY, from: "a@b.co", message: msg(1), fetchImpl: fakeFetch([403]) });
  assert.equal(bad.ok, false);
  assert.ok(!bad.error.includes(KEY));
  const down = await sendOne({ apiKey: KEY, from: "a@b.co", message: msg(1), fetchImpl: fakeFetch([new Error("x")]) });
  assert.equal(down.error, "Could not reach Resend");
});
