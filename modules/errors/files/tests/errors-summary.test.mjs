import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REPORT_BYTES, areasOf, buildSummary, checkCronAccess, cleanRoute, clientKey, cronSecretUsable, errorsResult, errorsUnreadable,
  formatWhen, groupErrors, parseClientReport, retentionCutoff, secretsMatch, clientAlert, createRateLimit, CLIENT_EMAIL_KEY, CLIENT_REPORTS_PER_MINUTE,
} from "../src/lib/errors/core.mjs";

const SECRET = "0123456789abcdef0123456789abcdef";

test("summary access: no secret set means not found, whatever the request sends", () => {
  for (const expected of [undefined, "", "short"]) {
    assert.deepEqual(checkCronAccess({ expected, given: SECRET }), { ok: false, status: 404 });
    assert.deepEqual(checkCronAccess({ expected, given: null }), { ok: false, status: 404 });
    assert.deepEqual(checkCronAccess({ expected, given: expected ?? "" }), { ok: false, status: 404 });
  }
});

test("summary access: missing or wrong secret is refused, the right one is let in", () => {
  assert.deepEqual(checkCronAccess({ expected: SECRET, given: null }), { ok: false, status: 401 });
  assert.deepEqual(checkCronAccess({ expected: SECRET, given: "" }), { ok: false, status: 401 });
  assert.deepEqual(checkCronAccess({ expected: SECRET, given: `${SECRET}x` }), { ok: false, status: 401 });
  assert.deepEqual(checkCronAccess({ expected: SECRET, given: SECRET.slice(1) }), { ok: false, status: 401 });
  assert.deepEqual(checkCronAccess({ expected: SECRET, given: SECRET.toUpperCase() }), { ok: false, status: 401 });
  assert.deepEqual(checkCronAccess({ expected: SECRET, given: SECRET }), { ok: true });
});

test("secretsMatch: different lengths do not throw, empty never matches", () => {
  assert.equal(secretsMatch("a", "bbbbbbbbbbbb"), false);
  assert.equal(secretsMatch("", ""), false);
  assert.equal(secretsMatch(undefined, "x"), false);
  assert.equal(secretsMatch(null, null), false);
  assert.equal(secretsMatch("same", "same"), true);
  assert.equal(cronSecretUsable("x".repeat(15)), false);
  assert.equal(cronSecretUsable("x".repeat(16)), true);
});

test("the summary holds only ids, statuses and two numbers", () => {
  const results = [
    { id: "database", label: "Database", status: "ok", detail: "Reached jane@example.com's data", fix: "n/a" },
    { id: "errors-24h", label: "Errors", status: "warn", detail: "2 problems" },
  ];
  const summary = buildSummary(results, { errors24h: 3, unresolved: 2 });
  assert.deepEqual(summary, { ok: true, checks: [{ id: "database", status: "ok" }, { id: "errors-24h", status: "warn" }], errors24h: 3, unresolved: 2 });
  assert.ok(!JSON.stringify(summary).includes("jane"));
  assert.equal(buildSummary([{ id: "x", status: "fail" }], { errors24h: null, unresolved: null }).ok, false);
});

test("client report: a normal report is accepted and the fingerprint is built by the server", () => {
  const raw = JSON.stringify({ message: "Cannot read properties of undefined", route: "/items/12345?code=abc#x", digest: "1234567", source: "page", fingerprint: "chosen-by-attacker", area: "billing" });
  const r = parseClientReport(raw);
  assert.equal(r.ok, true);
  assert.equal(r.report.area, "client");
  assert.equal(r.report.route, "/items/<n>");
  assert.match(r.report.fingerprint, /^client:\/items\/<n>:[a-z0-9]+$/);
  assert.equal(r.report.digest, "1234567");
  const again = parseClientReport(JSON.stringify({ message: "Cannot read properties of undefined", route: "/items/777" }));
  assert.equal(again.report.fingerprint, r.report.fingerprint, "same page kind and message, same problem");
});

test("client report: bad input is refused with the right status", () => {
  const cases = [
    ["", 400], ["not json", 400], ["[]", 400], ["null", 400], ["{}", 400],
    [JSON.stringify({ message: "", route: "/x" }), 400],
    [JSON.stringify({ message: "m" }), 400],
    [JSON.stringify({ message: "m", route: "https://evil.example/x" }), 400],
    [JSON.stringify({ message: "m", route: "//evil.example/x" }), 400],
    [JSON.stringify({ message: 5, route: "/x" }), 400],
    [JSON.stringify({ message: "m".repeat(MAX_REPORT_BYTES), route: "/x" }), 413],
  ];
  for (const [raw, status] of cases) {
    const r = parseClientReport(raw);
    assert.equal(r.ok, false, String(raw).slice(0, 30));
    assert.equal(r.status, status, String(raw).slice(0, 30));
  }
});

test("client report: secrets in the message are removed, odd digests are dropped, long messages are cut", () => {
  const key = `${"sk_" + "test_"}${"Ab1".repeat(10)}`;
  const r = parseClientReport(JSON.stringify({ message: `failed with ${key}`, route: "/x", digest: "bad digest <script>" }));
  assert.ok(!r.report.message.includes(key));
  assert.equal(r.report.digest, null);
  assert.ok(parseClientReport(JSON.stringify({ message: "w ".repeat(1500), route: "/x" })).report.message.length <= 500);
});

