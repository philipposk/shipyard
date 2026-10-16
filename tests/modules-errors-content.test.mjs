import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { statements, findProblems } from "../template/tests/schema-rules-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(root, "modules", "errors");
const core = await import("../scripts/modules/core.mjs");
const { SERVER_KEY_ALLOWED, isAllowedForServerKey } = await import("../scripts/verify/server-key.mjs");

const read = (rel) => readFile(path.join(MOD, "files", ...rel.split("/")), "utf8");
const sql = await readFile(path.join(MOD, "migrations", "error_log.sql"), "utf8");
const { manifest } = await core.loadModule("errors", path.join(root, "modules"));

test("errors: module.json is valid and says what the spec says", () => {
  assert.deepEqual(core.validateManifest(manifest, "errors"), []);
  assert.deepEqual(manifest.env.optional.sort(), ["CRON_SECRET", "ERROR_ALERT_HOURS"]);
  assert.deepEqual(manifest.env.required ?? [], []);
  assert.deepEqual(manifest.perAppSecrets ?? [], []);
  assert.equal(manifest.nav, undefined, "no menu item: the log is reached from Health and the admin menu");
  assert.deepEqual([...manifest.proxyPublic].sort(), ["/api/errors", "/api/ops/summary"]);
  assert.deepEqual(manifest.isolation.map((i) => i.table), ["error_log"]);
  assert.equal(manifest.isolation[0].seed, "server");
  assert.ok(manifest.patches.some((p) => p.file === "src/lib/health/checks.ts" && p.array === "HEALTH_CHECKS"));
  assert.ok(manifest.patches.some((p) => p.file === "src/lib/nav.ts" && p.array === "ADMIN_LINKS"));
  assert.ok(manifest.patches.some((p) => p.file === "src/app/admin/health/page.tsx"));
});

