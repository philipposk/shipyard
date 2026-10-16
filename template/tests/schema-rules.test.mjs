// Guards the rules in AGENTS.md: every table has privacy rules (RLS) and is listed in supabase/isolation.json,
// so `verify` checks that one person cannot read another's rows. Runs in CI on every pull request.
// The rules themselves live in schema-rules-lib.mjs and are tested on bad examples in schema-rules-checker.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProblems, relations } from "./schema-rules-lib.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const sqlByFile = new Map(files.map((f) => [f, readFileSync(path.join(migrationsDir, f), "utf8")]));
const allSql = [...sqlByFile.values()].join("\n;\n");
const isolation = JSON.parse(readFileSync(path.join(root, "supabase", "isolation.json"), "utf8"));

test("migrations are numbered, in order, with no gaps", () => {
  files.forEach((f, i) => {
    assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, `${f} should look like 0004_name.sql`);
    assert.equal(Number(f.slice(0, 4)), i + 1, `${f} breaks the numbering`);
  });
});

test("every migration starts with a header comment", () => {
  for (const [file, sql] of sqlByFile) {
    assert.ok(sql.trimStart().startsWith("--"), `${file} needs a comment at the top saying what it does`);
  }
});

test("there is at least one table to protect", () => {
  assert.ok(relations(allSql).tables.length > 0);
});

test("isolation.json entries have a real column name", () => {
  for (const entry of isolation) assert.match(entry.ownerColumn, /^[a-z_][a-z0-9_]*$/);
});

// One check for every rule: RLS on every table (with or without "public." or quotes), every table and view listed
// in isolation.json, views run as the person asking, nothing granted or opened to anon / public, every policy names
// "to authenticated", and security definer functions are locked down.
test("the database privacy rules hold", () => {
  const problems = findProblems(allSql, isolation);
  assert.deepEqual(problems, [], `\n- ${problems.join("\n- ")}\n`);
});
