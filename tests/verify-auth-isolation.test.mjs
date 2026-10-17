import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { check as auth } from '../scripts/verify/auth.mjs';
import { check as isolation } from '../scripts/verify/isolation.mjs';
import { startFake, tempDir, removeDir, makeAppFromTemplate, SERVER, ANON } from './verify-helpers.mjs';

async function setup(t, opts) {
  const fake = await startFake(opts);
  t.after(() => fake.close());
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await makeAppFromTemplate(dir);
  const ctx = { appDir: dir, url: fake.url, app: null, secrets: fake.secrets };
  return { fake, dir, ctx };
}
const noKeysIn = (result) => {
  const text = JSON.stringify(result);
  assert.ok(!text.includes(SERVER) && !text.includes(ANON), 'a key leaked into the result');
  assert.ok(!/\$!9a/.test(text), 'a test password leaked into the result');
};

// ---------- auth ----------

test('auth: a healthy app passes and leaves no test user behind', async (t) => {
  const { fake, ctx } = await setup(t);
  const r = await auth(ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /test user deleted/);
  assert.match(r.details.join('\n'), /no login means 401/);
  assert.equal(fake.state.users.size, 0);
  noKeysIn(r);
});

test('auth: the test user email is throwaway and the password never appears anywhere', async (t) => {
  const { fake, ctx } = await setup(t);
  const seen = [];
  const orig = fake.state.users.set.bind(fake.state.users);
  fake.state.users.set = (k, v) => { seen.push(v); return orig(k, v); };
  const r = await auth(ctx);
  assert.match(seen[0].email, /^shipyard-test-[0-9a-f]+@example\.com$/);
  assert.ok(seen[0].password.includes('$') && seen[0].password.includes('!'));
  assert.ok(!JSON.stringify(r).includes(seen[0].password));
});

test('auth: skipped without a web address or without keys', async (t) => {
  const { ctx } = await setup(t);
  assert.equal((await auth({ ...ctx, url: null })).skipped, true);
  const r = await auth({ ...ctx, secrets: new Map() });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /missing from \.env\.local/);
});

test('auth: a missing profile row (trigger not applied) fails', async (t) => {
  const { fake, ctx } = await setup(t, { noProfileTrigger: true });
  const r = await auth(ctx);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /no profile row/);
  assert.equal(fake.state.users.size, 0);
});

test('auth: wrong server key is reported without printing the key', async (t) => {
  const { ctx } = await setup(t);
  const secrets = new Map(ctx.secrets);
  secrets.set('SUPABASE_SERVICE_ROLE_KEY', 'a-wrong-server-key-123456');
  const r = await auth({ ...ctx, secrets });
  assert.equal(r.ok, false);
  assert.match(r.summary, /could not create a test user/);
  assert.match(r.problems.join('\n'), /Supabase said: 401/);
  assert.ok(!JSON.stringify(r).includes('a-wrong-server-key'));
});

test('auth: a test user that cannot be deleted is called out with the email', async (t) => {
  const { ctx } = await setup(t, { failUserDelete: true });
  const r = await auth(ctx);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /test user was NOT deleted \(shipyard-test-[0-9a-f]+@example\.com\)/);
});