test("errors: the table has the columns the spec lists, privacy rules on, nothing for signed-in or signed-out people", () => {
  assert.match(sql, /create table if not exists public\.error_log/);
  for (const col of ["id bigint generated always as identity primary key", "created_at timestamptz not null default now()", "area text", "fingerprint text", "message text", "user_id uuid references auth.users \\(id\\) on delete set null", "detail jsonb", "resolved_at timestamptz"]) {
    assert.match(sql, new RegExp(col), col);
  }
  assert.match(sql, /create index if not exists \w+ on public\.error_log \(fingerprint, created_at/);
  assert.match(sql, /alter table public\.error_log enable row level security/);
  assert.match(sql, /revoke all on public\.error_log from anon, authenticated/);
  assert.doesNotMatch(sql, /create policy/i, "no policy on purpose: service role only");
  assert.deepEqual(findProblems(sql, manifest.isolation), [], "passes the app's own privacy rules");
});

test("errors: the clean-up function is locked down and the 90-day rule is in it", () => {
  assert.match(sql, /create or replace function public\.error_log_delete_old\(\)/);
  assert.match(sql, /interval '90 days'/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /revoke execute on function public\.error_log_delete_old\(\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.error_log_delete_old\(\) to service_role/);
});

test("errors: pg_cron is never required. Switching it on and scheduling are guarded, and a failure only prints a notice", () => {
  const all = statements(sql);
  // Outside the DO block there is no mention of the cron extension or schema at all.
  const outside = all.filter((s) => !/^do \$\$/i.test(s));
  assert.ok(outside.every((s) => !/pg_cron|cron\./i.test(s)), "the plain statements never touch pg_cron");
  const doBlock = sql.slice(sql.indexOf("do $$"));
  assert.match(doBlock, /pg_available_extensions where name = 'pg_cron'/, "only tries when the project offers the extension");
  assert.match(doBlock, /pg_extension where extname = 'pg_cron'/, "only schedules when it is on");
  assert.match(doBlock, /create extension if not exists pg_cron with schema pg_catalog/, "Supabase's documented install line");
  assert.match(doBlock, /cron\.schedule\(''error-log-retention'', ''41 3 \* \* \*'', ''select public\.error_log_delete_old\(\)''\)/, "named job, so running again updates it");
  assert.equal((doBlock.match(/exception when others then/g) ?? []).length, 2, "both the switch-on and the scheduling are caught");
  assert.match(doBlock, /raise notice/);
  // The SQL runs through execute, so a project without the cron schema still compiles the block.
  assert.doesNotMatch(doBlock.replace(/execute '[^\n]*'/g, ""), /\bcron\.schedule/);
});

test("errors: no key is kept outside the server key file", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(path.join(MOD, "files", "src"));
  const users = [];
  for (const f of files) {
    const text = (await readFile(f, "utf8")).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    if (/@\/lib\/admin["']|createSupabaseAdmin|SUPABASE_SERVICE_ROLE_KEY/.test(text)) users.push(path.relative(path.join(MOD, "files", "src"), f).split(path.sep).join("/"));
  }
  assert.deepEqual(users, ["lib/errors/store.ts"]);
  assert.ok(SERVER_KEY_ALLOWED.includes("lib/errors/store.ts"));
  assert.equal(isAllowedForServerKey("lib/errors/store.ts"), true);
  assert.equal(isAllowedForServerKey("lib/errors/report.ts"), false);
});

test("errors: routes check what they must, in the right order", async () => {
  const errors = await read("src/app/api/errors/route.ts");
  assert.ok(errors.indexOf("isSameOrigin") < errors.indexOf("perAddress.hit"), "same-origin first, then the per-address limit");
  assert.ok(errors.indexOf("perAddress.hit") < errors.indexOf("request.text()"), "limit before reading the body");
  assert.match(errors, /MAX_REPORT_BYTES/);
  assert.match(errors, /parseClientReport/);
  assert.doesNotMatch(errors, /fingerprint:\s*(?:body|raw|parsed)/, "the browser does not choose the fingerprint");
  // Anyone can post here, so nothing they write may reach the owner's inbox, and the totals are capped.
  assert.match(errors, /\.\.\.clientAlert\(\)/, "the alert email is the generic one");
  assert.doesNotMatch(errors.replace(/\/\/.*$/gm, ""), /subject:|summary:|emailMessage:/ , "no hand-written subject or summary built from the request");
  assert.ok(!/subject:[^\n]*\$\{/.test(errors), "no page name in the subject");
  assert.match(errors, /overall\.hit\("all"\)/, "a cap for all visitors together");
  assert.ok(errors.indexOf("perAddress.hit") < errors.indexOf("overall.hit") && errors.indexOf("overall.hit") < errors.indexOf("request.text()"));

  const summary = await read("src/app/api/ops/summary/route.ts");
  assert.ok(summary.indexOf("checkCronAccess") < summary.indexOf("runChecks(") && summary.indexOf("checkCronAccess") < summary.indexOf("countRows"), "the secret is checked before anything runs");
  assert.match(summary, /x-cron-secret/);
  assert.match(summary, /no-store/);
  assert.doesNotMatch(summary.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""), /\.detail|\.label|\.fix|message/, "no messages or names in the answer");

  const resolve = await read("src/app/api/admin/errors/resolve/route.ts");
  assert.ok(resolve.indexOf("isSameOrigin") < resolve.indexOf("getLogsAdmin"));
  assert.match(resolve, /status: 404/);

  const page = await read("src/app/admin/logs/page.tsx");
  assert.match(page, /if \(!admin\) notFound\(\)/);
  assert.match(page, /robots: \{ index: false/);
});

test("errors: the crash screens are client components, and the app-level one brings its own html and styles", async () => {
  const page = await read("src/app/error.tsx");
  const app = await read("src/app/global-error.tsx");
  assert.match(page, /^"use client"/);
  assert.match(app, /^"use client"/);
  assert.match(app, /<html[^>]*>[\s\S]*<body>/);
  assert.match(app, /import "\.\/globals\.css"/);
  const screen = await read("src/components/errors/ErrorScreen.tsx");
  assert.match(screen, /Try again/);
  assert.match(screen, /reportClientError/);
});

test("errors: the Health result names are the ones the spec asks for", async () => {
  const health = await read("src/lib/errors/health.ts");
  assert.match(health, /id: "errors-24h"/);
  const { errorsResult } = await import(pathToFileURL(path.join(MOD, "files", "src", "lib", "errors", "core.mjs")).href);
  assert.deepEqual([0, 1, 50, 51].map((n) => errorsResult(n).status), ["ok", "warn", "warn", "fail"]);
});

test("errors: the reporter wiring sends the Resend Idempotency-Key header and never the key into logs", async () => {
  const report = await read("src/lib/errors/report.ts");
  assert.match(report, /"Idempotency-Key": email\.idempotencyKey/);
  assert.match(report, /ERROR_ALERT_HOURS|createReporter/);
  assert.doesNotMatch(report, /console\./);
});
