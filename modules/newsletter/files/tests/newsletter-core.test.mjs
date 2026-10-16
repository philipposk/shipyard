import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidEmail, tokenSecret, unsubscribeTokenFor, hashToken, looksLikeToken, tokenMatches, unsubscribePageUrl, unsubscribeApiUrl,
  listUnsubscribeHeaders, isConsented, consentedRecipients, emailIsProven, consentNotBefore, checkCompose, parseSource, sendingResult, secretResult, SUBJECT_MAX, BODY_MAX,
} from "../src/lib/newsletter/core.mjs";

const SECRET = "a-long-private-random-value-0123456789";
const FAKE_RESEND_KEY = ["re", "secretsecretsecretsecret"].join("_");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("a token is 43 url-safe characters, stable per person and different between people", () => {
  const t = unsubscribeTokenFor(SECRET, A);
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t, unsubscribeTokenFor(SECRET, A));
  assert.notEqual(t, unsubscribeTokenFor(SECRET, B));
  assert.notEqual(t, unsubscribeTokenFor(`${SECRET}x`, A));
  assert.equal(looksLikeToken(t), true);
});

test("the stored fingerprint is a SHA-256 hex of the token and does not reveal it", () => {
  const t = unsubscribeTokenFor(SECRET, A);
  const h = hashToken(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(t));
  assert.equal(h, hashToken(t));
  assert.notEqual(h, hashToken(unsubscribeTokenFor(SECRET, B)));
});

test("tokenMatches accepts only the right token for the right person", () => {
  const t = unsubscribeTokenFor(SECRET, A);
  assert.equal(tokenMatches(SECRET, A, t), true);
  assert.equal(tokenMatches(SECRET, B, t), false);
  assert.equal(tokenMatches("another-secret-value-1234567", A, t), false);
  for (const bad of ["", "short", null, undefined, 5, `${t}x`, t.slice(1)]) assert.equal(tokenMatches(SECRET, A, bad), false, String(bad));
});

test("looksLikeToken rejects anything that is not 43 url-safe characters", () => {
  for (const bad of ["", "abc", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, `${"a".repeat(42)} `, null, undefined, 7, "../../etc/passwd"]) {
    assert.equal(looksLikeToken(bad), false, String(bad));
  }
});

test("tokenSecret needs NEWSLETTER_SECRET of at least 16 characters and uses nothing else", () => {
  assert.deepEqual(tokenSecret({ NEWSLETTER_SECRET: SECRET }), { secret: SECRET });
  assert.equal(tokenSecret({ NEWSLETTER_SECRET: "short" }), null);
  assert.equal(tokenSecret({ SOME_OTHER_LONG_VALUE: "x".repeat(40) }), null);
  assert.equal(tokenSecret({}), null);
});

test("unsubscribe addresses", () => {
  const t = unsubscribeTokenFor(SECRET, A);
  assert.equal(unsubscribePageUrl("https://shop.example.com/", t), `https://shop.example.com/unsubscribe?token=${t}`);
  assert.equal(unsubscribePageUrl("https://shop.example.com", null), "https://shop.example.com/unsubscribe");
  assert.equal(unsubscribeApiUrl("https://shop.example.com//", t), `https://shop.example.com/api/newsletter/unsubscribe?token=${t}`);
});

