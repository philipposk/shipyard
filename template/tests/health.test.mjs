import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks, summarize, STATUS_WORDS } from "../src/lib/health/run.mjs";
import { createTemplateChecks, senderDomain } from "../src/lib/health/template-checks.mjs";

// ---- the runner ------------------------------------------------------------------------------------

test("runChecks keeps order, runs all, and turns crashes and nonsense into failures", async () => {
  const results = await runChecks([
    { id: "a", label: "A", run: async () => ({ status: "ok", detail: "fine" }) },
    { id: "b", label: "B", run: async () => { throw new Error("it broke\nbadly"); } },
    { id: "c", label: "C", run: async () => ({ status: "great", detail: "?" }) },
    { id: "d", label: "D", run: async () => null },
    { id: "e", label: "E", run: async () => ({ status: "warn", detail: "hmm", fix: "do this" }) },
  ]);
  assert.deepEqual(results.map((r) => r.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(results.map((r) => r.status), ["ok", "fail", "fail", "fail", "warn"]);
  assert.match(results[1].detail, /it broke badly/, "line breaks are flattened");
  assert.equal(results[4].fix, "do this");
  assert.equal("fix" in results[0], false);
});

test("runChecks stops a slow check after the time limit, and aborts its signal", async () => {
  let aborted = false;
  const started = Date.now();
  const results = await runChecks(
    [
      { id: "slow", label: "Slow", run: ({ signal }) => new Promise(() => signal.addEventListener("abort", () => { aborted = true; })) },
      { id: "fast", label: "Fast", run: async () => ({ status: "ok", detail: "ok" }) },
    ],
    { timeoutMs: 30 }
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(results[0].status, "fail");
  assert.match(results[0].detail, /no answer after/);
  assert.equal(results[1].status, "ok");
  assert.equal(aborted, true);
});

test("summarize counts and writes one plain sentence", () => {
  const s = summarize([{ status: "ok" }, { status: "warn" }, { status: "warn" }, { status: "fail" }, { status: "skip" }]);
  assert.deepEqual(s.counts, { ok: 1, warn: 2, fail: 1, skip: 1 });
  assert.equal(s.headline, "1 problem, 2 warnings");
  assert.equal(summarize([{ status: "ok" }]).headline, "Everything checked looks good");
  assert.deepEqual(Object.keys(STATUS_WORDS), ["ok", "warn", "fail", "skip"]);
});

// ---- the template checks ---------------------------------------------------------------------------

const SECRET = "sk-SENTINEL-do-not-leak-0123456789";
const goodLegal = {
  controller: { name: "Acme Ltd", address: "1 Road, Town", email: "legal@acme.test", country: "Greece" },
  privacy: [{ id: "a", title: "A", paragraphs: ["Fine."] }],
  terms: [{ id: "b", title: "B", paragraphs: ["Fine."] }],
};
const emptyLegal = { ...goodLegal, controller: { name: "", address: "", email: "", country: "" } };

function res(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function build(over = {}) {
  const calls = [];
  const env = {
    NODE_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
    SUPABASE_SERVICE_ROLE_KEY: SECRET,
    RESEND_API_KEY: SECRET,
    RESEND_FROM: "App <noreply@send.acme.test>",
    ...over.env,
  };
  const checks = createTemplateChecks({
    env,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return (over.fetch ?? defaultFetch)(String(url), init);
    },
    siteUrl: over.siteUrl ?? "https://app.acme.test",
    signupMode: over.signupMode ?? "verified",
    contactEmail: over.contactEmail ?? "hello@acme.test",
    legal: over.legal ?? goodLegal,
    queryDatabase: over.queryDatabase ?? (async () => ({ ok: true })),
  });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  return { checks, byId, calls };
}

function defaultFetch(url) {
  if (url.endsWith("/auth/v1/settings")) return res(200, { mailer_autoconfirm: false });
  if (url === "https://api.resend.com/domains") return res(200, { data: [{ name: "send.acme.test", status: "verified" }] });
  if (url.endsWith("/api/health")) {
    return res(200, {}, { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "x", "content-security-policy": "frame-ancestors 'none'", "permissions-policy": "camera=()" });
  }
  return res(404, {});
}

const run = (check) => check.run({ signal: new AbortController().signal });

test("the template ships the checks the spec lists, in a stable order", () => {
  const { checks } = build();
  assert.deepEqual(checks.map((c) => c.id), ["database", "signup-mode", "site-url", "contact-email", "legal-controller", "email-sending", "security-headers"]);
  for (const c of checks) assert.ok(c.label && typeof c.run === "function");
});

test("database: ok when the probe works, fail with a fix when not, fail when Supabase settings are missing", async () => {
  assert.equal((await run(build().byId.database)).status, "ok");
  const bad = await run(build({ queryDatabase: async () => ({ ok: false, message: "42501" }) }).byId.database);
  assert.equal(bad.status, "fail");
  assert.match(bad.detail, /42501/);
  assert.ok(bad.fix);
  const none = await run(build({ env: { NEXT_PUBLIC_SUPABASE_URL: "" } }).byId.database);
  assert.equal(none.status, "fail");
  assert.match(none.fix, /NEXT_PUBLIC_SUPABASE_URL/);
});

test("signup-mode: starter warns 'anyone can sign up without confirming their email'", async () => {
  const r = await run(build({ signupMode: "starter" }).byId["signup-mode"]);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /Anyone can sign up without confirming their email/);
  assert.match(r.fix, /NEXT_PUBLIC_SIGNUP_MODE=verified/);
});

test("signup-mode: verified is ok, but fails if Supabase auto-confirms and warns if it cannot tell", async () => {
  assert.equal((await run(build().byId["signup-mode"])).status, "ok");
  const auto = await run(build({ fetch: (u) => (u.endsWith("/auth/v1/settings") ? res(200, { mailer_autoconfirm: true }) : defaultFetch(u)) }).byId["signup-mode"]);
  assert.equal(auto.status, "fail");
  assert.match(auto.fix, /Confirm email/);
  const unknown = await run(build({ fetch: () => res(500, {}) }).byId["signup-mode"]);
  assert.equal(unknown.status, "warn");
});

test("site-url: localhost in production fails, vercel.app warns, custom https domain is ok, building locally skips", async () => {
  const local = await run(build({ siteUrl: "http://localhost:3000" }).byId["site-url"]);
  assert.equal(local.status, "fail");
  assert.match(local.detail, /localhost/);
  assert.equal((await run(build({ siteUrl: "https://my-app.vercel.app" }).byId["site-url"])).status, "warn");
  assert.equal((await run(build({ siteUrl: "http://app.acme.test" }).byId["site-url"])).status, "fail");
  assert.equal((await run(build().byId["site-url"])).status, "ok");
  assert.equal((await run(build({ env: { NODE_ENV: "development" }, siteUrl: "http://localhost:3000" }).byId["site-url"])).status, "skip");
  // On Vercel, VERCEL_ENV decides: a preview deployment is not production.
  assert.equal((await run(build({ env: { VERCEL_ENV: "preview" }, siteUrl: "http://localhost:3000" }).byId["site-url"])).status, "skip");
  assert.equal((await run(build({ env: { VERCEL_ENV: "production" }, siteUrl: "http://localhost:3000" }).byId["site-url"])).status, "fail");
});

test("contact-email: set is ok; missing or malformed warns with what to set", async () => {
  assert.equal((await run(build().byId["contact-email"])).status, "ok");
  const none = await run(build({ contactEmail: "", legal: emptyLegal }).byId["contact-email"]);
  assert.equal(none.status, "warn");
  assert.match(none.fix, /NEXT_PUBLIC_CONTACT_EMAIL/);
  const bad = await run(build({ contactEmail: "not-an-email", legal: emptyLegal }).byId["contact-email"]);
  assert.equal(bad.status, "warn");
  assert.match(bad.detail, /does not look like/);
  assert.equal((await run(build({ contactEmail: "", legal: goodLegal }).byId["contact-email"])).status, "ok", "the generated controller email counts");
});

test("legal-controller: complete is ok and still carries the 'draft' reminder; empty warns with the missing fields", async () => {
  const good = await run(build().byId["legal-controller"]);
  assert.equal(good.status, "ok");
  assert.match(good.detail, /draft/);
  const empty = await run(build({ legal: emptyLegal }).byId["legal-controller"]);
  assert.equal(empty.status, "warn");
  assert.match(empty.detail, /name, address, contact email, country/);
  assert.match(empty.detail, /draft/);
  const placeholder = await run(build({ legal: { ...goodLegal, privacy: [{ id: "a", title: "Who", paragraphs: ["Run by [COMPANY]."] }] } }).byId["legal-controller"]);
  assert.equal(placeholder.status, "warn");
  assert.match(placeholder.detail, /unfinished text in Who/);
  const broken = await run(build({ legal: { ...goodLegal, terms: [] } }).byId["legal-controller"]);
  assert.equal(broken.status, "warn");
});

test("email-sending: skip without a key; verified domain ok; unverified, unknown, test sender, send-only key and outage all warn", async () => {
  assert.equal((await run(build({ env: { RESEND_API_KEY: "" } }).byId["email-sending"])).status, "skip");

  const calls = build();
  const ok = await run(calls.byId["email-sending"]);
  assert.equal(ok.status, "ok");
  assert.match(ok.detail, /send\.acme\.test/);
  const call = calls.calls.find((c) => c.url === "https://api.resend.com/domains");
  assert.ok(call, "asked Resend for the domain list");
  assert.equal(call.init.headers.Authorization, `Bearer ${SECRET}`, "the key goes in a header, never the URL");
  assert.ok(!call.url.includes(SECRET));

  const pending = await run(build({ fetch: (u) => (u.includes("resend") ? res(200, { data: [{ name: "send.acme.test", status: "pending" }] }) : defaultFetch(u)) }).byId["email-sending"]);
  assert.equal(pending.status, "warn");
  assert.match(pending.fix, /--check/);

  const unknown = await run(build({ fetch: (u) => (u.includes("resend") ? res(200, { data: [] }) : defaultFetch(u)) }).byId["email-sending"]);
  assert.equal(unknown.status, "warn");

  assert.equal((await run(build({ env: { RESEND_FROM: "" } }).byId["email-sending"])).status, "warn");
  assert.equal((await run(build({ env: { RESEND_FROM: "App <onboarding@resend.dev>" } }).byId["email-sending"])).status, "warn");
  assert.match((await run(build({ fetch: (u) => (u.includes("resend") ? res(401, { name: "restricted_api_key" }) : defaultFetch(u)) }).byId["email-sending"])).detail, /not allowed to list domains/);
  assert.equal((await run(build({ fetch: (u) => (u.includes("resend") ? res(500, {}) : defaultFetch(u)) }).byId["email-sending"])).status, "warn");
  assert.equal((await run(build({ fetch: (u) => { if (u.includes("resend")) throw new Error("offline"); return defaultFetch(u); } }).byId["email-sending"])).status, "warn");
});

test("email-sending: a subdomain sender matches a verified parent domain", async () => {
  const r = await run(build({ env: { RESEND_FROM: "noreply@mail.acme.test" }, fetch: (u) => (u.includes("resend") ? res(200, { data: [{ name: "acme.test", status: "verified" }] }) : defaultFetch(u)) }).byId["email-sending"]);
  assert.equal(r.status, "ok");
  assert.equal(senderDomain("App <noreply@Send.Acme.test>"), "send.acme.test");
  assert.equal(senderDomain("noreply@acme.test"), "acme.test");
  assert.equal(senderDomain("nonsense"), "");
});

test("security-headers: all present ok; missing ones named; localhost skips; unreachable skips", async () => {
  assert.equal((await run(build().byId["security-headers"])).status, "ok");
  const some = await run(build({ fetch: (u) => (u.endsWith("/api/health") ? res(200, {}, { "x-frame-options": "DENY" }) : defaultFetch(u)) }).byId["security-headers"]);
  assert.equal(some.status, "warn");
  assert.match(some.detail, /x-content-type-options/);
  assert.ok(!some.detail.includes("x-frame-options"));
  assert.equal((await run(build({ siteUrl: "http://localhost:3000" }).byId["security-headers"])).status, "skip");
  assert.equal((await run(build({ fetch: () => { throw new Error("down"); } }).byId["security-headers"])).status, "skip");
});

test("no check ever shows a secret value, in any state", async () => {
  const scenarios = [
    {},
    { signupMode: "starter", legal: emptyLegal, contactEmail: "" },
    { fetch: () => res(500, { message: SECRET }) },
    { fetch: () => { throw new Error("network down"); } },
    { queryDatabase: async () => ({ ok: false, message: "42501" }) },
  ];
  for (const over of scenarios) {
    const { checks } = build(over);
    const results = await runChecks(checks);
    const text = JSON.stringify(results);
    assert.ok(!text.includes(SECRET), "no secret in output");
    assert.ok(!text.includes("anon-key-value"), "no key in output");
  }
});
