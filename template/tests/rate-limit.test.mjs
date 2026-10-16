import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../src/lib/rate-limit.mjs";

test("limiter: allows up to max hits per window, then says how long to wait", () => {
  const l = createLimiter({ windowMs: 60_000, max: 2 });
  assert.equal(l.check("a", 0).ok, true);
  l.record("a", 0);
  l.record("a", 1000);
  const blocked = l.check("a", 2000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSec, 58);
  assert.equal(l.check("a", 60_001).ok, true, "the oldest hit left the window");
  assert.equal(l.check("b", 2000).ok, true, "other keys are separate");
});

test("limiter: cooldown between two hits", () => {
  const l = createLimiter({ windowMs: 3_600_000, max: 5, cooldownMs: 60_000 });
  l.record("e", 0);
  const r = l.check("e", 10_000);
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterSec, 50);
  assert.equal(l.check("e", 60_000).ok, true);
});

test("limiter: check alone records nothing", () => {
  const l = createLimiter({ windowMs: 1000, max: 1 });
  for (let i = 0; i < 5; i++) assert.equal(l.check("k", 0).ok, true);
});

test("limiter: the key table cannot grow without limit", () => {
  const l = createLimiter({ windowMs: 1000, max: 1, maxKeys: 3 });
  for (let i = 0; i < 10; i++) l.record(`k${i}`, 0);
  assert.equal(l.check("k9", 0).ok, false, "recent keys still count");
  assert.equal(l.check("k0", 0).ok, true, "old ones were dropped when the table filled");
});
