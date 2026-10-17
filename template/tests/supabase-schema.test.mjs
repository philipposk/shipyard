import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSchema } from "../src/lib/supabase/schema.mjs";
import { ensureProfileWith, defaultDisplayName } from "../src/lib/auth/ensure-profile.mjs";

test("the schema setting: empty means public, a valid name is kept, a bad one stops the app", () => {
  for (const v of [undefined, null, "", "  ", "public"]) assert.equal(resolveSchema(v), "public");
  assert.equal(resolveSchema("app_notes"), "app_notes");
  for (const bad of ["App", "app-notes", "a", "1abc", "app notes", "x".repeat(42)]) {
    assert.throws(() => resolveSchema(bad), /not a valid database schema name/);
  }
});

test("ensureProfile inserts a missing row once and never changes an existing one", async () => {
  const rows = new Map();
  const calls = [];
  const admin = {
    from(table) {
      return {
        async upsert(row, options) {
          calls.push({ table, options });
          if (!rows.has(row.id)) rows.set(row.id, row);
          return { error: null };
        },
      };
    },
  };
  const id = "3b241101-e2bb-4255-8caf-4136c566a962";
  assert.equal(await ensureProfileWith(admin, id, { email: "sam@example.com" }), true);
  rows.set(id, { ...rows.get(id), display_name: "Chosen" });
  assert.equal(await ensureProfileWith(admin, id, { email: "other@example.com" }), true);
  assert.equal(rows.get(id).display_name, "Chosen");
  assert.deepEqual(calls[0], { table: "profiles", options: { onConflict: "id", ignoreDuplicates: true } });
});

test("ensureProfile gives up quietly on a bad id or a database error", async () => {
  const failing = { from: () => ({ upsert: async () => ({ error: { message: "no" } }) }) };
  assert.equal(await ensureProfileWith(failing, "3b241101-e2bb-4255-8caf-4136c566a962"), false);
  assert.equal(await ensureProfileWith(failing, "nope"), false);
});

test("a new profile starts with the same name the sign-up trigger would give", () => {
  assert.equal(defaultDisplayName({ fullName: "Ada Lovelace", email: "ada@example.com" }), "Ada Lovelace");
  assert.equal(defaultDisplayName({ email: "ada@example.com" }), "ada");
  assert.equal(defaultDisplayName({}), "User");
});
