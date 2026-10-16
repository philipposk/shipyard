import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePending, serializePending, PENDING_MAX_AGE_MS } from "../src/lib/newsletter/intent.mjs";

const NOW = Date.parse("2027-03-01T12:00:00Z");

test("a saved tick comes back with the email it was ticked for", () => {
  const raw = serializePending("  Sam@Example.COM ", NOW);
  assert.deepEqual(parsePending(raw, NOW + 1000), { email: "sam@example.com", at: NOW });
});

test("a tick expires after 30 days", () => {
  const raw = serializePending("sam@example.com", NOW);
  assert.ok(parsePending(raw, NOW + PENDING_MAX_AGE_MS - 1000));
  assert.equal(parsePending(raw, NOW + PENDING_MAX_AGE_MS + 1000), null);
});

test("broken or odd stored text gives nothing", () => {
  for (const bad of [null, undefined, "", "not json", "{}", "[]", '{"email":5,"at":1}', '{"email":"nope","at":1}', '{"email":"a@b.co"}']) {
    assert.equal(parsePending(bad, NOW), null, String(bad));
  }
  // A time far in the future is not trusted.
  assert.equal(parsePending(serializePending("a@b.co", NOW + 10 * 86400000), NOW), null);
});
