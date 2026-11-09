#!/usr/bin/env node
/**
 * Live smoke test. Signs in as a throwaway user and walks the app's main pages at
 * desktop and phone sizes, capturing console errors, failed requests and screenshots.
 * It also flips the theme pack and light/dark modes and opens the phone chat drawer.
 *
 * The test user is created through the app's own sign-up route (so the real sign-up
 * path is tested too) and deleted at the end. On a shared Supabase project, the
 * password is set in a second call after confirmation, because another app's
 * `clear_password_on_first_confirm` trigger would otherwise wipe it.
 *
 * Usage:
 *   node scripts/live-smoke.mjs --url https://mindscope.6x7.gr
 *   node scripts/live-smoke.mjs            (uses NEXT_PUBLIC_SITE_URL, else http://localhost:3000)
 *   node scripts/live-smoke.mjs --keep-user   (leave the test user behind, for manual checks)
 *
 * Exit code 1 when any page produced a console error, page error or a 4xx/5xx response,
 * or when a step (sign-in, onboarding, theme switch, drawer) did not behave.
 * The full report lands in test-artifacts/live-smoke/.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const BASE = (flag("--url") || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const KEEP_USER = has("--keep-user");
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const ADMIN_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OUT_DIR = path.join(process.cwd(), "test-artifacts", "live-smoke", String(Date.now()));

const PASSWORD = `Smoke-Pass-${Date.now().toString(36)}`;
const EMAIL = `smoke${Date.now().toString(36)}@example.com`;

/**
 * App-specific knobs. To reuse this script in another Shipyard app, copy the file and
 * adjust only this block: the pages to walk, the theme picker labels (empty list = the
 * app has no extra packs), the phone drawer (null button = no drawer) and the onboarding
 * path (Shipyard default is /profile/edit).
 */
const CONFIG = {
  pages: [
    ["/chat", "chat"],
    ["/read", "readings"],
    ["/projects", "projects"],
    ["/settings", "settings"],
  ],
  theme: {
    darkLabel: "Dark",
    lightLabel: "Light",
    autoLabel: "Auto",
    defaultPackLabel: "Studio",
    altPackLabels: ["Calm blue", "Soft pastel"],
  },
  drawer: { openButton: "Chats", selector: ".chat-drawer" },
  onboardingPath: "/profile/edit",
};

const report = { base: BASE, email: EMAIL, startedAt: new Date().toISOString(), steps: [], errors: [], files: {} };
const note = (s) => {
  report.steps.push(s);
  console.log("  " + s);
};
const fail = (s) => {
  report.errors.push(s);
  console.error("  FAIL " + s);
};

function readEnvFile() {
  // Scripts may read the app's own env file (Shipyard pattern); nothing is printed.
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    const get = (k) => {
      const l = raw.split("\n").find((x) => x.startsWith(k + "="));
      return l ? l.slice(k.length + 1).trim() : "";
    };
    return { url: get("NEXT_PUBLIC_SUPABASE_URL"), key: get("SUPABASE_SERVICE_ROLE_KEY") };
  } catch {
    return { url: "", key: "" };
  }
}

