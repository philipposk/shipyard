import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLACEHOLDER_RE,
  cleanContactEmail,
  formatLegalDate,
  missingControllerFields,
  resolveController,
  sectionsWithPlaceholders,
  validateSections,
} from "../src/lib/legal-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentSource = await readFile(path.join(here, "..", "src", "lib", "legal-content.ts"), "utf8");

/** Reads the data out of legal-content.ts without compiling TypeScript: strips the type imports/annotations and evaluates it. */
async function loadLegalContent() {
  const js = contentSource
    .replace(/^import .*$/gm, "")
    .replace(/: LegalController\b/g, "")
    .replace(/: LegalSection\[\]/g, "")
    .replace(/\bexport const (\w+)/g, "exports.$1");
  const exports = {};
  new Function("exports", js)(exports);
  return exports;
}

test("legal-content.ts: the starter text is valid, has no placeholders and no developer words", async () => {
  const content = await loadLegalContent();
  assert.match(content.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  // phone is optional: legal-generate adds it when the owner sells to consumers and has one.
  const keys = Object.keys(content.controller).filter((k) => k !== "phone").sort();
  assert.deepEqual(keys, ["address", "country", "email", "name"]);
  if ("phone" in content.controller) assert.equal(typeof content.controller.phone, "string");
  for (const key of ["privacy", "terms"]) {
    assert.deepEqual(validateSections(content[key]), [], `${key} sections are valid`);
    assert.deepEqual(sectionsWithPlaceholders(content[key]), [], `${key} has no placeholder text`);
  }
  const all = JSON.stringify([content.privacy, content.terms]);
  assert.ok(!all.includes("—"), "no em dashes");
  assert.ok(!/\b(RLS|JWT|API|schema|token)\b/i.test(all), "no developer words");
  assert.ok(!/draft|have it checked/i.test(all), "the public text does not carry the 'draft' note (chat, HANDOFF and the Health page do)");
});

test("legal-content.ts: privacy covers the basics the spec asks for", async () => {
  const { privacy, terms } = await loadLegalContent();
  const ids = privacy.map((s) => s.id);
  for (const id of ["what-we-collect", "who-processes-your-data", "how-long-we-keep-it", "your-rights", "cookies", "children", "contact"]) assert.ok(ids.includes(id), id);
  const table = privacy.find((s) => s.id === "who-processes-your-data").table;
  assert.ok(table.rows.some((r) => r[0] === "Supabase") && table.rows.some((r) => r[0] === "Vercel"));
  assert.ok(terms.map((s) => s.id).includes("liability"));
});

test("resolveController: empty fields fall back to the app name and the contact email, never a placeholder", () => {
  const r = resolveController({ name: "", address: "", email: "", country: "" }, { brandName: "Fake Planner", contactEmail: "hi@example.org" });
  assert.equal(r.name, "Fake Planner");
  assert.equal(r.email, "hi@example.org");
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ["name", "address", "contact email", "country"]);
  const full = resolveController({ name: " Acme Ltd ", address: "1 Road", email: "legal@acme.test", country: "Greece" }, { brandName: "Fake Planner", contactEmail: "hi@example.org" });
  assert.equal(full.name, "Acme Ltd");
  assert.equal(full.email, "legal@acme.test");
  assert.equal(full.complete, true);
  assert.deepEqual(full.missing, []);
});

test("missingControllerFields treats spaces and missing keys as empty", () => {
  assert.deepEqual(missingControllerFields({ name: "  ", email: "a@b.co" }), ["name", "address", "country"]);
  assert.deepEqual(missingControllerFields(null), ["name", "address", "contact email", "country"]);
});

test("validateSections finds structural mistakes in plain words", () => {
  const ok = { id: "a-b", title: "A", paragraphs: ["x"] };
  assert.deepEqual(validateSections([ok]), []);
  assert.match(validateSections([]).join(), /no sections/);
  assert.match(validateSections([{ ...ok, id: "Not Valid" }]).join(), /id/);
  assert.match(validateSections([ok, ok]).join(), /repeats the id/);
  assert.match(validateSections([{ ...ok, paragraphs: [""] }]).join(), /empty paragraph/);
  assert.match(validateSections([{ ...ok, title: "" }]).join(), /no title/);
  assert.match(validateSections([{ ...ok, table: { headers: ["a", "b"], rows: [["1"]] } }]).join(), /does not match/);
  assert.match(validateSections([{ ...ok, table: { headers: [], rows: [] } }]).join(), /no headers/);
});

test("placeholders are recognised", () => {
  for (const t of ["[COMPANY NAME]", "<YOUR_NAME>", "{{name}}", "Lorem ipsum dolor", "TODO write this", "to be decided TBD"]) assert.ok(PLACEHOLDER_RE.test(t), t);
  for (const t of ["We keep it for 90 days.", "Contact us [here] please", "Todo list items are yours"]) assert.ok(!PLACEHOLDER_RE.test(t), t);
  assert.deepEqual(sectionsWithPlaceholders([{ id: "a", title: "A", paragraphs: ["fine"] }, { id: "b", title: "B", paragraphs: ["Call [COMPANY]"] }]), ["B"]);
});

test("formatLegalDate and cleanContactEmail", () => {
  assert.equal(formatLegalDate("2026-10-16"), "16 October 2026");
  assert.equal(formatLegalDate("2026-01-05"), "5 January 2026");
  assert.equal(formatLegalDate("soon"), "soon");
  assert.equal(cleanContactEmail(" Me@Example.org "), "me@example.org");
  assert.equal(cleanContactEmail("nope"), "");
  assert.equal(cleanContactEmail(undefined), "");
});
