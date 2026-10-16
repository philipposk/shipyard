import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, fingerprintFor, hashString, normalizeMessage, scrubDetail, scrubText } from "../src/lib/errors/core.mjs";

// Fake keys are put together here so no real-looking key sits in the file (the key-leak scan would complain).
const fake = (prefix, n = 26) => `${prefix}${"a1B2".repeat(10).slice(0, n)}`;
const jwt = () => ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "c2lnbmF0dXJlc2lnbmF0dXJl"].join(".");

test("known key shapes are hidden in any text", () => {
  const keys = [fake("sk_" + "live_"), fake("sk_" + "test_"), fake("rk_" + "live_"), fake("whsec_"), fake("sbp_"), fake("re_"), fake("sk-or-v1-"), fake("sk-proj-"), fake("ghp_", 36), `AKIA${"A1B2".repeat(4)}`, jwt(), fake("sb_" + "secret_")];
  for (const key of keys) {
    const out = scrubText(`provider said no for ${key} at noon`);
    assert.ok(!out.includes(key), `${key.slice(0, 6)} is hidden`);
    assert.match(out, /hidden/);
    assert.match(out, /provider said no for .* at noon/);
  }
});

test("passwords, tokens and cookies in text are hidden, the rest of the sentence stays", () => {
  assert.equal(scrubText("login failed password=hunter2 for ann"), "login failed password=[hidden] for ann");
  assert.match(scrubText('{"password":"p@ss w0rd","email":"a@b.co"}'), /"password":\s*\[hidden\]/);
  assert.match(scrubText('{"password":"p@ss w0rd","email":"a@b.co"}'), /"email":"\[email hidden\]"/, 'the rest of the sentence stays; the address does not');
  assert.ok(!scrubText("Authorization: Bearer abcdefghijklmnop").includes("abcdefghijklmnop"));
  assert.ok(!scrubText("got Bearer abcdefghijklmnop back").includes("abcdefghijklmnop"));
  assert.ok(!scrubText("Cookie: sb-app-auth=verysecretvalue; other=1\nnext line").includes("verysecretvalue"));
  assert.match(scrubText("Cookie: a=1\nnext line"), /next line/);
  assert.ok(!scrubText("api_key: zzzz1111").includes("zzzz1111"));
  assert.ok(!scrubText("GET /cb?code=oneTimeCode123&state=x").includes("oneTimeCode123"));
  assert.match(scrubText("GET /cb?code=oneTimeCode123&state=x"), /state=x/);
});

test("database addresses lose their password, long unbroken values are hidden", () => {
  const out = scrubText("connect postgres://admin:s3cretpw@db.example.com:5432/app failed");
  assert.ok(!out.includes("s3cretpw") && out.includes("db.example.com"));
  assert.ok(!scrubText(`value ${"x9".repeat(30)} here`).includes("x9x9x9x9"));
});

test("ordinary text is left alone, long text is cut", () => {
  assert.equal(scrubText("Couldn't save the note (duplicate key on items_pkey)"), "Couldn't save the note (duplicate key on items_pkey)");
  assert.equal(scrubText("The user passed the check"), "The user passed the check");
  assert.equal(scrubText(null), "");
  assert.equal(scrubText(undefined), "");
  const long = scrubText("word ".repeat(2000));
  assert.ok(long.length <= 4000);
  assert.ok(scrubText("a".repeat(300), 50).length <= 50);
});

test("scrubText never throws, even on odd input", () => {
  for (const v of [{}, [], () => 1, Symbol("x").toString(), 12, true, "\u0000\u0001", "a".repeat(100_000)]) {
    assert.doesNotThrow(() => scrubText(v));
  }
});

test("detail: values under secret-looking names are replaced, strings inside are cleaned", () => {
  const out = scrubDetail({
    route: "/checkout",
    status: 502,
    password: "hunter2",
    nested: { accessToken: "abc", note: `key ${fake("sk_" + "live_")}`, authorization: "Bearer zzz" },
    headers: { cookie: "a=b" },
    body: "{\"card\":\"4242\"}",
    ok: true,
  });
  assert.equal(out.route, "/checkout");
  assert.equal(out.status, 502);
  assert.equal(out.password, "[hidden]");
  assert.equal(out.nested.accessToken, "[hidden]");
  assert.equal(out.nested.authorization, "[hidden]");
  assert.equal(out.headers.cookie, "[hidden]");
  assert.equal(out.body, "[hidden]");
  assert.ok(!JSON.stringify(out).includes("sk_" + "live_"));
  assert.equal(out.ok, true);
});

test("detail: whole requests, errors, functions and loops are dropped; empty or huge details are handled", () => {
  const loop = { a: 1 };
  loop.self = loop;
  const out = scrubDetail({ err: new Error("boom"), fn: () => 1, req: new Request("https://example.com"), loop, kept: "yes" });
  assert.deepEqual(Object.keys(out).sort(), ["kept", "loop"]);
  assert.deepEqual(out.loop, { a: 1 });
  assert.equal(scrubDetail(undefined), null);
  assert.equal(scrubDetail({}), null);
  assert.equal(scrubDetail({ fn: () => 1 }), null);
  const wide = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, "x ".repeat(300)]));
  assert.deepEqual(scrubDetail(wide), { note: "details were too long to keep" });
  assert.equal(scrubDetail({ list: Array.from({ length: 100 }, (_, i) => i) }).list.length, 20);
});

