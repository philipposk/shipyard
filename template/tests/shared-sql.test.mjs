// Your migrations must be safe to move into their own schema inside a Supabase project shared with other apps.
// Rules (see shared-sql-lib.mjs): every object is written with its schema (`public.items`), and no trigger is added
// on auth.users except the one in 0001_profiles.sql between the shipyard:auth-trigger markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { START, END, lintSql } from "./shared-sql-lib.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

test("there are migrations to check", () => {
  assert.ok(files.length > 0);
});

for (const name of files) {
  test(`${name}: every object has its schema in front, and no stray auth.users trigger`, () => {
    const sql = readFileSync(path.join(dir, name), "utf8");
    const problems = lintSql(sql, { allowAuthTrigger: name === "0001_profiles.sql" });
    assert.deepEqual(problems, [], `${name}:\n  ${problems.join("\n  ")}`);
  });
}

test("0001_profiles.sql keeps its sign-up trigger between the shipyard:auth-trigger markers", () => {
  const sql = readFileSync(path.join(dir, "0001_profiles.sql"), "utf8");
  const start = sql.indexOf(START);
  const end = sql.indexOf(END);
  assert.ok(start !== -1 && end > start, "the markers must stay, in this order");
  const block = sql.slice(start, end);
  assert.match(block, /create trigger on_auth_user_created/);
  assert.match(block, /create or replace function public\.handle_new_user\(\)/);
});
