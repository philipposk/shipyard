import { test } from "node:test";
import assert from "node:assert/strict";
import { signOnboarded, verifyOnboarded, onboardedCookieSecret } from "../src/lib/auth/onboarded-cookie.mjs";

const SECRET = "test-secret-not-real";
const USER = "6f1c2a3b-0000-4000-8000-000000000001";
const OTHER = "6f1c2a3b-0000-4000-8000-000000000002";

test("a cookie signed for a user verifies for that user", async () => {
  const value = await signOnboarded(USER, SECRET);
  assert.match(value, /^[0-9a-f-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(await verifyOnboarded(value, USER, SECRET), true);
});

test("someone else's cookie, a forged signature or a wrong secret do not verify", async () => {
  const value = await signOnboarded(USER, SECRET);
  assert.equal(await verifyOnboarded(value, OTHER, SECRET), false);
  assert.equal(await verifyOnboarded(value, USER, "another-secret"), false);
  const [, sig] = value.split(".");
  assert.equal(await verifyOnboarded(`${OTHER}.${sig}`, OTHER, SECRET), false);
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.equal(await verifyOnboarded(`${USER}.${flipped}`, USER, SECRET), false);
});

test("old unsigned values are refused (a visitor could type them in)", async () => {
  for (const legacy of ["1", USER, `${USER}.`, "", null, undefined]) {
    assert.equal(await verifyOnboarded(legacy, USER, SECRET), false, String(legacy));
  }
});

test("no secret: no cookie is made and nothing verifies", async () => {
  assert.equal(await signOnboarded(USER, ""), null);
  const value = await signOnboarded(USER, SECRET);
  assert.equal(await verifyOnboarded(value, USER, ""), false);
});

test("the secret comes from server-only variables", () => {
  assert.equal(onboardedCookieSecret({ ONBOARDED_COOKIE_SECRET: "a", SUPABASE_SERVICE_ROLE_KEY: "b" }), "a");
  assert.equal(onboardedCookieSecret({ SUPABASE_SERVICE_ROLE_KEY: "b" }), "b");
  assert.equal(onboardedCookieSecret({ NEXT_PUBLIC_ONBOARDED_COOKIE_SECRET: "x" }), "");
});