test("list headers carry the one-click unsubscribe (RFC 8058)", () => {
  const url = "https://shop.example.com/api/newsletter/unsubscribe?token=abc";
  assert.deepEqual(listUnsubscribeHeaders(url), { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
});

const row = (over = {}) => ({ user_id: A, email: "sam@example.com", status: "subscribed", consent_at: "2027-01-01T10:00:00Z", ...over });

test("only people who said yes are consented", () => {
  assert.equal(isConsented(row()), true);
  assert.equal(isConsented(row({ status: "unsubscribed" })), false);
  assert.equal(isConsented(row({ consent_at: null })), false);
  assert.equal(isConsented(row({ consent_at: "not a date" })), false);
  assert.equal(isConsented(row({ email: "nope" })), false);
  assert.equal(isConsented(row({ email: "a b@example.com" })), false);
  assert.equal(isConsented(row({ status: "pending" })), false);
  assert.equal(isConsented(null), false);
  assert.equal(isConsented(undefined), false);
});

test("consentedRecipients drops everyone else and repeated addresses", () => {
  const rows = [
    row({ user_id: A, email: "Sam@Example.com" }),
    row({ user_id: B, email: "sam@example.com" }),
    row({ user_id: "3", email: "kim@example.com", status: "unsubscribed" }),
    row({ user_id: "4", email: "lee@example.com", consent_at: null }),
    row({ user_id: "5", email: "bad-address" }),
    row({ user_id: "6", email: "pat@example.com" }),
  ];
  assert.deepEqual(consentedRecipients(rows).map((r) => r.user_id), [A, "6"]);
  assert.deepEqual(consentedRecipients(undefined), []);
  assert.deepEqual(consentedRecipients([]), []);
});

test("isValidEmail", () => {
  for (const ok of ["a@b.co", "sam.lee+news@example.com"]) assert.equal(isValidEmail(ok), true, ok);
  for (const bad of ["", "a", "a@b", "@b.co", "a@b.", "a b@c.de", "a@b.co,c@d.ef", "a@b.co;c@d.ef", "<a@b.co>", "x".repeat(250) + "@b.co", null, 4]) assert.equal(isValidEmail(bad), false, String(bad));
});

test("checkCompose cleans the subject and checks lengths", () => {
  assert.deepEqual(checkCompose({ subject: "  What's \n new  ", bodyMd: "Hello" }), { ok: true, subject: "What's new", bodyMd: "Hello" });
  assert.equal(checkCompose({ subject: "", bodyMd: "x" }).ok, false);
  assert.equal(checkCompose({ subject: "x".repeat(SUBJECT_MAX + 1), bodyMd: "x" }).ok, false);
  assert.equal(checkCompose({ subject: "x", bodyMd: "   " }).ok, false);
  assert.equal(checkCompose({ subject: "x", bodyMd: "y".repeat(BODY_MAX + 1) }).ok, false);
  assert.equal(checkCompose({}).ok, false);
  // A subject can never carry a line break into an email header.
  assert.ok(!/[\r\n]/.test(checkCompose({ subject: "a\r\nBcc: x@y.z", bodyMd: "x" }).subject));
});

test("parseSource allows only the known places", () => {
  assert.equal(parseSource("signup"), "signup");
  assert.equal(parseSource("settings"), "settings");
  assert.equal(parseSource("import"), "settings");
  assert.equal(parseSource(undefined), "settings");
});

test("health results are plain and never show values", () => {
  assert.equal(sendingResult({}).status, "skip");
  assert.equal(sendingResult({ RESEND_API_KEY: FAKE_RESEND_KEY }).status, "warn");
  assert.equal(sendingResult({ RESEND_API_KEY: FAKE_RESEND_KEY, RESEND_FROM: "A <a@b.co>" }).status, "ok");
  assert.equal(secretResult({}).status, "fail");
  assert.equal(secretResult({ NEWSLETTER_SECRET: SECRET }).status, "ok");
  for (const r of [sendingResult({ RESEND_API_KEY: FAKE_RESEND_KEY }), secretResult({ NEWSLETTER_SECRET: SECRET })]) {
    assert.ok(!r.detail.includes("secretsecret") && !r.detail.includes(SECRET));
  }
});

test("a yes only counts when the email address is proven to be theirs", () => {
  assert.equal(emailIsProven({ signupMode: "verified", identities: [{ provider: "email" }] }), true);
  assert.equal(emailIsProven({ signupMode: "starter", identities: [{ provider: "email" }] }), false, "starter accounts never proved their address");
  assert.equal(emailIsProven({ signupMode: "starter", identities: [] }), false);
  assert.equal(emailIsProven({ signupMode: "starter" }), false);
  assert.equal(emailIsProven({ signupMode: "starter", identities: [{ provider: "email" }, { provider: "google" }] }), true, "Google confirms the address");
  assert.equal(emailIsProven({}), false);
});

test("consent given before the cut-off (the switch to verified sign-ups) does not count", () => {
  const cutoff = consentNotBefore({ NEWSLETTER_CONSENT_NOT_BEFORE: "2027-01-01T00:00:00Z" });
  assert.equal(cutoff, Date.parse("2027-01-01T00:00:00Z"));
  const base = { status: "subscribed", email: "a@example.com" };
  assert.equal(isConsented({ ...base, consent_at: "2026-12-31T23:59:59Z" }, cutoff), false);
  assert.equal(isConsented({ ...base, consent_at: "2027-01-01T00:00:01Z" }, cutoff), true);
  assert.equal(isConsented({ ...base, consent_at: "2026-12-31T23:59:59Z" }), true, "no cut-off set: unchanged behaviour");
  assert.deepEqual(
    consentedRecipients([{ ...base, user_id: "1", consent_at: "2026-06-01T00:00:00Z" }, { ...base, email: "b@example.com", user_id: "2", consent_at: "2027-02-01T00:00:00Z" }], cutoff).map((r) => r.user_id),
    ["2"],
  );
  assert.equal(consentNotBefore({}), null);
  assert.equal(consentNotBefore({ NEWSLETTER_CONSENT_NOT_BEFORE: "garbage" }), null);
});
