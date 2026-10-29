// Tests the rules in schema-rules-lib.mjs on small examples of good and bad SQL,
// so the CI gate itself can not quietly stop catching things.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findProblems, statements, relations } from "./schema-rules-lib.mjs";

const iso = (...names) => names.map((table) => ({ table, ownerColumn: "user_id" }));
const GOOD_TABLE = `
create table if not exists public.notes (id uuid primary key, user_id uuid not null);
alter table public.notes enable row level security;
create policy "notes select own" on public.notes for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.notes from anon;
grant select on public.notes to authenticated;
`;

test("a correct table passes", () => {
  assert.deepEqual(findProblems(GOOD_TABLE, iso("notes")), []);
});

test("comments and messages do not count as SQL", () => {
  const sql = `${GOOD_TABLE}\n-- create table ghost (x int); grant all on x to anon;\n/* create view v as select 1; */\ncomment on table public.notes is 'grant select to anon; create table ghost2 (x int)';`;
  assert.deepEqual(findProblems(sql, iso("notes")), []);
});

// ---- (1) tables the old check could not see ---------------------------------

for (const [label, create] of [
  ["without the public. prefix", "create table notes (id uuid, user_id uuid);"],
  ["with if not exists and no prefix", "create table if not exists notes (id uuid, user_id uuid);"],
  ["with a quoted name", 'create table "notes" (id uuid, user_id uuid);'],
  ["with a quoted schema and name", 'create table "public"."notes" (id uuid, user_id uuid);'],
  ["unlogged", "create unlogged table public.notes (id uuid, user_id uuid);"],
  ["with odd spacing and capitals", "CREATE   TABLE\n  Public . notes (id uuid, user_id uuid);"],
]) {
  test(`a table created ${label} still needs RLS and an isolation.json entry`, () => {
    const problems = findProblems(create, []);
    assert.equal(problems.length, 2, problems.join(" | "));
    assert.match(problems.join("\n"), /enable row level security/);
    assert.match(problems.join("\n"), /isolation\.json/);
  });
}

test("RLS written without the public. prefix or with quotes is recognised", () => {
  for (const alter of ["alter table notes enable row level security;", 'alter table "notes" enable row level security;', "alter table only public.notes enable row level security;"]) {
    const sql = `create table notes (id uuid, user_id uuid); ${alter}`;
    assert.deepEqual(findProblems(sql, iso("notes")), [], alter);
  }
});

test("tables in other schemas are not this app's business", () => {
  assert.deepEqual(relations("create table auth.thing (id int); create table storage.objects2 (id int);").tables, []);
});

test("switching RLS off is a problem", () => {
  assert.match(findProblems(`${GOOD_TABLE} alter table public.notes disable row level security;`, iso("notes")).join(), /never be switched off/);
});

// ---- (2) views ----------------------------------------------------------------

test("a plain view is flagged: it ignores the privacy rules of its tables", () => {
  const sql = `${GOOD_TABLE} create view public.all_notes as select * from public.notes;`;
  assert.match(findProblems(sql, iso("notes")).join(), /all_notes is a view without "with \(security_invoker = true\)"/);
});

test("create or replace view and no-prefix views are flagged too", () => {
  for (const create of ["create or replace view all_notes as select * from notes;", "create view if not exists all_notes as select 1;", "create or replace view public.all_notes with (security_barrier) as select 1;"]) {
    assert.match(findProblems(`${GOOD_TABLE} ${create}`, iso("notes")).join(), /all_notes is a view without/, create);
  }
});

test("a materialized view is flagged even with security_invoker", () => {
  const sql = `${GOOD_TABLE} create materialized view public.stats with (security_invoker = true) as select 1;`;
  assert.match(findProblems(sql, iso("notes", "stats")).join(), /materialized view/);
});