test("fingerprints: the same kind of problem gets the same one, different problems differ", () => {
  const a = fingerprintFor("api:save", "duplicate key value for id 4711");
  const b = fingerprintFor("api:save", "duplicate key value for id 99");
  const c = fingerprintFor("api:save", "permission denied for table items");
  const d = fingerprintFor("api:other", "duplicate key value for id 4711");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.ok(a.startsWith("api:save:"));
  assert.ok(fingerprintFor("x", "y".repeat(5000)).length <= 300);
  // A key inside the message does not change what the problem is.
  assert.equal(fingerprintFor("a", `bad key ${fake("sk_" + "live_")}`), fingerprintFor("a", `bad key ${fake("sk_" + "test_", 20)}`));
});

test("normalizeMessage takes out ids, numbers and addresses and keeps the first line", () => {
  assert.equal(normalizeMessage("row 1f0e6c1a-0a1b-4c2d-8e3f-123456789abc missing\nat stack"), "row <id> missing");
  assert.equal(normalizeMessage("failed after 3 tries at https://x.test/a?b=1"), "failed after <n> tries at <url>");
  assert.equal(hashString("a"), hashString("a"));
  assert.notEqual(hashString("a"), hashString("b"));
});

test("describeError: database errors keep code and hint, plain bugs keep the stack, secrets are cleaned", () => {
  assert.equal(describeError({ code: "23505", message: "duplicate key", details: "Key (id)=(1) exists.", hint: "" }), "[23505] duplicate key Key (id)=(1) exists.");
  const bug = new TypeError("x is not a function");
  assert.match(describeError(bug), /TypeError: x is not a function/);
  assert.equal(describeError("plain text"), "plain text");
  assert.equal(describeError(null), "null");
  assert.ok(!describeError(new Error(`token=${"q".repeat(12)} rejected`)).includes("qqqqqqqq"));
});

test("a private key block is hidden whole", () => {
  const d = "-".repeat(5);
  const block = `${d}BEGIN RSA PRIVATE KEY${d}\nMIIEowIBAAKCAQEA1234\nabcdef\n${d}END RSA PRIVATE KEY${d}`;
  const out = scrubText(`failed to sign ${block} then stopped`);
  assert.ok(!out.includes("MIIEow") && out.includes("then stopped"));
  assert.ok(!scrubText(`${d}BEGIN PRIVATE KEY${d}\nMIIEowIBAAKCAQEA1234 and no end`).includes("MIIEow"));
});

test("personal data: email addresses and phone numbers in text are hidden, the sentence stays", () => {
  const cases = [
    ["Resend: invalid to: jane.doe+news@example.co.uk", "Resend: invalid to: [email hidden]"],
    ["Key (email)=(jane@x.com) already exists", "Key (email)=([email hidden]) already exists"],
    ["send failed for a@b.io and c_d@sub.example.org", "send failed for [email hidden] and [email hidden]"],
    ["call +30 210 123 4567 failed", "call [phone hidden] failed"],
    ["sms to (415) 555-2671 bounced", "sms to [phone hidden] bounced"],
    ["sms to 415-555-2671 bounced", "sms to [phone hidden] bounced"],
    ["sms to +1 415.555.2671 bounced", "sms to [phone hidden] bounced"],
  ];
  for (const [input, expected] of cases) assert.equal(scrubText(input), expected, input);
  // not mistaken for personal data
  for (const same of [
    "Timed out after 30000 ms at 2026-10-16 14:03:09", "Row 12 of 4096 failed", "Version 1.2.3 and node 24.1.0", "id 1800000000000 not found",
    "duplicate key on items_pkey (user_id)", "ip 192.168.100.200 blocked",
  ]) assert.equal(scrubText(same), same);
  // the database address still loses only its password, and no half-hidden address is left behind
  assert.equal(scrubText("connect postgres://app:hunter2@db.example.com:5432/x failed"), "connect postgres://[hidden]@db.example.com:5432/x failed");
});

test("personal data: email, phone and address keys in details are never kept", () => {
  const out = scrubDetail({ email: "jane@x.com", userEmail: "j@x.com", phone: "+30 69 1234 5678", phoneNumber: "1", address: "1 Main St", route: "/signup", count: 2, note: "mail to jane@x.com" });
  assert.equal(out.email, "[hidden]");
  assert.equal(out.userEmail, "[hidden]");
  assert.equal(out.phone, "[hidden]");
  assert.equal(out.phoneNumber, "[hidden]");
  assert.equal(out.address, "[hidden]");
  assert.equal(out.route, "/signup");
  assert.equal(out.count, 2);
  assert.equal(out.note, "mail to [email hidden]");
  assert.ok(!JSON.stringify(out).includes("jane@x.com"));
});

test("personal data is also gone from fingerprints' source text, errors and the alert email", () => {
  assert.equal(fingerprintFor("email", "invalid to: jane@x.com"), fingerprintFor("email", "invalid to: bob@y.org"), "same problem for different people");
  assert.ok(!describeError({ code: "23505", message: "duplicate key", details: "Key (email)=(jane@x.com) already exists." }).includes("jane@x.com"));
});
