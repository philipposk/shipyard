// "Delete my account" in an app that shares its Supabase project with other apps must never delete the shared login:
// the other apps use it, and their data would go with it. Only this app's rows are deleted there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteAccountCore } from "../src/lib/account/delete-account-core.mjs";

const user = { id: "3b241101-e2bb-4255-8caf-4136c566a962", email: "sam@example.com" };
const tables = [
  { table: "items", column: "user_id" },
  { table: "profiles", column: "id" },
];

function fakeAdmin() {
  const calls = [];
  return {
    calls,
    auth: { admin: { async deleteUser(id) { calls.push(["deleteUser", id]); return { error: null }; } } },
    from(table) {
      return {
        select: (_columns, options) => ({
          eq: () => (options?.head ? Promise.resolve({ count: 2 }) : { maybeSingle: async () => ({ data: { is_admin: false } }) }),
        }),
        delete: () => ({ eq: async (column, value) => { calls.push(["delete", table, column, value]); return { error: null }; } }),
      };
    },
  };
}

const run = (admin, schema) => deleteAccountCore({ admin, user, schema, hooks: [], tables, logError: () => {} });

test("a shared project (schema is not public): the sign-in user is never deleted, only this app's rows are", async () => {
  const admin = fakeAdmin();
  assert.deepEqual(await run(admin, "app_notes"), { ok: true, keptLogin: true });
  assert.ok(!admin.calls.some((c) => c[0] === "deleteUser"));
  assert.deepEqual(admin.calls, [["delete", "items", "user_id", user.id], ["delete", "profiles", "id", user.id]]);
});

test("an app with its own project (schema is public): the sign-in user is deleted", async () => {
  const admin = fakeAdmin();
  assert.deepEqual(await run(admin, "public"), { ok: true, keptLogin: false });
  assert.deepEqual(admin.calls, [["deleteUser", user.id]]);
});