test('auth: an app that is down fails clearly and still deletes the user', async (t) => {
  const { fake, ctx } = await setup(t);
  const r = await auth({ ...ctx, url: 'http://127.0.0.1:1' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /did not answer/);
  assert.equal(fake.state.users.size, 0);
});

// ---------- isolation ----------

test('isolation: the template tables pass on a correctly protected database', async (t) => {
  const { fake, ctx } = await setup(t);
  const r = await isolation(ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /items: other users cannot read it; other users cannot edit it; other users cannot delete it; nobody can create rows in another user's name; visitors who are not signed in see nothing/);
  assert.match(r.details.join('\n'), /profiles: other users cannot read it/);
  assert.equal(fake.state.users.size, 0);
  assert.equal(fake.state.items.length, 0);
  assert.equal(fake.state.profiles.length, 0);
  noKeysIn(r);
});

for (const [leak, pattern] of [
  ['read', /another signed-in user can read/],
  ['update', /another signed-in user can edit/],
  ['delete', /another signed-in user can delete/],
  ['spoof', /someone else's name/],
  ['anon', /not signed in can read rows/],
]) {
  test(`isolation: detects a ${leak} leak and still cleans up`, async (t) => {
    const { fake, ctx } = await setup(t, { leak: [leak] });
    const r = await isolation(ctx);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), pattern);
    assert.equal(fake.state.users.size, 0);
    assert.equal(fake.state.items.length, 0);
  });
}

test('isolation: a table with no rows to insert asks for an insert example', async (t) => {
  const { dir, ctx } = await setup(t);
  await writeFile(path.join(dir, 'supabase', 'isolation.json'), JSON.stringify([{ table: 'notes', ownerColumn: 'user_id' }]));
  const r = await isolation(ctx);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /notes: could not create a test row/);
  assert.match(r.problems.join('\n'), /"insert"/);
});

const serverTable = [{ table: 'subs', ownerColumn: 'user_id', seed: 'server', insert: { plan_id: 'isolation_test', status: 'active' } }];

test('isolation: a table only the server writes to (seed "server") is tested with a row made by the secret key', async (t) => {
  const { fake, dir, ctx } = await setup(t);
  await writeFile(path.join(dir, 'supabase', 'isolation.json'), JSON.stringify(serverTable));
  const r = await isolation(ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /subs: other users cannot read it; other users cannot edit it; other users cannot delete it; nobody can create rows in another user's name/);
  assert.deepEqual(r.warnings, []);
  assert.equal(fake.state.subs.length, 0, 'the test row is removed');
  assert.equal(fake.state.users.size, 0);
  noKeysIn(r);
});

for (const [leak, pattern] of [
  ['read', /subs: another signed-in user can read/],
  ['update', /subs: another signed-in user can edit/],
  ['delete', /subs: another signed-in user can delete/],
  ['spoof', /subs: a signed-in user can create rows in someone else's name/],
  ['anon', /subs: visitors who are not signed in can read rows/],
]) {
  test(`isolation: a server-seeded table that leaks on ${leak} is caught and cleaned up`, async (t) => {
    const { fake, dir, ctx } = await setup(t, { leak: [leak] });
    await writeFile(path.join(dir, 'supabase', 'isolation.json'), JSON.stringify(serverTable));
    const r = await isolation(ctx);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), pattern);
    assert.equal(fake.state.subs.length, 0);
    assert.equal(fake.state.users.size, 0);
  });
}

test('isolation: bad or missing isolation.json fails', async (t) => {
  const { dir, ctx } = await setup(t);
  const file = path.join(dir, 'supabase', 'isolation.json');
  await writeFile(file, '{ not json');
  assert.match((await isolation(ctx)).problems[0], /not valid JSON/);
  await writeFile(file, '[]');
  assert.match((await isolation(ctx)).problems[0], /no tables listed/);
  await writeFile(file, JSON.stringify([{ table: 'items;drop', ownerColumn: 'user_id' }]));
  assert.match((await isolation(ctx)).problems[0], /letters, digits and underscores/);
  const { rm } = await import('node:fs/promises');
  await rm(file);
  assert.match((await isolation(ctx)).problems[0], /isolation\.json is missing/);
});

test('isolation: skipped without Supabase keys', async (t) => {
  const { ctx } = await setup(t);
  const r = await isolation({ ...ctx, secrets: new Map() });
  assert.equal(r.skipped, true);
});

