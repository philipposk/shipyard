// Shared-project mode, SQL side: every migration the template and the modules ship must be safe to move into
// its own schema inside a Supabase project that other apps use.
//   1. every object is written with its schema (`public.items`), so swapping `public.` for the app's schema catches all of it;
//   2. the only trigger on auth.users is the template's, and it sits between the shipyard:auth-trigger markers
//      (shared mode drops that block: a trigger on auth.users would run for every app's sign-ups).
// The lint below is a plain-text check, not a SQL parser. It errs on the side of complaining.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The lint lives in the template, so every app ships and runs the same one (template/tests/shared-sql.test.mjs).
import { START, END, lintSql, stripComments, dropMarkerBlocks, swapSchema } from '../template/tests/shared-sql-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- helpers -----------------------------------------------------------------------------------------------

async function sqlFiles() {
  const out = [];
  const tdir = path.join(ROOT, 'template', 'supabase', 'migrations');
  for (const f of (await readdir(tdir)).filter((n) => n.endsWith('.sql')).sort()) {
    out.push({ rel: `template/supabase/migrations/${f}`, file: path.join(tdir, f), module: null });
  }
  const mroot = path.join(ROOT, 'modules');
  for (const m of await readdir(mroot, { withFileTypes: true })) {
    if (!m.isDirectory()) continue;
    const dir = path.join(mroot, m.name, 'migrations');
    let names = [];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
    } catch {
      continue;
    }
    for (const f of names) out.push({ rel: `modules/${m.name}/migrations/${f}`, file: path.join(dir, f), module: m.name });
  }
  return out;
}

// ---- the real files ----------------------------------------------------------------------------------------

test('the template and modules ship SQL (the checks below are not vacuous)', async () => {
  const files = await sqlFiles();
  const names = files.map((f) => f.rel);
  for (const must of [
    'template/supabase/migrations/0001_profiles.sql',
    'template/supabase/migrations/0002_items.sql',
    'template/supabase/migrations/0003_email_lookup.sql',
    'modules/billing/migrations/billing.sql',
    'modules/newsletter/migrations/newsletter.sql',
    'modules/errors/migrations/error_log.sql',
  ]) {
    assert.ok(names.includes(must), `${must} is missing`);
  }
});

test('every template and module migration writes every object with its schema', async () => {
  for (const f of await sqlFiles()) {
    const sql = await readFile(f.file, 'utf8');
    const problems = lintSql(sql, { allowAuthTrigger: f.rel.endsWith('0001_profiles.sql') });
    assert.deepEqual(problems, [], `${f.rel}: ${problems.join('; ')}`);
  }
});

test('0001_profiles.sql wraps the sign-up function and trigger in the auth-trigger markers', async () => {
  const sql = await readFile(path.join(ROOT, 'template/supabase/migrations/0001_profiles.sql'), 'utf8');
  assert.equal(sql.split(START).length, 2, 'exactly one start marker');
  assert.equal(sql.split(END).length, 2, 'exactly one end marker');
  const block = sql.slice(sql.indexOf(START), sql.indexOf(END));
  assert.match(block, /create or replace function public\.handle_new_user\(\)/);
  assert.match(block, /create trigger on_auth_user_created/);
  assert.match(block, /drop trigger if exists on_auth_user_created on auth\.users/);
  assert.match(block, /revoke execute on function public\.handle_new_user\(\)/);
  // The table, its policies and its grants stay outside, so shared mode keeps them.
  const outside = sql.replace(block, '');
  assert.match(outside, /create table if not exists public\.profiles/);
  assert.match(outside, /create policy "profiles select own"/);
  assert.match(outside, /grant update \(display_name, bio, onboarding_complete\) on public\.profiles to authenticated/);
  assert.doesNotMatch(stripComments(outside), /handle_new_user|\btrigger\b/i);
});

