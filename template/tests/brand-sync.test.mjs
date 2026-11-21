// The app's name is set once, in src/lib/constants.ts. These tests check that the copies in files that can not
// read code (the manifest and llms.txt) follow it, and that `npm run sync:brand` keeps them in step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBrand, syncManifest, syncLlms, syncApp } from "../scripts/sync-brand.mjs";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Written as "<" + "APP_..." so that Shipyard does not fill them in when it copies this file into an app.
const P = (key) => `<${"APP"}_${key}>`;
const constants = (name, short, description) =>
  [`export const SITE_NAME = ${JSON.stringify(name)};`, `export const SITE_SHORT_NAME = ${JSON.stringify(short)};`, `export const SITE_DESCRIPTION = ${JSON.stringify(description)};`].join("\n");

test("this app's manifest and llms.txt match constants.ts (run npm run sync:brand if this fails)", () => {
  const result = syncApp(APP, { check: true });
  assert.deepEqual(result.changed, [], `Out of date: ${result.changed.join(", ")}. Run: npm run sync:brand`);
});

test("readBrand: real values are read, quotes are decoded, placeholders mean not filled in yet", () => {
  assert.deepEqual(readBrand(constants('Tom\'s "Box"', "Box", "Saves things.")), { name: 'Tom\'s "Box"', shortName: "Box", description: "Saves things." });
  assert.equal(readBrand(constants(P("NAME"), P("SHORT_NAME"), P("DESCRIPTION"))), null);
  assert.equal(readBrand('export const SITE_NAME = "Only a name";'), null);
});

test("syncManifest: changes name, short_name and description only, and keeps the rest", () => {
  const before = `${JSON.stringify({ name: "Old", short_name: "Old", description: "Old words.", theme_color: "#ffffff", icons: [{ src: "/i.png" }] }, null, 2)}\n`;
  const after = JSON.parse(syncManifest(before, { name: "New Name", shortName: "New", description: "New words." }));
  assert.deepEqual(after, { name: "New Name", short_name: "New", description: "New words.", theme_color: "#ffffff", icons: [{ src: "/i.png" }] });
  const same = syncManifest(before, { name: "Old", shortName: "Old", description: "Old words." });
  assert.equal(same, before, "nothing to change gives the same text back");
});

test("syncLlms: the title and summary follow the brand, the page list stays", () => {
  const before = "# Old\n\n> Old words.\n\n## Pages\n- /: Home\n";
  assert.equal(syncLlms(before, { name: "New", description: "New words." }), "# New\n\n> New words.\n\n## Pages\n- /: Home\n");
  assert.equal(syncLlms("## Pages\n", { name: "New", description: "D." }), "# New\n\n> D.\n\n## Pages\n");
});

test("syncApp: a rename in constants.ts reaches both manifests and llms.txt; --check writes nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "brand-sync-"));
  try {
    mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    mkdirSync(path.join(dir, "public"), { recursive: true });
    writeFileSync(path.join(dir, "src", "lib", "constants.ts"), constants("Recipe Box", "Recipes", "Save recipes."));
    const manifest = `${JSON.stringify({ name: "Old", short_name: "Old", description: "Old." }, null, 2)}\n`;
    writeFileSync(path.join(dir, "public", "manifest.webmanifest"), manifest);
    writeFileSync(path.join(dir, "public", "manifest-dark.webmanifest"), manifest);
    writeFileSync(path.join(dir, "public", "llms.txt"), "# Old\n\n> Old.\n");

    const check = syncApp(dir, { check: true });
    assert.deepEqual(check.changed, ["public/manifest-dark.webmanifest", "public/manifest.webmanifest", "public/llms.txt"]);
    assert.equal(readFileSync(path.join(dir, "public", "llms.txt"), "utf8"), "# Old\n\n> Old.\n", "--check changes nothing");

    syncApp(dir);
    for (const f of ["manifest.webmanifest", "manifest-dark.webmanifest"]) {
      const m = JSON.parse(readFileSync(path.join(dir, "public", f), "utf8"));
      assert.equal(m.name, "Recipe Box");
      assert.equal(m.short_name, "Recipes");
      assert.equal(m.description, "Save recipes.");
    }
    assert.equal(readFileSync(path.join(dir, "public", "llms.txt"), "utf8"), "# Recipe Box\n\n> Save recipes.\n");
    assert.deepEqual(syncApp(dir, { check: true }).changed, [], "in step after the sync");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncApp: does nothing while constants.ts still holds the template placeholders", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "brand-sync-"));
  try {
    mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    writeFileSync(path.join(dir, "src", "lib", "constants.ts"), constants(P("NAME"), P("SHORT_NAME"), P("DESCRIPTION")));
    const r = syncApp(dir);
    assert.equal(r.brand, null);
    assert.ok(r.skipped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json runs the sync before dev and build", () => {
  const pkg = JSON.parse(readFileSync(path.join(APP, "package.json"), "utf8"));
  assert.equal(pkg.scripts["sync:brand"], "node scripts/sync-brand.mjs");
  assert.equal(pkg.scripts.predev, "node scripts/sync-brand.mjs");
  assert.equal(pkg.scripts.prebuild, "node scripts/sync-brand.mjs");
});
