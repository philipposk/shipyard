import { test } from "node:test";
import assert from "node:assert/strict";
import { keyModeResult, pricesResult, webhookResult, portalResult, termsResult } from "../src/lib/billing/health-core.mjs";
import { HANDLED_EVENT_TYPES } from "../src/lib/billing/webhook.mjs";

// Fake keys are put together here so no real-looking key sits in the file (the key-leak scan would complain).
const fakeKey = (prefix) => `${prefix}${"x".repeat(26)}`;

const plans = [
  { id: "free", name: "Free", priceCents: 0 },
  { id: "pro", name: "Pro", priceCents: 900, lookupKey: "app_pro_monthly" },
  { id: "team", name: "Team", priceCents: 2900, lookupKey: "app_team_monthly" },
];

test("key mode: skip without a key, warn in test mode, ok when live, fail on nonsense", () => {
  assert.equal(keyModeResult(undefined).status, "skip");
  assert.equal(keyModeResult("").status, "skip");
  assert.equal(keyModeResult(fakeKey("sk_test_")).status, "warn");
  assert.equal(keyModeResult(fakeKey("rk_live_")).status, "ok");
  assert.equal(keyModeResult(fakeKey("pk_live_")).status, "fail");
});

test("key mode details never contain the key", () => {
  for (const key of [fakeKey("sk_test_"), fakeKey("sk_live_"), fakeKey("garbage-")]) {
    const { detail, fix = "" } = keyModeResult(key);
    assert.ok(!detail.includes("xxxxxxxx") && !fix.includes("xxxxxxxx"));
  }
});

test("prices: ok when every paid plan has an active price, fail naming the missing plans", () => {
  assert.equal(pricesResult(plans, ["app_pro_monthly", "app_team_monthly"]).status, "ok");
  const r = pricesResult(plans, new Set(["app_pro_monthly"]));
  assert.equal(r.status, "fail");
  assert.match(r.detail, /Team/);
  assert.doesNotMatch(r.detail, /Pro,/);
  assert.equal(pricesResult([plans[0]], []).status, "skip");
});

test("webhook: needs the endpoint, enabled, every event, and the secret", () => {
  const url = "https://shop.example.com/api/billing/webhook";
  const endpoint = { url, status: "enabled", enabled_events: [...HANDLED_EVENT_TYPES] };
  assert.equal(webhookResult([endpoint], url, true).status, "ok");
  assert.equal(webhookResult([{ ...endpoint, enabled_events: ["*"] }], url, true).status, "ok");
  assert.equal(webhookResult([], url, true).status, "fail");
  assert.equal(webhookResult([{ ...endpoint, url: "https://other.example.com/api/billing/webhook" }], url, true).status, "fail");
  assert.equal(webhookResult([{ ...endpoint, status: "disabled" }], url, true).status, "fail");
  const missing = webhookResult([{ ...endpoint, enabled_events: HANDLED_EVENT_TYPES.slice(1) }], url, true);
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /checkout\.session\.completed/);
  assert.equal(webhookResult([endpoint], url, false).status, "fail");
});

test("portal: ok with a configuration, fail without", () => {
  assert.equal(portalResult([{ id: "bpc_1" }]).status, "ok");
  assert.equal(portalResult([]).status, "fail");
});

test("terms check: warns until the generated terms have the withdrawal section", () => {
  assert.equal(termsResult([{ id: "the-service" }]).status, "warn");
  assert.match(termsResult([]).fix, /legal-generate/);
  assert.equal(termsResult(undefined).status, "warn");
  assert.equal(termsResult([{ id: "the-service" }, { id: "right-to-withdraw" }]).status, "ok");
});