test('isolation: works without a web address (it only talks to Supabase)', async (t) => {
  const { ctx } = await setup(t);
  const r = await isolation({ ...ctx, url: null });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('isolation: an explicit "insert" example in isolation.json is used', async (t) => {
  const { dir, ctx } = await setup(t);
  await writeFile(path.join(dir, 'supabase', 'isolation.json'), JSON.stringify([{ table: 'items', ownerColumn: 'user_id', insert: { title: 'hello' } }]));
  const r = await isolation(ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ---------- cleanup problems are reported even when the test stops early ----------

test('isolation: if user B can not be created, user A is still cleaned up and a failed cleanup is reported', async (t) => {
  const { fake, ctx } = await setup(t, { failCreateAfter: 1, failUserDelete: true });
  const r = await isolation(ctx);
  assert.equal(r.ok, false);
  assert.match(r.summary, /could not create test users/);
  assert.match(r.problems.join('\n'), /NOT deleted/);
  assert.equal(fake.state.users.size, 1); // the delete was refused by the fake, so user A is still there and we said so
});

test('isolation: if user B can not be created and cleanup works, nothing is left behind', async (t) => {
  const { fake, ctx } = await setup(t, { failCreateAfter: 1 });
  const r = await isolation(ctx);
  assert.equal(r.ok, false);
  assert.ok(!r.problems.join('\n').includes('NOT deleted'));
  assert.equal(fake.state.users.size, 0);
});

// ---------- apps in their own schema (shared Supabase project) ----------

const withSchema = (ctx, schema) => {
  const secrets = new Map(ctx.secrets);
  secrets.set('NEXT_PUBLIC_SUPABASE_SCHEMA', schema);
  return { ...ctx, secrets };
};

test('isolation: an app in its own schema sends Accept-Profile on reads and Content-Profile on writes, every time', async (t) => {
  const { fake, ctx } = await setup(t);
  const r = await isolation(withSchema(ctx, 'app_notes'));
  assert.equal(r.ok, true, JSON.stringify(r));
  const calls = fake.state.restHeaders;
  assert.ok(calls.length > 20, 'the check made many database calls');
  for (const c of calls) {
    if (c.method === 'GET' || c.method === 'HEAD') {
      assert.equal(c.accept, 'app_notes', `${c.method} ${c.path} must name the schema`);
      assert.equal(c.content, null);
    } else {
      assert.equal(c.content, 'app_notes', `${c.method} ${c.path} must name the schema`);
      assert.equal(c.accept, null);
    }
  }
  assert.ok(calls.some((c) => c.method === 'POST') && calls.some((c) => c.method === 'PATCH') && calls.some((c) => c.method === 'DELETE'));
  noKeysIn(r);
});

test('isolation: an app on the public schema sends no profile headers at all', async (t) => {
  const { fake, ctx } = await setup(t);
  assert.equal((await isolation(ctx)).ok, true);
  assert.ok(fake.state.restHeaders.length > 0);
  assert.ok(fake.state.restHeaders.every((c) => c.accept === null && c.content === null));
  fake.state.restHeaders.length = 0;
  assert.equal((await isolation(withSchema(ctx, 'public'))).ok, true);
  assert.ok(fake.state.restHeaders.every((c) => c.accept === null && c.content === null), 'public means no header');
});

test('auth: works for an app in its own schema, and a missing profile row points at ensureProfile', async (t) => {
  const { fake, ctx } = await setup(t, { noProfileTrigger: true });
  const r = await auth(withSchema(ctx, 'app_notes'));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /no profile row/);
  assert.match(r.problems.join('\n'), /ensureProfile/);
  assert.ok(!/trigger from migration 0001/.test(r.problems.join('\n')));
  assert.equal(fake.state.users.size, 0);
});

test('a bad schema name in .env.local is reported, not used', async (t) => {
  const { ctx } = await setup(t);
  const r = await isolation(withSchema(ctx, 'bad name; drop'));
  assert.equal(r.skipped, true);
  assert.match(r.reason, /NEXT_PUBLIC_SUPABASE_SCHEMA/);
});

// ---------- apps in a project shared with other apps ----------

const sharedApp = { slug: 'notes', shared: true, schema: 'app_notes', supabaseRef: 'abcdefghijklmnopqrst' };

test('shared project: auth and isolation make no test user unless --allow-test-users is given', async (t) => {
  const { fake, ctx } = await setup(t);
  const shared = withSchema({ ...ctx, app: sharedApp }, 'app_notes');
  for (const check of [auth, isolation]) {
    const r = await check(shared);
    assert.equal(r.skipped, true, JSON.stringify(r));
    assert.match(r.reason, /shares its Supabase project/);
    assert.match(r.reason, /--allow-test-users/);
  }
  assert.equal(fake.state.users.size, 0);
  assert.deepEqual(fake.state.requests, [], 'nothing at all was sent to Supabase or the app');
});

test('shared project: with --allow-test-users it runs, names the number of other apps\' sign-up triggers, and cleans up', async (t) => {
  const { fake, ctx } = await setup(t);
  const shared = { ...withSchema({ ...ctx, app: sharedApp }, 'app_notes'), allowTestUsers: true, countAuthTriggers: async () => 5 };
  for (const check of [auth, isolation]) {
    const r = await check(shared);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.warnings.some((w) => /5 sign-up triggers/.test(w) && /may leave a row behind/.test(w)), JSON.stringify(r.warnings));
    noKeysIn(r);
  }
  assert.equal(fake.state.users.size, 0);
  // When the count can not be read, the warning still says it.
  const unknown = await auth({ ...shared, countAuthTriggers: async () => null });
  assert.ok(unknown.warnings.some((w) => /other apps' sign-up triggers/.test(w)));
  const one = await auth({ ...shared, countAuthTriggers: async () => 1 });
  assert.ok(one.warnings.some((w) => /1 sign-up trigger from/.test(w)));
});

test('shared project: a schema setting that is missing or wrong fails auth and isolation before any user is made', async (t) => {
  const { fake, ctx } = await setup(t);
  for (const schema of [null, 'public', 'app_other']) {
    const secrets = new Map(ctx.secrets);
    if (schema) secrets.set('NEXT_PUBLIC_SUPABASE_SCHEMA', schema); else secrets.delete('NEXT_PUBLIC_SUPABASE_SCHEMA');
    const shared = { ...ctx, secrets, app: sharedApp, allowTestUsers: true, countAuthTriggers: async () => 1 };
    for (const check of [auth, isolation]) {
      const r = await check(shared);
      assert.equal(r.ok, false, `${schema}: ${JSON.stringify(r)}`);
      assert.match(r.problems.join('\n'), /NEXT_PUBLIC_SUPABASE_SCHEMA in \.env\.local must be app_notes/);
      assert.match(r.problems.join('\n'), /Run provision-supabase\.mjs again/);
    }
  }
  assert.deepEqual(fake.state.requests, []);
});

test('an app of its own (not shared) is not affected by the shared-project rules', async (t) => {
  const { fake, ctx } = await setup(t);
  const r = await auth({ ...ctx, app: { slug: 'solo', supabaseRef: 'abcdefghijklmnopqrst' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!r.warnings || r.warnings.length === 0);
  assert.equal(fake.state.users.size, 0);
});

test('the number of auth.users triggers is read through the Management API, and is null when it can not be', async () => {
  const { countAuthTriggers } = await import('../scripts/verify/shared-guard.mjs');
  const seen = [];
  const fetch = async (url, init) => {
    seen.push([init.method, new URL(url).pathname, JSON.parse(init.body).query]);
    return new Response(JSON.stringify([{ tgname: 'a', fn: 'x' }, { tgname: 'b', fn: 'y' }]), { status: 200 });
  };
  assert.equal(await countAuthTriggers(sharedApp, { getSecret: async () => `sbp_${'a1b2c3d4'.repeat(5)}`, fetch }), 2);
  assert.equal(seen[0][0], 'POST');
  assert.match(seen[0][1], /\/database\/query$/);
  assert.match(seen[0][2], /^select tgname/);
  assert.equal(await countAuthTriggers(sharedApp, { getSecret: async () => { throw new Error('no token'); }, fetch }), null);
  assert.equal(await countAuthTriggers({ slug: 'x' }, { getSecret: async () => 'x', fetch }), null);
});

test('verify --help mentions --allow-test-users', async () => {
  const { main } = await import('../scripts/verify.mjs');
  const out = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try { assert.equal(await main(['--help']), 0); } finally { process.stdout.write = original; }
  assert.match(out.join(''), /--allow-test-users/);
});
