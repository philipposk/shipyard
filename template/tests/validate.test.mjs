import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BIO_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ITEM_TITLE_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  normalizeItemTitle,
  parseProfileInput,
  passwordProblem,
} from "../src/lib/validate.mjs";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  Sam@Example.COM "), "sam@example.com");
});

test("normalizeEmail rejects things that are not emails", () => {
  for (const bad of ["", "sam", "sam@", "@example.com", "sam@example", "sam @example.com", null, undefined, 5]) {
    assert.equal(normalizeEmail(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeEmail(`${"a".repeat(250)}@example.com`), null);
});

test("passwordProblem asks for a minimum length", () => {
  assert.match(passwordProblem("short"), /at least/);
  assert.equal(passwordProblem("x".repeat(MIN_PASSWORD_LENGTH)), null);
  assert.match(passwordProblem(undefined), /at least/);
});

test("passwordProblem refuses passwords longer than the 72 bytes Supabase reads", () => {
  assert.equal(passwordProblem("x".repeat(72)), null);
  assert.match(passwordProblem("x".repeat(73)), /at most/);
  // 40 two-byte characters are 80 bytes.
  assert.match(passwordProblem("é".repeat(40)), /at most/);
});

test("passwords with $ and ! are accepted as typed", () => {
  assert.equal(passwordProblem("pa$$word!1234"), null);
});

test("normalizeItemTitle trims, collapses spaces and enforces the limit", () => {
  assert.equal(normalizeItemTitle("  Buy   milk  "), "Buy milk");
  assert.equal(normalizeItemTitle("   "), null);
  assert.equal(normalizeItemTitle(7), null);
  assert.equal(normalizeItemTitle("x".repeat(MAX_ITEM_TITLE_LENGTH)), "x".repeat(MAX_ITEM_TITLE_LENGTH));
  assert.equal(normalizeItemTitle("x".repeat(MAX_ITEM_TITLE_LENGTH + 1)), null);
});

test("parseProfileInput keeps only name and bio", () => {
  const result = parseProfileInput({ display_name: "  Sam ", bio: " hi ", is_admin: true, onboarding_complete: false });
  assert.deepEqual(result, { value: { display_name: "Sam", bio: "hi" } });
});

test("parseProfileInput explains what is wrong", () => {
  assert.match(parseProfileInput({ display_name: " " }).error, /display name/i);
  assert.match(parseProfileInput(null).error, /display name/i);
  assert.match(parseProfileInput({ display_name: "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1) }).error, /display name/i);
  assert.match(parseProfileInput({ display_name: "Sam", bio: "x".repeat(MAX_BIO_LENGTH + 1) }).error, /bio/i);
});
