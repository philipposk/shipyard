import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confirmRedirectUrl,
  isEmailNotConfirmed,
  isHiddenExistingUser,
  parseSignupMode,
  signupErrorToResult,
} from "../src/lib/auth/signup-mode.mjs";

test("parseSignupMode: only 'verified' turns verification on, anything else is starter", () => {
  assert.equal(parseSignupMode("verified"), "verified");
  assert.equal(parseSignupMode(" Verified "), "verified");
  for (const v of [undefined, "", "starter", "VERIFY", "true", 1, null]) assert.equal(parseSignupMode(v), "starter");
});

test("isHiddenExistingUser: Supabase's disguised 'already registered' answer has no identities", () => {
  assert.equal(isHiddenExistingUser({ identities: [] }), true);
  assert.equal(isHiddenExistingUser({ identities: [{ id: "1" }] }), false);
  assert.equal(isHiddenExistingUser({}), false);
  assert.equal(isHiddenExistingUser(null), false);
  assert.equal(isHiddenExistingUser(undefined), false);
});

test("signupErrorToResult: plain-English messages and the right status", () => {
  assert.deepEqual(signupErrorToResult({ code: "user_already_exists", message: "x" }).status, 409);
  assert.equal(signupErrorToResult({ message: "User already registered" }).status, 409);
  assert.equal(signupErrorToResult({ code: "over_email_send_rate_limit" }).status, 429);
  assert.equal(signupErrorToResult({ status: 429 }).status, 429);
  assert.match(signupErrorToResult({ code: "weak_password" }).error, /stronger password/);
  assert.equal(signupErrorToResult({ code: "email_address_invalid" }).status, 400);
  const other = signupErrorToResult({ message: "database exploded: secret detail" });
  assert.equal(other.status, 400);
  assert.ok(!/secret detail/.test(other.error), "internal messages are not passed on");
  assert.equal(signupErrorToResult(null).status, 400);
});

test("isEmailNotConfirmed recognises the sign-in error", () => {
  assert.equal(isEmailNotConfirmed({ code: "email_not_confirmed" }), true);
  assert.equal(isEmailNotConfirmed({ message: "Email not confirmed" }), true);
  assert.equal(isEmailNotConfirmed({ message: "Invalid login credentials" }), false);
  assert.equal(isEmailNotConfirmed(null), false);
});

test("confirmRedirectUrl is built from the site address only", () => {
  assert.equal(confirmRedirectUrl("https://app.example.org"), "https://app.example.org/auth/confirm");
  assert.equal(confirmRedirectUrl("https://app.example.org/"), "https://app.example.org/auth/confirm");
});
