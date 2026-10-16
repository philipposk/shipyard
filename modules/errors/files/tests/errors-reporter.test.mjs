import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, createRateLimit, parseAlertHours, alertIdempotencyKey, alertRecipients, buildAlertEmail } from "../src/lib/errors/core.mjs";
import { createReporter, MAX_ALERTS_PER_HOUR } from "../src/lib/errors/reporter.mjs";

const HOUR = 3_600_000;
const fakeKey = () => `${"sk_" + "live_"}${"Zz9".repeat(9)}`;

function setup({ configured = true, recipients = ["owner@example.com"], env = {}, sendResult = { ok: true }, saveFails = false } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const saved = [];
  const sent = [];
  const logs = [];
  const reporter = createReporter({
    save: async (row) => {
      if (saveFails) throw new Error("db down");
      saved.push(row);
    },
    send: async (email) => {
      sent.push(email);
      return sendResult;
    },
    recipients: async () => recipients,
    configured: () => configured,
    env,
    brandName: "Shop",
    siteUrl: "https://shop.example.com",
    now: () => clock.t,
    log: { error: (...args) => logs.push(args.join(" ")) },
  });
  return { reporter, clock, saved, sent, logs };
}

const report = (over = {}) => ({ area: "api:checkout", fingerprint: "api:checkout:abc", message: "provider said no", ...over });

test("a problem is logged once a minute per fingerprint, and again after the minute", async () => {
  const { reporter, clock, saved } = setup();
  await reporter.reportError(report());
  await reporter.reportError(report());
  await reporter.reportError(report({ fingerprint: "other" }));
  assert.equal(saved.length, 2);
  clock.t += 59_000;
  await reporter.reportError(report());
  assert.equal(saved.length, 2);
  clock.t += 2_000;
  await reporter.reportError(report());
  assert.equal(saved.length, 3);
});

test("the email goes out once per fingerprint per window (6 hours by default), to everyone, with an idempotency key", async () => {
  const { reporter, clock, sent } = setup({ recipients: ["a@example.com", "b@example.com"] });
  await reporter.reportError(report());
  await reporter.reportError(report());
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["a@example.com", "b@example.com"]);
  assert.match(sent[0].subject, /^\[Shop\] /);
  assert.equal(sent[0].idempotencyKey, alertIdempotencyKey("api:checkout:abc", clock.t, 6 * HOUR));
  clock.t += 5 * HOUR;
  await reporter.reportError(report());
  assert.equal(sent.length, 1);
  clock.t += 2 * HOUR;
  await reporter.reportError(report());
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
});

test("two servers at the same moment build the same idempotency key; a different window or problem builds another", () => {
  const t = 1_800_000_000_000;
  assert.equal(alertIdempotencyKey("fp", t, 6 * HOUR), alertIdempotencyKey("fp", t + 1000, 6 * HOUR));
  assert.notEqual(alertIdempotencyKey("fp", t, 6 * HOUR), alertIdempotencyKey("fp", t + 7 * HOUR, 6 * HOUR));
  assert.notEqual(alertIdempotencyKey("fp", t, 6 * HOUR), alertIdempotencyKey("fp2", t, 6 * HOUR));
  assert.ok(alertIdempotencyKey("x".repeat(300), t, HOUR).length < 256);
});

test("ERROR_ALERT_HOURS changes the window; nonsense falls back to 6", async () => {
  assert.equal(parseAlertHours("2"), 2);
  assert.equal(parseAlertHours(undefined), 6);
  assert.equal(parseAlertHours(""), 6);
  assert.equal(parseAlertHours("abc"), 6);
  assert.equal(parseAlertHours("-3"), 6);
  assert.equal(parseAlertHours("0"), 6);
  assert.equal(parseAlertHours("100000"), 6);
  const { reporter, clock, sent } = setup({ env: { ERROR_ALERT_HOURS: "1" } });
  await reporter.reportError(report());
  clock.t += 61 * 60_000;
  await reporter.reportError(report());
  assert.equal(sent.length, 2);
});

test("without an email service nothing is sent and nothing breaks; the log still gets the row", async () => {
  const { reporter, saved, sent } = setup({ configured: false });
  await reporter.reportError(report());
  assert.equal(sent.length, 0);
  assert.equal(saved.length, 1);
});