test("a security_invoker view must also be listed in isolation.json", () => {
  const sql = `${GOOD_TABLE} create view public.my_notes with (security_invoker = true) as select * from public.notes;`;
  assert.match(findProblems(sql, iso("notes")).join(), /add \{ "table": "my_notes"/);
  assert.deepEqual(findProblems(sql, iso("notes", "my_notes")), []);
  const on = sql.replace("= true", "= on");
  assert.deepEqual(findProblems(on, iso("notes", "my_notes")), []);
});

test("isolation.json may not list something no migration creates", () => {
  assert.match(findProblems(GOOD_TABLE, iso("notes", "ghost")).join(), /lists ghost, but no migration creates it/);
});

// ---- (3) anon and public -------------------------------------------------------

for (const grant of [
  "grant select on public.notes to anon;",
  "grant select on public.notes to public;",
  "grant select on public.notes to authenticated, anon;",
  "grant all on all tables in schema public to anon;",
  "grant select on public.notes to PUBLIC with grant option;",
  "alter default privileges in schema public grant select on tables to anon;",
  'grant select on public.notes to "anon";',
]) {
  test(`flagged: ${grant}`, () => {
    assert.match(findProblems(`${GOOD_TABLE} ${grant}`, iso("notes")).join(), /grant is given to/);
  });
}

for (const policy of [
  'create policy "open" on public.notes for select using (true);',
  'create policy "open" on public.notes using (true);',
  'create policy "open" on public.notes for select to public using (true);',
  'create policy "open" on public.notes for select to anon using (true);',
  'create policy "open" on public.notes for select to authenticated, anon using (true);',
  "create policy open on public.notes as permissive for select using (user_id = (select auth.uid()));",
  'create policy "to authenticated" on public.notes for select using (true);',
]) {
  test(`policy flagged: ${policy}`, () => {
    assert.match(findProblems(`${GOOD_TABLE} ${policy}`, iso("notes")).join(), /policy ".*" (?:has no "to" part|is given to)/);
  });
}

test("policies for authenticated and service_role are fine, including insert with check and restrictive ones", () => {
  const sql = `${GOOD_TABLE}
    create policy "ins" on public.notes for insert to authenticated with check (user_id = (select auth.uid()));
    create policy "svc" on public.notes as permissive for all to service_role using (true) with check (true);
    create policy "r" on public.notes as restrictive for update to authenticated using (true);`;
  assert.deepEqual(findProblems(sql, iso("notes")), []);
});

// ---- (4) security definer ------------------------------------------------------

const FN = (extra = "") => `
create or replace function public.lookup(email text) returns uuid language sql security definer set search_path = '' as $$ select 1 $$;
${extra}`;

test("a security definer function that is not revoked is flagged", () => {
  assert.match(findProblems(FN(), []).join(), /lookup is security definer but is still callable by public, anon, authenticated/);
});

test("revoking only some roles is flagged for the rest", () => {
  const p = findProblems(FN("revoke execute on function public.lookup(text) from public, anon;"), []).join();
  assert.match(p, /still callable by authenticated/);
  assert.ok(!/callable by public/.test(p));
});

test("revoke written in two statements, with or without the public. prefix, is accepted", () => {
  assert.deepEqual(findProblems(FN("revoke all on function public.lookup(text) from public; revoke execute on function lookup(text) from anon, authenticated;"), []), []);
  assert.deepEqual(findProblems(FN("revoke execute on function public.lookup(text) from public, anon, authenticated;"), []), []);
});

test("a revoke for a different function does not count", () => {
  assert.match(findProblems(FN("revoke execute on function public.other(text) from public, anon, authenticated;"), []).join(), /lookup is security definer/);
});

test("security definer without an empty search_path is flagged", () => {
  const sql = "create function public.f() returns int language sql security definer as $$ select 1 $$; revoke execute on function public.f() from public, anon, authenticated;";
  assert.match(findProblems(sql, []).join(), /set search_path = ''/);
});

test("ordinary (security invoker) functions need nothing", () => {
  assert.deepEqual(findProblems("create function public.add(a int, b int) returns int language sql as $$ select a + b $$;", []), []);
});

// ---- helpers ---------------------------------------------------------------------

test("statements() ignores semicolons inside strings and $$ bodies", () => {
  const sts = statements("select 'a;b'; create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql; select 2");
  assert.equal(sts.length, 3);
});

// ---- (5) policy conditions that run once per row ------------------------------------

test("a bare auth.uid() in a policy is flagged (it runs once per row)", () => {
  const sql = GOOD_TABLE.replace("(select auth.uid())", "auth.uid()");
  assert.match(findProblems(sql, iso("notes")).join(), /\(select auth\.uid\(\)\)/);
});

test("a policy calling a function with a column is flagged", () => {
  const sql = `${GOOD_TABLE}\ncreate policy "notes shared" on public.notes for select to authenticated using (private.has_access(user_id));`;
  assert.match(findProblems(sql, iso("notes")).join(), /has_access\(user_id\) once per row/);
});

test("col in (select allowed_ids()) and exists (select ...) pass", () => {
  const sql = `${GOOD_TABLE}
create policy "notes shared" on public.notes for select to authenticated using (user_id in (select private.allowed_ids()));
create policy "notes team" on public.notes for select to authenticated using (exists (select 1 from public.notes n where n.user_id = (select auth.uid())));`;
  assert.deepEqual(findProblems(sql, iso("notes")), []);
});
