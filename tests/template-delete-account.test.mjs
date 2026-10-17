// "Delete my account" in an app that shares its Supabase project with other apps must never delete the shared login
// (it belongs to every app there) and, through the other apps' cascading foreign keys, their data. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE } from './verify-helpers.mjs';

const core = await import(pathToFileURL(path.join(TEMPLATE, 'src/lib/account/delete-account-core.mjs')).href);

const USER = { id: '3b241101-e2bb-4255-8caf-4136c566a962', email: 'sam@example.com' };
const TABLES = [{ table: 'items', column: 'user_id' }, { table: 'profiles', column: 'id' }, { table: 'billing_customers', column: 'user_id' }];

/** A pretend server-key client that records every call. */
function fakeAdmin({ isAdmin = false, adminCount = 2, failTable = null, deleteUserError = null } = {}) {
  const calls = [];
  const admin = {
    calls,
    auth: {
      admin: {
        async deleteUser(id) {
          calls.push(['deleteUser', id]);
          return { error: deleteUserError };
        },
      },
    },
    from(table) {
      return {
        select(columns, options) {
          return {
            eq() {
              if (options?.head) return Promise.resolve({ count: adminCount });
              return { maybeSingle: async () => ({ data: { is_admin: isAdmin } }) };
            },
          };
        },
        delete() {
          return {
            async eq(column, value) {
              calls.push(['delete', table, column, value]);
              return { error: table === failTable ? { message: 'boom' } : null };
            },
          };
        },
      };
    },
  };
  return admin;
}

const run = (admin, schema, extra = {}) => core.deleteAccountCore({ admin, user: USER, schema, hooks: extra.hooks ?? [], tables: TABLES, logError: () => {} });

test('shared project (schema is not public): the sign-in user is never deleted, only this app\'s rows are', async () => {
  for (const schema of ['app_notes', 'app_x', 'anything_else']) {
    const admin = fakeAdmin();
    const result = await run(admin, schema);
    assert.deepEqual(result, { ok: true, keptLogin: true });
    assert.ok(!admin.calls.some((c) => c[0] === 'deleteUser'), `deleteUser was called for ${schema}`);
    // The person's rows in each listed table, profiles last, always filtered by this person's id.
    assert.deepEqual(admin.calls, [
      ['delete', 'items', 'user_id', USER.id],
      ['delete', 'billing_customers', 'user_id', USER.id],
      ['delete', 'profiles', 'id', USER.id],
    ]);
  }
});

test('own project (schema is public): the sign-in user is deleted, as before', async () => {
  const admin = fakeAdmin();
  assert.deepEqual(await run(admin, 'public'), { ok: true, keptLogin: false });
  assert.deepEqual(admin.calls, [['deleteUser', USER.id]]);
  const failing = fakeAdmin({ deleteUserError: { message: 'nope' } });
  const r = await run(failing, 'public');
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
});

test('the pre-delete hooks run first in both cases, and a failing hook deletes nothing', async () => {
  for (const schema of ['public', 'app_x']) {
    const order = [];
    const admin = fakeAdmin();
    const ok = await core.deleteAccountCore({
      admin, user: USER, schema, tables: TABLES, logError: () => {},
      hooks: [{ id: 'a', label: 'tidy', run: async () => { order.push('hook'); } }],
    });
    assert.equal(ok.ok, true);
    assert.equal(order[0], 'hook');
    const bad = fakeAdmin();
    const r = await core.deleteAccountCore({
      admin: bad, user: USER, schema, tables: TABLES, logError: () => {},
      hooks: [{ id: 'sub', label: 'cancel your subscription', run: async () => { throw new Error('stripe down'); } }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 502);
    assert.match(r.error, /cancel your subscription/);
    assert.deepEqual(bad.calls, [], `nothing was deleted for ${schema}`);
  }
});

test('shared project: a failing row delete stops with an error and does not touch the login', async () => {
  const admin = fakeAdmin({ failTable: 'billing_customers' });
  const r = await run(admin, 'app_x');
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.ok(!admin.calls.some((c) => c[0] === 'deleteUser'));
  assert.ok(!admin.calls.some((c) => c[1] === 'profiles'), 'profiles (the last step) was not reached');
});

test('the last admin is protected in both cases, before anything is deleted', async () => {
  for (const schema of ['public', 'app_x']) {
    const admin = fakeAdmin({ isAdmin: true, adminCount: 1 });
    const r = await run(admin, schema);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.deepEqual(admin.calls, []);
  }
});

test('deleteOwnRows refuses names that are not plain table and column names', async () => {
  const admin = fakeAdmin();
  const r = await core.deleteOwnRows(admin, USER.id, [{ table: 'items; drop table x', column: 'user_id' }]);
  assert.equal(r.ok, false);
  assert.deepEqual(admin.calls, []);
});

test('the app wires it up: the wrapper never calls deleteUser, the route reports keptLogin, the page says the login stays', async () => {
  const read = (rel) => readFile(path.join(TEMPLATE, ...rel.split('/')), 'utf8');
  const wrapper = await read('src/lib/auth/delete-account.ts');
  assert.doesNotMatch(wrapper, /deleteUser/);
  assert.match(wrapper, /schema: SUPABASE_SCHEMA/);
  assert.match(wrapper, /tables: ACCOUNT_DATA_TABLES/);
  const lib = await read('src/lib/account/delete-account-core.mjs');
  assert.equal((lib.match(/deleteUser\(/g) ?? []).length, 1, 'deleteUser is called in exactly one place');
  assert.ok(lib.indexOf('schema !== "public"') < lib.indexOf('deleteUser('));
  assert.match(await read('src/app/api/account/delete/route.ts'), /keptLogin: result\.keptLogin/);
  assert.match(await read('src/components/DeleteAccountSection.tsx'), /data\.keptLogin \? "\/\?notice=account-data-deleted"/);
  assert.match(await read('src/app/page.tsx'), /account-data-deleted/);
  const tables = await read('src/lib/account/pre-delete.ts');
  assert.match(tables, /export const ACCOUNT_DATA_TABLES: AccountDataTable\[\] = \[/);
  assert.match(tables, /\{ table: "items", column: "user_id" \}/);
  assert.match(tables, /\{ table: "profiles", column: "id" \}/);
  assert.match(await read('AGENTS.md'), /ACCOUNT_DATA_TABLES/);
});

test('every module that stores personal data adds its tables to ACCOUNT_DATA_TABLES', async () => {
  for (const [mod, tables] of [['billing', ['billing_customers', 'subscriptions']], ['newsletter', ['newsletter_subscribers']], ['errors', ['error_log']]]) {
    const manifest = JSON.parse(await readFile(path.join(TEMPLATE, '..', 'modules', mod, 'module.json'), 'utf8'));
    const entries = manifest.patches.filter((p) => p.array === 'ACCOUNT_DATA_TABLES');
    assert.deepEqual(entries.map((p) => p.entry).sort(), tables.map((t) => `{ table: "${t}", column: "user_id" }`).sort(), mod);
    for (const p of entries) assert.equal(p.file, 'src/lib/account/pre-delete.ts');
  }
});