test('no migration outside the markers touches a trigger or the auth schema, and modules never add auth triggers', async () => {
  for (const f of await sqlFiles()) {
    const sql = await readFile(f.file, 'utf8');
    const rest = stripComments(dropMarkerBlocks(sql));
    assert.doesNotMatch(rest, /\btrigger\b/i, `${f.rel}: trigger outside the markers`);
    assert.doesNotMatch(rest, /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?auth"?\s*\./i, `${f.rel}: alters an auth table`);
    if (f.module) {
      assert.equal(sql.includes(START), false, `${f.rel}: modules must never add triggers on auth.users`);
      assert.doesNotMatch(stripComments(sql), /\bon\s+auth\.users\b/i, `${f.rel}: refers to auth.users with "on"`);
    }
  }
});

test('after the shared-mode transform no public. is left and the role word public is untouched', async () => {
  for (const f of await sqlFiles()) {
    const sql = await readFile(f.file, 'utf8');
    const out = swapSchema(dropMarkerBlocks(sql), 'app_test');
    assert.doesNotMatch(out, /\bpublic\./i, `${f.rel}: public. left after the swap`);
    assert.doesNotMatch(stripComments(out), /\bcreate\s+(?:or\s+replace\s+)?trigger\b/i, `${f.rel}: trigger left`);
    // role words survive: "revoke ... from public, anon" must stay as it is
    for (const m of dropMarkerBlocks(sql).matchAll(/from public(?=[ ,])/g)) {
      assert.ok(out.includes(m[0]), `${f.rel}: the role word public was changed`);
    }
  }
  const profiles = swapSchema(dropMarkerBlocks(await readFile(path.join(ROOT, 'template/supabase/migrations/0001_profiles.sql'), 'utf8')), 'app_test');
  assert.match(profiles, /create table if not exists app_test\.profiles/);
  assert.match(profiles, /references auth\.users on delete cascade/);
  assert.doesNotMatch(profiles, /handle_new_user|on_auth_user_created/);
  const email = swapSchema(await readFile(path.join(ROOT, 'template/supabase/migrations/0003_email_lookup.sql'), 'utf8'), 'app_test');
  assert.match(email, /revoke execute on function app_test\.auth_user_id_by_email\(text\) from public, anon, authenticated/);
});

test('the table the app creates profile rows in is also granted to the server role', async () => {
  const profiles = await readFile(path.join(ROOT, 'template/supabase/migrations/0001_profiles.sql'), 'utf8');
  const items = await readFile(path.join(ROOT, 'template/supabase/migrations/0002_items.sql'), 'utf8');
  assert.match(profiles, /grant all on public\.profiles to service_role/);
  assert.match(items, /grant all on public\.items to service_role/);
});

// ---- the lint itself ---------------------------------------------------------------------------------------

const GOOD = `
create table if not exists public.notes (id uuid primary key, user_id uuid references auth.users on delete cascade);
alter table public.notes enable row level security;
drop policy if exists "n" on public.notes;
create policy "n" on public.notes for select to authenticated using (user_id = auth.uid());
create index if not exists notes_idx on public.notes (user_id);
revoke all on public.notes from anon;
revoke execute on function public.f(text) from public, anon, authenticated;
grant all on public.notes to service_role;
create or replace function public.f(t text) returns int language sql set search_path = '' as $$ select count(*)::int from public.notes where user_id is distinct from null $$;
`;

test('lint: accepts qualified SQL', () => {
  assert.deepEqual(lintSql(GOOD), []);
});

test('lint: flags each kind of unqualified name', () => {
  const bad = [
    ['create table notes (id int);', /created object "notes"/],
    ['create or replace function f() returns int language sql as $$ select 1 $$;', /created object "f"/],
    ['create view v as select 1;', /created object "v"/],
    ['alter table notes enable row level security;', /altered object "notes"/],
    ['create index i on notes (id);', /indexed table "notes"/],
    ['create policy "p" on notes for select using (true);', /policy table "notes"/],
    ['drop policy if exists "p" on notes;', /policy table "notes"/],
    ['create table public.a (b uuid references things (id));', /referenced table "things"/],
    ['grant select on notes to authenticated;', /grant\/revoke object "notes"/],
    ['revoke all on public.a, b from anon;', /grant\/revoke object "b"/],
    ['create function public.g() returns void language plpgsql as $$ begin insert into notes values (1); end $$;', /insert target "notes"/],
    ['create function public.g() returns void language plpgsql as $$ begin delete from notes; end $$;', /delete target "notes"/],
    ['create function public.g() returns void language plpgsql as $$ begin update notes set a = 1; end $$;', /update target "notes"/],
    ['create function public.g() returns int language sql as $$ select count(*) from notes $$;', /from\/join "notes"/],
    ['create function public.g() returns int language sql as $$ select 1 from public.a join b on true $$;', /from\/join "b"/],
    ['create function public.g() returns int language sql as $$ select 1 $$; select g();', /call to "g\("/],
    ['create function public.g() returns int language sql set search_path = public as $$ select 1 $$;', /search_path mentions public/],
    ['create table "public".a (id int);', /quoted "public"/],
    ['create table PUBLIC.a (id int);', /upper case PUBLIC\./],
    ['create schema extra;', /must not create, drop or move schemas/],
  ];
  for (const [sql, expected] of bad) {
    const found = lintSql(sql);
    assert.ok(found.some((p) => expected.test(p)), `${sql}\n  expected ${expected}, got ${JSON.stringify(found)}`);
  }
});

test('lint: ignores comments and system catalogs, and handles quoted names', () => {
  assert.deepEqual(lintSql('-- create table notes (id int);\n/* grant select on notes to x; */ create table public."My Notes" (id int);'), []);
  assert.deepEqual(lintSql("do $$ begin if exists (select 1 from pg_extension where extname = 'x') then null; end if; end $$;"), []);
});

test('lint: triggers on auth.users are only fine inside the markers', () => {
  const trigger = 'create trigger t after insert on auth.users for each row execute function public.h();';
  const wrapped = `create function public.h() returns trigger language plpgsql as $$ begin return new; end $$;\n${START}\n${trigger}\n${END}\n`;
  assert.deepEqual(lintSql(wrapped, { allowAuthTrigger: true }), []);
  assert.ok(lintSql(wrapped, { allowAuthTrigger: false }).some((p) => /may not create any trigger/.test(p)));
  assert.ok(lintSql(trigger, { allowAuthTrigger: true }).some((p) => /outside the auth-trigger markers/.test(p)));
  assert.ok(lintSql('drop trigger if exists t on auth.users;').some((p) => /outside the auth-trigger markers/.test(p)));
  assert.ok(lintSql(`${END}\n${START}\n`).some((p) => /markers are not a start\/end pair/.test(p)));
  assert.ok(lintSql(`${START}\n${trigger}\n${END}\n${START}\n${END}`, { allowAuthTrigger: true }).some((p) => /more than one auth-trigger block/.test(p)));
});

test('transform mirror: marker block dropped, public. swapped, role word kept', () => {
  const sql = `create table public.t (id int);\nrevoke all on public.t from public, anon;\n${START}\ncreate trigger x after insert on auth.users for each row execute function public.h();\n${END}\ngrant all on public.t to service_role;\n`;
  const out = swapSchema(dropMarkerBlocks(sql), 'app_notes');
  assert.match(out, /create table app_notes\.t/);
  assert.match(out, /revoke all on app_notes\.t from public, anon;/);
  assert.doesNotMatch(out, /trigger|public\./);
  assert.match(out, /grant all on app_notes\.t to service_role;/);
});