test("no one to email: no email, and the window is not used up", async () => {
  let to = [];
  const sent = [];
  const reporter = createReporter({
    save: async () => {}, send: async (e) => (sent.push(e), { ok: true }), recipients: async () => to, brandName: "Shop", siteUrl: "https://s.example.com",
    log: { error: () => {} },
  });
  await reporter.reportError(report());
  assert.equal(sent.length, 0);
  to = ["owner@example.com"];
  await reporter.reportError(report());
  assert.equal(sent.length, 1);
});

test("email: false logs without mailing", async () => {
  const { reporter, saved, sent } = setup();
  await reporter.reportError(report({ email: false }));
  assert.equal(saved.length, 1);
  assert.equal(sent.length, 0);
});

test("a flood of different problems sends at most 10 emails an hour", async () => {
  const { reporter, clock, sent } = setup();
  for (let i = 0; i < 25; i++) await reporter.reportError(report({ fingerprint: `fp-${i}` }));
  assert.equal(sent.length, MAX_ALERTS_PER_HOUR);
  clock.t += HOUR + 1000;
  await reporter.reportError(report({ fingerprint: "fp-24" }));
  assert.equal(sent.length, MAX_ALERTS_PER_HOUR + 1, "a problem that was held back can be mailed once the hour is over");
});

test("six failures at once in one server send one email", async () => {
  const { reporter, sent } = setup();
  await Promise.all(Array.from({ length: 6 }, () => reporter.reportError(report())));
  assert.equal(sent.length, 1);
});

test("reporting never throws: a broken database or email service is only printed", async () => {
  const a = setup({ saveFails: true });
  await a.reporter.reportError(report());
  assert.ok(a.logs.some((l) => l.includes("could not save")));
  const b = setup({ sendResult: { ok: false, error: "Resend 500" } });
  await b.reporter.reportError(report());
  assert.ok(b.logs.some((l) => l.includes("Resend 500")));
  const c = setup({ sendResult: { ok: false, error: "Resend 409" } });
  await c.reporter.reportError(report());
  assert.ok(!c.logs.some((l) => l.includes("email:")), "409 means another server already sent it");
  const d = createReporter({ save: async () => {}, send: async () => { throw new Error("network"); }, recipients: async () => ["o@example.com"], brandName: "S", siteUrl: "https://s.example.com", log: { error: () => {} } });
  await assert.doesNotReject(d.reportError(report()));
  await assert.doesNotReject(d.reportError({}));
  await assert.doesNotReject(d.reportError(undefined));
});

test("secrets are removed from the log row, the server log and the email", async () => {
  const key = fakeKey();
  const { reporter, saved, sent, logs } = setup();
  await reporter.reportError(report({
    message: `provider rejected ${key} with password=hunter2`,
    detail: { token: "abc", note: `retry with ${key}`, status: 401 },
    summary: `Used ${key}`,
    action: "Check password=hunter2",
  }));
  const everything = JSON.stringify([saved, sent, logs]);
  assert.ok(!everything.includes(key) && !everything.includes("hunter2") && !everything.includes('"abc"'));
  assert.equal(saved[0].detail.status, 401);
  assert.equal(saved[0].detail.token, "[hidden]");
});

test("the row is cut to the sizes the table allows", async () => {
  const { reporter, saved } = setup();
  await reporter.reportError({ area: "a".repeat(500), fingerprint: "f".repeat(900), message: "m ".repeat(5000) });
  assert.ok(saved[0].area.length <= 100 && saved[0].fingerprint.length <= 300 && saved[0].message.length <= 4000);
});

test("user id is passed along, missing means null", async () => {
  const { reporter, saved } = setup();
  await reporter.reportError(report({ userId: "u-1" }));
  await reporter.reportError(report({ fingerprint: "x" }));
  assert.equal(saved[0].user_id, "u-1");
  assert.equal(saved[1].user_id, null);
});

test("gate and rate limit basics", () => {
  const gate = createGate({ windowMs: 1000 });
  assert.equal(gate.allow("a", 0), true);
  assert.equal(gate.allow("a", 999), false);
  assert.equal(gate.allow("a", 1000), true);
  gate.forget("a");
  assert.equal(gate.allow("a", 1001), true);
  const small = createGate({ windowMs: 1000, maxKeys: 3 });
  for (const k of ["a", "b", "c", "d", "e"]) small.allow(k, 0);
  assert.equal(small.allow("e", 1), false, "the newest key is still remembered after the memory was emptied");
  const limit = createRateLimit({ windowMs: 1000, max: 2 });
  assert.deepEqual([limit.hit("ip", 0), limit.hit("ip", 1), limit.hit("ip", 2), limit.hit("other", 2), limit.hit("ip", 1001)], [true, true, false, true, true]);
});

