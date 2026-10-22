import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootScript, checkPacks, mockPage, packsCss } from "../scripts/design/packs.mjs";

const light = { bg: "#ffffff", surface: "#f8f8f8", text: "#111111", muted: "#555555", border: "#dddddd", accent: "#0f766e", onAccent: "#ffffff" };
const dark = { bg: "#0b0b0b", surface: "#161616", text: "#f2f2f2", muted: "#a3a3a3", border: "#2a2a2a", accent: "#2dd4bf", onAccent: "#042f2e" };
const pack = (id, extra = {}) => ({ id, label: id, preview: `/themes/${id}.png`, tokens: { light, dark }, ...extra });
const CLI = new URL("../scripts/theme-packs.mjs", import.meta.url).pathname;

test("a good pair passes", () => assert.deepEqual(checkPacks([pack("classic"), pack("noir")], { defaultId: "classic" }), []));

test("a missing mode fails", () => {
  const p = pack("noir"); delete p.tokens.light;
  assert.match(checkPacks([p]).join("\n"), /missing the light version/);
});

test("a forced mode fails", () => assert.match(checkPacks([pack("x", { mode: "dark" })]).join("\n"), /never forces/));

test("low contrast fails, duplicate id and unknown default fail", () => {
  const p = pack("low"); p.tokens = { light: { ...light, muted: "#bbbbbb" }, dark };
  const out = checkPacks([p, pack("low")], { defaultId: "nope" }).join("\n");
  assert.match(out, /muted on bg/);
  assert.match(out, /used twice/);
  assert.match(out, /default pack "nope"/);
});

test("css gives every pack both modes, default owns bare root", () => {
  const css = packsCss([pack("classic"), pack("noir")], "classic");
  for (const id of ["classic", "noir"]) for (const m of ["light", "dark"]) assert.ok(css.includes(`[data-pack="${id}"][data-theme="${m}"]`));
  assert.ok(css.includes(':root:not([data-pack])[data-theme="dark"]'));
  assert.ok(!css.includes(':root:not([data-pack])[data-theme="dark"],:root[data-pack="noir"]'));
});

function runBoot(store, prefersDark = false) {
  const attrs = {};
  const g = {
    localStorage: { getItem: (k) => store[k] ?? null },
    matchMedia: () => ({ matches: prefersDark }),
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  };
  Function("localStorage", "matchMedia", "document", bootScript({ ids: ["classic", "noir"], defaultId: "classic" }))(g.localStorage, g.matchMedia, g.document);
  return attrs;
}

test("boot script: default, saved pack and mode, auto, junk", () => {
  assert.deepEqual(runBoot({}), { "data-pack": "classic", "data-theme": "light" });
  assert.deepEqual(runBoot({}, true), { "data-pack": "classic", "data-theme": "dark" });
  assert.deepEqual(runBoot({ "theme-pack": "noir", theme: "light" }, true), { "data-pack": "noir", "data-theme": "light" });
  assert.deepEqual(runBoot({ "theme-pack": "__proto__", theme: "x" }), { "data-pack": "classic", "data-theme": "light" });
});

test("mock page escapes and shows both modes with the pick sentence", () => {
  const html = mockPage({ app: "A<b>", directions: [{ name: "Quiet", tokens: { light, dark } }] });
  assert.ok(html.includes("A&lt;b&gt;"));
  assert.ok(html.includes("Shipyard: use direction A for A&lt;b&gt;"));
  assert.equal((html.match(/class="mock"/g) || []).length, 2);
});

test("CLI check exits 1 on a single-mode pack and 0 on good packs", () => {
  const dir = mkdtempSync(join(tmpdir(), "packs-"));
  const bad = pack("noir"); delete bad.tokens.dark;
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ packs: [bad] }));
  writeFileSync(join(dir, "good.json"), JSON.stringify({ defaultId: "classic", packs: [pack("classic")] }));
  assert.equal(spawnSync("node", [CLI, "check", join(dir, "bad.json")]).status, 1);
  assert.match(execFileSync("node", [CLI, "check", join(dir, "good.json")], { encoding: "utf8" }), /OK/);
  assert.match(execFileSync("node", [CLI, "boot", join(dir, "good.json")], { encoding: "utf8" }), /data-pack/);
});

// A nested node --test reports to the parent and exits 0 unless this is cleared.
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;

test("the app template test passes on the template registry and fails on a single-mode entry", () => {
  const tpl = new URL("../skills/design/templates/theme-packs/", import.meta.url).pathname;
  const app = mkdtempSync(join(tmpdir(), "app-"));
  mkdirSync(join(app, "src/lib"), { recursive: true }); mkdirSync(join(app, "tests"));
  cpSync(join(tpl, "theme-packs.ts"), join(app, "src/lib/theme-packs.ts"));
  cpSync(join(tpl, "theme-packs.test.mjs"), join(app, "tests/theme-packs.test.mjs"));
  assert.equal(spawnSync("node", ["--test", join(app, "tests/theme-packs.test.mjs")], { env: childEnv }).status, 0);
  const f = join(app, "src/lib/theme-packs.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace(/\n\s*dark: \{[^}]*\},/, ""));
  assert.equal(spawnSync("node", ["--test", join(app, "tests/theme-packs.test.mjs")], { env: childEnv }).status, 1);
});