test("routes: only a path is kept, ids are folded away", () => {
  assert.equal(cleanRoute("/a/b?x=1#y"), "/a/b");
  assert.equal(cleanRoute("/u/1f0e6c1a-0a1b-4c2d-8e3f-123456789abc/edit"), "/u/<id>/edit");
  assert.equal(cleanRoute("/p/12/x"), "/p/12/x");
  assert.equal(cleanRoute("/p/12345"), "/p/<n>");
  assert.equal(cleanRoute("a/b"), null);
  assert.equal(cleanRoute("/a b"), null);
  assert.equal(cleanRoute("/" + "a".repeat(300)), null);
  assert.equal(cleanRoute(42), null);
});

test("the address used for the per-person limit", () => {
  const h = (o) => ({ get: (k) => o[k] ?? null });
  assert.equal(clientKey(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientKey(h({ "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(clientKey(h({})), "unknown");
});

const rows = [
  { fingerprint: "a", area: "api:x", message: "old a", created_at: "2026-10-01T10:00:00Z", resolved_at: null },
  { fingerprint: "a", area: "api:x", message: "new a", created_at: "2026-10-03T10:00:00Z", resolved_at: null },
  { fingerprint: "b", area: "client", message: "b", created_at: "2026-10-02T10:00:00Z", resolved_at: null },
  { fingerprint: "c", area: "api:y", message: "c", created_at: "2026-10-04T10:00:00Z", resolved_at: "2026-10-05T00:00:00Z" },
  { fingerprint: "a", area: "api:x", message: "mid a", created_at: "2026-10-02T09:00:00Z", resolved_at: null },
];

test("grouping: count, first and last seen, latest message, newest first, resolved hidden unless asked", () => {
  const groups = groupErrors(rows);
  assert.deepEqual(groups.map((g) => g.fingerprint), ["a", "b"]);
  assert.deepEqual(groups[0], { fingerprint: "a", area: "api:x", message: "new a", count: 3, firstSeen: "2026-10-01T10:00:00Z", lastSeen: "2026-10-03T10:00:00Z", resolved: false });
  assert.deepEqual(groupErrors(rows, { includeResolved: true }).map((g) => g.fingerprint), ["c", "a", "b"]);
  assert.deepEqual(groupErrors(rows, { area: "client" }).map((g) => g.fingerprint), ["b"]);
  assert.deepEqual(groupErrors([]), []);
  assert.deepEqual(areasOf(rows), ["api:x", "api:y", "client"]);
});

test("a problem that comes back after being resolved shows up again", () => {
  const back = [
    { fingerprint: "c", area: "x", message: "old", created_at: "2026-10-01T00:00:00Z", resolved_at: "2026-10-02T00:00:00Z" },
    { fingerprint: "c", area: "x", message: "again", created_at: "2026-10-03T00:00:00Z", resolved_at: null },
  ];
  assert.equal(groupErrors(back, { includeResolved: true })[0].resolved, false);
  assert.equal(groupErrors(back).length, 1);
});

test("health result: ok at 0, warn above 0, fail above 50, plain words and a next step", () => {
  assert.equal(errorsResult(0).status, "ok");
  assert.equal(errorsResult(1).status, "warn");
  assert.equal(errorsResult(50).status, "warn");
  assert.equal(errorsResult(51).status, "fail");
  assert.match(errorsResult(1).detail, /1 problem /);
  assert.match(errorsResult(3).detail, /3 different problems/);
  assert.ok(errorsResult(0).fix === undefined);
  assert.match(errorsResult(2).fix, /\/admin\/logs/);
  assert.equal(errorsUnreadable().status, "fail");
  assert.match(errorsUnreadable().fix, /provision-supabase/);
});

test("dates and the 90-day cut-off", () => {
  assert.equal(formatWhen("2026-10-16T14:03:59Z"), "2026-10-16 14:03 UTC");
  assert.equal(formatWhen("nonsense"), "unknown");
  assert.equal(retentionCutoff(Date.parse("2026-10-16T00:00:00Z")), "2026-07-18T00:00:00.000Z");
});

test("client report: web addresses are replaced, so a stranger's link never sits in the log or an email", () => {
  const r = parseClientReport(JSON.stringify({ message: "Your Stripe payouts are paused, confirm at https://evil.example/login?x=1 or www.evil.example/pay or ftp://evil.example", route: "/x" }));
  assert.equal(r.ok, true);
  assert.ok(!/evil/.test(r.report.message), r.report.message);
  assert.match(r.report.message, /payouts are paused, confirm at <url> or <url> or <url>/);
});

test("client report: email addresses in the text are hidden", () => {
  const r = parseClientReport(JSON.stringify({ message: "Could not load profile for jane@x.com", route: "/x" }));
  assert.equal(r.report.message, "Could not load profile for [email hidden]");
});

test("client reports: the owner's email is always the same generic text, one shared slot, and the totals are capped", () => {
  const a = clientAlert();
  assert.equal(a.emailKey, CLIENT_EMAIL_KEY);
  assert.equal(a.subject, "A page crashed for a visitor");
  assert.ok(!/\$\{|route|message/i.test(a.subject), "no page name in the subject");
  assert.ok(a.emailMessage.length > 0 && a.emailMessage.length < 200);
  assert.deepEqual(clientAlert(), a, "fixed text: nothing from the request goes in");
  assert.ok(CLIENT_REPORTS_PER_MINUTE > 0 && CLIENT_REPORTS_PER_MINUTE <= 120);
  const overall = createRateLimit({ windowMs: 60_000, max: CLIENT_REPORTS_PER_MINUTE, maxKeys: 1 });
  let allowed = 0;
  for (let i = 0; i < 500; i++) if (overall.hit("all", 1000)) allowed++;
  assert.equal(allowed, CLIENT_REPORTS_PER_MINUTE);
});