test("recipients: ADMIN_EMAIL (several allowed) plus admin addresses, valid and unique, at most 5", () => {
  assert.deepEqual(alertRecipients("Owner@Example.com; two@example.com", ["owner@example.com", "three@example.com"]), ["owner@example.com", "two@example.com", "three@example.com"]);
  assert.deepEqual(alertRecipients("not an email, @x, a@b", []), []);
  assert.deepEqual(alertRecipients(undefined, []), []);
  assert.equal(alertRecipients("", Array.from({ length: 9 }, (_, i) => `u${i}@example.com`)).length, 5);
});

test("the email says what happened, where, how often you get it, and escapes HTML", () => {
  const mail = buildAlertEmail({ brandName: "Shop", area: "api:<x>", message: "<script>alert(1)</script>", siteUrl: "https://shop.example.com", hours: 6, at: 0 });
  assert.equal(mail.subject, "[Shop] Problem in api:<x>");
  assert.match(mail.text, /at most every 6 hours/);
  assert.match(mail.text, /https:\/\/shop\.example\.com\/admin\/logs/);
  assert.match(mail.text, /1970-01-01T00:00:00\.000Z/);
  assert.ok(!mail.html.includes("<script>"));
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(buildAlertEmail({ brandName: "S", area: "a", message: "m", siteUrl: "https://s.example.com", hours: 1, at: 0 }).text, /every 1 hour\./);
});

test("reports that share an email key (crashes reported by visitors) send one email together, whatever their fingerprints", async () => {
  const { reporter, clock, saved, sent } = setup();
  for (let i = 0; i < 20; i++) await reporter.reportError(report({ area: "client", fingerprint: `client:/page-${i}:abc`, emailKey: "client", subject: "A page crashed for a visitor" }));
  assert.equal(saved.length, 20, "every different crash is still logged");
  assert.equal(sent.length, 1, "but together they send one email");
  assert.equal(sent[0].idempotencyKey, alertIdempotencyKey("client", clock.t, 6 * HOUR));
  // another kind of problem has its own slot
  await reporter.reportError(report({ fingerprint: "api:other:1" }));
  assert.equal(sent.length, 2);
  // and the shared slot opens again after the window
  clock.t += 6 * HOUR + 1000;
  await reporter.reportError(report({ area: "client", fingerprint: "client:/again:abc", emailKey: "client" }));
  assert.equal(sent.length, 3);
});

test("emailMessage replaces the stored message in the email: words written by a stranger never reach the inbox", async () => {
  const { reporter, saved, sent } = setup();
  await reporter.reportError(report({
    area: "client", fingerprint: "client:/x:1", emailKey: "client", subject: "A page crashed for a visitor",
    message: "Your payouts are paused, confirm at <url>\nPage: /pay-now-or-lose-your-money",
    emailMessage: "The page and the exact words are in the error log.",
  }));
  assert.match(saved[0].message, /payouts are paused/, "the log has the real text for the admin");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "[Shop] A page crashed for a visitor");
  assert.ok(!/payouts|pay-now/.test(sent[0].text + sent[0].html + sent[0].subject), "nothing the visitor wrote is in the email");
  assert.match(sent[0].text, /error log/);
});

test("an email key is cleaned like everything else, and a held-back email gives the shared slot back", async () => {
  let to = [];
  const clock = { t: 1_800_000_000_000 };
  const sent = [];
  const reporter = createReporter({
    save: async () => {}, send: async (e) => { sent.push(e); return { ok: true }; }, recipients: async () => to,
    configured: () => true, env: {}, brandName: "Shop", siteUrl: "https://shop.example.com", now: () => clock.t, log: { error: () => {} },
  });
  await reporter.reportError(report({ emailKey: "client" }));
  assert.equal(sent.length, 0);
  to = ["owner@example.com"];
  await reporter.reportError(report({ emailKey: "client", fingerprint: "other" }));
  assert.equal(sent.length, 1, "no recipients earlier, so the slot was not used up");
});