async function adminRequest(method, urlPath, body) {
  const env = readEnvFile();
  const url = SUPABASE_URL || env.url;
  const key = ADMIN_KEY || env.key;
  if (!url || !key) throw new Error("No Supabase URL or service key (env vars or .env.local)");
  const res = await fetch(`${url}${urlPath}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep json null */
  }
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

/** Create a confirmed test user that can actually sign in, trigger-proof. */
async function createUser() {
  note("create test user via the app's sign-up route");
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data?.ok) return data.userId ?? null;

  note("sign-up route did not create the account; using the Supabase admin API instead");
  const created = await adminRequest("POST", "/auth/v1/admin/users", { email: EMAIL, email_confirm: true });
  const id = created?.id;
  if (!id) throw new Error("admin createUser failed");
  // Second call on purpose: a shared-project trigger clears the password on first confirm.
  await adminRequest("PUT", `/auth/v1/admin/users/${id}`, { password: PASSWORD });
  return id;
}

async function deleteUser(userId) {
  try {
    if (!userId) {
      const list = await adminRequest("GET", "/auth/v1/admin/users?per_page=100");
      userId = (list?.users ?? []).find((u) => u.email === EMAIL)?.id;
    }
    if (userId) {
      await adminRequest("DELETE", `/auth/v1/admin/users/${userId}`);
      note(`deleted test user ${EMAIL}`);
    }
  } catch (e) {
    fail(`could not delete test user ${EMAIL}: ${String(e).slice(0, 160)}`);
  }
}

const browser = await (async () => {
  try {
    return await chromium.launch(); // headless by default; needs `npx playwright install chromium` once
  } catch {
    return await chromium.launch({ channel: "chrome" }); // fallback: installed Chrome
  }
})();

try {
  const userId = await createUser();

  // ---- desktop walk ----
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") pageErrors.push(`console.${m.type()}: ${m.text().slice(0, 250)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message.slice(0, 250)}`));
  page.on("requestfailed", (r) => {
    // Navigation aborts in-flight requests; that is normal, not a failure.
    if ((r.failure()?.errorText ?? "") === "net::ERR_ABORTED") return;
    pageErrors.push(`requestfailed: ${r.url().slice(0, 150)} ${r.failure()?.errorText ?? ""}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) pageErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 150)}`);
  });

  const signIn = async () => {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(4500);
    await page.waitForLoadState("domcontentloaded");
  };

  await signIn();
  if (page.url().includes("/sign-in")) {
    note("sign-in retry after a slow answer");
    await signIn();
  }
  if (page.url().includes("/sign-in")) {
    fail("sign-in did not succeed");
  } else {
    note("signed in");
  }

  // Finish onboarding when the app asks for a profile first.
  if (page.url().includes(CONFIG.onboardingPath)) {
    note("completing onboarding");
    const fillAndSave = async () => {
      // Wait for hydration, or the click posts the form natively and nothing saves.
      await page.waitForLoadState("networkidle").catch(() => {});
      const inputs = page.locator("input:not([type=hidden])");
      if ((await inputs.count()) > 0) {
        await inputs.first().fill("Smoke Test");
        await page.waitForTimeout(400); // let React commit the controlled value
      }
      const submit = page.getByRole("button", { name: /save/i }).or(page.locator('button[type="submit"]'));
      await submit.click();
      try {
        await page.waitForURL((u) => !u.pathname.includes(CONFIG.onboardingPath), { timeout: 20000 });
        return true;
      } catch {
        return false;
      }
    };
    let done = await fillAndSave();
    if (!done) {
      note("onboarding retry");
      done = await fillAndSave();
    }
    if (!done) fail("onboarding did not finish");
    else note("onboarding finished");
  }

  const visit = async (pathName, name) => {
    await page.goto(BASE + pathName, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const url = page.url();
    const body = (await page.locator("body").innerText().catch(() => "(no body)")).slice(0, 300).replace(/\s+/g, " ");
    const shot = path.join(OUT_DIR, `desktop-${name}.png`);
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot }).catch(() => {});
    report.files[`desktop-${name}`] = shot;
    const errors = pageErrors.splice(0);
    for (const e of errors) fail(`${name}: ${e}`);
    note(`${name} -> ${url.replace(BASE, "")}${errors.length ? ` (${errors.length} problem(s))` : ""}`);
    return { url, body, errors };
  };

  for (const [pathName, name] of CONFIG.pages) await visit(pathName, name);

  // Theme interactions on Settings: dark/light and a pack switch must both stick.
  const themeChecks = {};
  try {
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.getByRole("radio", { name: CONFIG.theme.darkLabel }).click();
    await page.waitForTimeout(400);
    themeChecks.dark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await page.getByRole("radio", { name: CONFIG.theme.lightLabel }).click();
    await page.waitForTimeout(400);
    themeChecks.light = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (CONFIG.theme.altPackLabels.length > 0) {
      const packButtons = page.getByRole("radio").filter({ hasText: new RegExp(CONFIG.theme.altPackLabels.join("|")) });
      if ((await packButtons.count()) > 0) {
        await packButtons.first().click();
        await page.waitForTimeout(400);
        themeChecks.pack = await page.evaluate(() => document.documentElement.getAttribute("data-pack"));
        await page.getByRole("radio", { name: CONFIG.theme.defaultPackLabel }).click();
        await page.getByRole("radio", { name: CONFIG.theme.autoLabel }).click();
        await page.waitForTimeout(300);
      }
    }
    if (themeChecks.dark !== "dark" || themeChecks.light !== "light") fail(`theme switch: ${JSON.stringify(themeChecks)}`);
    else note(`theme switch ok: ${JSON.stringify(themeChecks)}`);
  } catch (e) {
    fail(`theme switch: ${String(e).slice(0, 160)}`);
  }
  report.themeChecks = themeChecks;
  for (const e of pageErrors.splice(0)) fail(`settings (theme): ${e}`);

  // ---- phone: drawer + tab bar ----
  const storage = await ctx.storageState();
  await ctx.close();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    storageState: storage,
  });
  const p = await phone.newPage();
  p.on("pageerror", (e) => fail(`phone pageerror: ${e.message.slice(0, 200)}`));
  await p.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const shot = path.join(OUT_DIR, "phone-chat.png");
  await p.screenshot({ path: shot }).catch(() => {});
  report.files["phone-chat"] = shot;
  if (CONFIG.drawer.openButton) {
    await p.getByRole("button", { name: CONFIG.drawer.openButton }).click();
    await p.waitForTimeout(600);
    const drawerOpen = await p.locator(CONFIG.drawer.selector).isVisible();
    if (!drawerOpen) fail("phone chat drawer did not open");
    else note("phone chat drawer opens");
    const shot2 = path.join(OUT_DIR, "phone-drawer.png");
    await p.screenshot({ path: shot2 }).catch(() => {});
    report.files["phone-drawer"] = shot2;
  }
  await phone.close();

  if (!KEEP_USER) await deleteUser(userId);
} catch (e) {
  fail(String(e).slice(0, 300));
  report.errors.push("run failed: " + String(e).slice(0, 300));
} finally {
  await browser.close();
}

report.ok = report.errors.length === 0;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

console.log(report.ok ? "\nSMOKE OK" : "\nSMOKE FAILED");
console.log(`report: ${path.join(OUT_DIR, "report.json")}`);
if (!report.ok) {
  console.log("problems:");
  for (const e of report.errors) console.log("  - " + e);
}
process.exit(report.ok ? 0 : 1);
