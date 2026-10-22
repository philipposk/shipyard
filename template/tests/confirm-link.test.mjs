import { test } from "node:test";
import assert from "node:assert/strict";
import { OTP_TYPES, parseConfirmParams, continuePath, failedPath } from "../src/lib/auth/confirm-link.mjs";

const q = (s) => new URLSearchParams(s);

test("parseConfirmParams: a token link with a known type is read", () => {
  assert.deepEqual(parseConfirmParams(q("token_hash=abc&type=recovery&next=/reset-password")), { tokenHash: "abc", type: "recovery", next: "/reset-password" });
  assert.deepEqual(parseConfirmParams(q("token_hash=abc&type=email")), { tokenHash: "abc", type: "email", next: null });
});

test("parseConfirmParams: missing token, missing type or an unknown type give null", () => {
  assert.equal(parseConfirmParams(q("type=recovery")), null);
  assert.equal(parseConfirmParams(q("token_hash=abc")), null);
  assert.equal(parseConfirmParams(q("token_hash=abc&type=admin")), null);
  assert.equal(parseConfirmParams(q("token_hash=&type=email")), null);
  assert.equal(parseConfirmParams(q("code=xyz")), null);
});

test("parseConfirmParams: form data works too, and files are ignored", () => {
  const form = new FormData();
  form.set("token_hash", "abc");
  form.set("type", "signup");
  assert.equal(parseConfirmParams(form)?.type, "signup");
  form.set("token_hash", new File(["x"], "x.txt"));
  assert.equal(parseConfirmParams(form), null);
});

test("continuePath: goes to the button page and keeps the values", () => {
  const p = continuePath({ tokenHash: "a b&c", type: "recovery", next: "/reset-password" });
  assert.ok(p.startsWith("/auth/confirm/continue?"));
  const u = new URL(p, "https://x.test");
  assert.equal(u.searchParams.get("token_hash"), "a b&c");
  assert.equal(u.searchParams.get("next"), "/reset-password");
  assert.equal(new URL(continuePath({ tokenHash: "a", type: "email", next: null }), "https://x.test").searchParams.has("next"), false);
});

test("failedPath: each type ends on the right sign-in message", () => {
  assert.equal(failedPath("recovery"), "/sign-in?mode=forgot&error=link_expired");
  assert.equal(failedPath("signup"), "/sign-in?error=confirm_failed");
  assert.equal(failedPath("email"), "/sign-in?error=confirm_failed");
  assert.equal(failedPath("magiclink"), "/sign-in?error=auth");
  assert.ok(OTP_TYPES.includes("recovery"));
});
