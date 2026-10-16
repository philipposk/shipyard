import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempParent } from "./modules-helpers.mjs";

const tmp = await tempParent();
process.env.SHIPYARD_HOME = path.join(tmp, "home");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = path.join(root, "modules");

const core = await import("../scripts/modules/core.mjs");
const { scaffold } = await import("../scripts/provision/scaffold-core.mjs");
const { findServerKeyMisuse } = await import("../scripts/verify/server-key.mjs");

after(() => rm(tmp, { recursive: true, force: true }));

const fakeRun = async () => ({ code: 0, stdout: "", stderr: "" });
const fakeProfile = {
  loadProfile: async () => ({ defaults: { layout: "bottom-nav", pwa: true }, owner: {}, apps: [] }),
  upsertApp: async (a) => a,
  getApp: async () => null,
};

async function makeApp(slug, layout = "bottom-nav") {
  const parent = path.join(tmp, `parent-${slug}`);
  await mkdir(parent, { recursive: true });
  await scaffold({ slug, name: "Shop Front", description: "A shop for handmade things.", parent, layout }, { run: fakeRun, profile: fakeProfile });
  return path.join(parent, slug);
}
async function add(appDir, name) {
  const plan = await core.planAddModule({ appDir, name }, { modulesDir: MODULES });
  assert.deepEqual(plan.blockers, [], `${name} has no blockers`);
  assert.deepEqual(plan.manual, [], `${name} needs nothing by hand`);
  assert.ok(plan.patches.every((p) => p.status === "apply"), JSON.stringify(plan.patches));
  await core.applyAddModule(plan, { profile: fakeProfile });
  return plan;
}
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, SHIPYARD_HOME: path.join(tmp, "sh-home") } });
const readIn = (appDir) => (rel) => readFile(path.join(appDir, ...rel.split("/")), "utf8");

test("errors alone: files, database file, public routes, admin menu, Health page and Health check", async () => {
  const appDir = await makeApp("shop-errors", "sidebar");
  const dry = await core.planAddModule({ appDir, name: "errors" }, { modulesDir: MODULES });
  assert.equal(dry.files.create.length, 18);
  await add(appDir, "errors");
  const read = readIn(appDir);

  assert.deepEqual(JSON.parse(await read(".shipyard-app.json")).modules, ["errors"]);
  const env = JSON.parse(await read(".shipyard-app.json")).env;
  assert.ok(env.includes("CRON_SECRET") && env.includes("ERROR_ALERT_HOURS"));
  const migrations = (await readdir(path.join(appDir, "supabase", "migrations"))).sort();
  assert.equal(migrations.at(-1), "0004_error_log.sql");
  assert.match(await read("supabase/isolation.json"), /"table": "error_log", "ownerColumn": "user_id"/);

  const proxy = await read("src/proxy.ts");
  for (const route of ["/api/errors", "/api/ops/summary"]) assert.ok(proxy.includes(`"${route}"`), route);
  assert.match(await read("src/lib/nav.ts"), /\{ href: "\/admin\/logs", label: "Error log" \}/);
  assert.match(await read("src/lib/health/checks.ts"), /\.\.\.errorsHealthChecks/);
  assert.match(await read("src/lib/health/checks.ts"), /import \{ errorsHealthChecks \} from "@\/lib\/errors\/health"/);
  assert.match(await read("src/app/admin/health/page.tsx"), /href="\/admin\/logs"/);
  assert.ok(!(await read(".env.example")).match(/CRON_SECRET=\S/), "the example file holds no value");
  assert.match(await read(".env.example"), /^CRON_SECRET=$/m);
  assert.ok(!(await readFile(path.join(appDir, ".env.local"), "utf8").catch(() => "")).includes("CRON_SECRET"), "the module does not invent a cron secret: ops setup does");

  // Adding twice does nothing.
  const again = await core.planAddModule({ appDir, name: "errors" }, { modulesDir: MODULES });
  assert.equal(again.alreadyAdded, true);
});

test("errors alone: the app's own tests, design rules and server-key rule pass", async () => {
  const appDir = path.join(tmp, "parent-shop-errors", "shop-errors");
  const tests = sh(process.execPath, ["scripts/run-tests.mjs"], appDir);
  const summary = (tests.stdout.match(/^ℹ (?:tests|pass|fail) \d+/gm) ?? []).join(" | ");
  assert.equal(tests.status, 0, `${summary}\n${tests.stdout.split("\n").filter((l) => l.includes("✖")).join("\n")}`);
  for (const file of ["errors-scrub", "errors-reporter", "errors-summary"]) {
    assert.ok(await stat(path.join(appDir, "tests", `${file}.test.mjs`)).then(() => true, () => false), file);
  }
  const design = sh(process.execPath, ["scripts/design-check.mjs"], appDir);
  assert.equal(design.status, 0, design.stdout + design.stderr);
  const found = await findServerKeyMisuse(appDir);
  assert.deepEqual(found.files, []);
  const text = await readFile(path.join(appDir, "src/lib/errors/store.ts"), "utf8");
  assert.match(text, /createSupabaseAdmin/);
});

test("errors alone: the key-leak scan finds nothing in the files the module adds", async (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) return t.skip("git is not installed");
  const appDir = path.join(tmp, "parent-shop-errors", "shop-errors");
  assert.equal(sh("git", ["init", "-q"], appDir).status, 0);
  assert.equal(sh("git", ["add", "-A"], appDir).status, 0);
  const scan = sh(process.execPath, ["scripts/secret-scan.mjs"], appDir);
  assert.equal(scan.status, 0, scan.stdout + scan.stderr);
});

test("errors together with billing and newsletter, in both orders", async () => {
  for (const order of [["errors", "billing", "newsletter"], ["newsletter", "billing", "errors"]]) {
    const appDir = await makeApp(`shop-${order[0]}-all`, "top-nav");
    for (const name of order) await add(appDir, name);
    const read = readIn(appDir);
    assert.deepEqual(JSON.parse(await read(".shipyard-app.json")).modules, order);
    const migrations = (await readdir(path.join(appDir, "supabase", "migrations"))).sort();
    assert.deepEqual(migrations.slice(-3), order.map((n, i) => `${String(4 + i).padStart(4, "0")}_${n === "errors" ? "error_log" : n}.sql`));
    const checks = await read("src/lib/health/checks.ts");
    for (const name of ["errorsHealthChecks", "billingHealthChecks", "newsletterHealthChecks"]) assert.ok(checks.includes(`...${name}`), name);
    const iso = JSON.parse(await read("supabase/isolation.json")).map((e) => e.table);
    for (const table of ["error_log", "subscriptions", "newsletter_subscribers"]) assert.ok(iso.includes(table), table);
    const proxy = await read("src/proxy.ts");
    for (const route of ["/api/errors", "/api/ops/summary", "/pricing", "/unsubscribe"]) assert.ok(proxy.includes(`"${route}"`), route);

    const tests = sh(process.execPath, ["scripts/run-tests.mjs"], appDir);
    assert.equal(tests.status, 0, (tests.stdout.match(/^ℹ (?:tests|pass|fail) \d+/gm) ?? []).join(" | ") + tests.stdout.split("\n").filter((l) => l.includes("✖")).join("\n"));
    const design = sh(process.execPath, ["scripts/design-check.mjs"], appDir);
    assert.equal(design.status, 0, design.stdout + design.stderr);
    assert.deepEqual((await findServerKeyMisuse(appDir)).files, []);
  }
});
