// Shared-project mode, the pure rules: schema names, rewriting migrations (and refusing unsafe ones),
// the exact merge of the API's schema list, and that the template and modules obey the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../scripts/provision/shared-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = (sql, file = 'x.sql') => S.transformMigration(sql, { schema: 'app_x', file }).sql;
const refuses = (sql, pattern) => assert.throws(() => T(sql), (e) => e.name === 'ProvisionError' && e.data.reason === 'unsafe-migration' && pattern.test(e.message), `expected a refusal: ${sql}`);

// ---------- schema names ----------

test('schema names: the default, the pattern and every reserved name', () => {
  assert.equal(S.defaultSchemaName('recipe-box'), 'app_recipe_box');
  assert.equal(S.defaultSchemaName('notes'), 'app_notes');
  for (const ok of ['app_notes', 'abc', 'my_app_2', 'a'.repeat(41)]) assert.equal(S.schemaNameProblem(ok), null, ok);
  for (const bad of ['', 'ab', 'a'.repeat(42), '1abc', '_abc', 'App_x', 'app-x', 'app x', 'app_x;', 'app"x', undefined, null, 42]) {
    assert.ok(S.schemaNameProblem(bad), `should refuse ${String(bad)}`);
  }
  for (const reserved of ['public', 'auth', 'storage', 'extensions', 'realtime', 'vault', 'net', 'cron', 'graphql', 'graphql_public', 'graphql_anything', 'supabase_functions', 'supabase_admin', 'pg_catalog', 'pg_anything', 'information_schema', 'pgsodium', 'pgbouncer']) {
    assert.match(S.schemaNameProblem(reserved) ?? '', /name Supabase uses itself/, reserved);
  }
  assert.throws(() => S.assertSchemaName('public'), /name Supabase uses itself/);
});

test('SQL is built only from validated names', () => {
  assert.equal(S.schemaIdent('app_notes'), '"app_notes"');
  for (const bad of ['public', 'a"; drop schema public; --', 'x', "app_x'"]) {
    assert.throws(() => S.schemaIdent(bad), { name: 'ProvisionError' });
    assert.throws(() => S.createSchemaSql(bad, 'notes'), { name: 'ProvisionError' });
    assert.throws(() => S.migrationSql(bad, '0001.sql', 'select 1'), { name: 'ProvisionError' });
    assert.throws(() => S.schemaExistsSql(bad), { name: 'ProvisionError' });
  }
  assert.throws(() => S.createSchemaSql('app_notes', "bad'slug"), { name: 'ProvisionError' });
  assert.throws(() => S.createSchemaSql('app_notes', 'Bad Slug'), { name: 'ProvisionError' });
  const sql = S.createSchemaSql('app_notes', 'notes');
  assert.match(sql, /^create schema if not exists "app_notes";$/m);
  assert.match(sql, /grant usage on schema "app_notes" to anon, authenticated, service_role;/);
  assert.match(sql, /alter default privileges in schema "app_notes" grant all on tables to service_role;/);
  assert.match(sql, /create table if not exists "app_notes"\._shipyard_app \(slug text primary key/);
  assert.match(sql, /values \('notes'\) on conflict \(slug\) do nothing;/);
  assert.ok(!/\bpublic\b/.test(sql.replace(/ from public;/g, ';')));
  // The file name goes in as an SQL string with quotes doubled.
  assert.match(S.migrationSql('app_notes', "0001_o'brien.sql", 'select 1'), /values \('0001_o''brien\.sql'\)/);
  assert.match(S.migrationSql('app_notes', '0001.sql', 'select 1'), /^set local search_path to "app_notes", extensions;/);
  assert.throws(() => S.sqlLiteral('line\nbreak'), { name: 'ProvisionError' });
  assert.equal(S.sqlLiteral("it's"), "'it''s'");
});

// ---------- the transform ----------

test('transform: public. becomes the schema, the role keyword public stays', () => {
  const out = T([
    'create table if not exists public.items (id uuid primary key, user_id uuid references auth.users on delete cascade);',
    'alter table public.items enable row level security;',
    'revoke all on public.items from public, anon;',
    'revoke execute on function public.f(text) from public;',
    'grant select on public.items to authenticated;',
    'create policy "p" on public.items for select to authenticated using (user_id = (select auth.uid()));',
  ].join('\n'));
  assert.match(out, /create table if not exists app_x\.items/);
  assert.match(out, /references auth\.users on delete cascade/);
  assert.match(out, /revoke all on app_x\.items from public, anon;/);
  assert.match(out, /revoke execute on function app_x\.f\(text\) from public;/);
  assert.match(out, /on app_x\.items for select/);
  assert.ok(!/\bpublic\./.test(out));
});

test('transform: function bodies, strings and quoted names are rewritten too', () => {
  const out = T([
    'create or replace function public.lookup(email text) returns uuid language sql stable security definer set search_path = \'\' as $$',
    '  select p.id from public.profiles as p join auth.users u on u.id = p.id where u.email = $1;',
    '$$;',
    'revoke execute on function public.lookup(text) from public, anon, authenticated;',
    "comment on function public.lookup(text) is 'select public.lookup(1)';",
    'create table "public"."quoted" (id int);',
    'insert into public . spaced (id) values (1);',
  ].join('\n'));
  assert.match(out, /from app_x\.profiles as p join auth\.users u on u\.id = p\.id/);
  assert.match(out, /'select app_x\.lookup\(1\)'/);
  assert.match(out, /create table "app_x"\."quoted"/);
  assert.match(out, /insert into app_x \. spaced/);
});

test('transform: only whole words are rewritten', () => {
  const out = S.rewritePublic('create table app_x.my_public (id int);\ncomment on table app_x.my_public is \'not public.\';\nselect other.public.col from t;', 'app_x');
  assert.match(out, /app_x\.my_public/);
  assert.match(out, /other\.public\.col/);
});

test('transform: the auth-trigger block is dropped, line numbers stay, other lines are kept', () => {
  const sql = [
    'create table public.a (id int);',
    '-- shipyard:auth-trigger:start',
    'create or replace function public.handle_new_user() returns trigger language plpgsql as $$ begin return new; end; $$;',
    'drop trigger if exists on_auth_user_created on auth.users;',
    'create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();',
    '-- shipyard:auth-trigger:end',
    'create table public.b (id int);',
  ].join('\n');
  const { sql: out, dropped } = S.transformMigration(sql, { schema: 'app_x', file: 'x.sql' });
  assert.deepEqual(dropped, ['auth-trigger']);
  assert.equal(out.split('\n').length, 7);
  assert.ok(!/handle_new_user|trigger/.test(out));
  assert.match(out, /create table app_x\.a/);
  assert.match(out, /create table app_x\.b/);
});

test('transform: the same trigger outside the markers is refused, and the message names the file, line and text', () => {
  const sql = 'create table public.a (id int);\n\ncreate trigger on_auth_user_created after insert on auth.users\n  for each row execute function public.handle_new_user();\n';
  assert.throws(() => S.transformMigration(sql, { schema: 'app_x', file: '0009_x.sql' }), (e) => {
    assert.match(e.message, /0009_x\.sql, line 3: adds or removes a trigger on auth\.users/);
    assert.match(e.message, /create trigger on_auth_user_created after insert on auth\.users/);
    assert.match(e.message, /Nothing was changed/);
    return true;
  });
});

test('transform: markers must be balanced', () => {
  assert.throws(() => T('-- shipyard:auth-trigger:start\nselect 1;'), /never closed/);
  assert.throws(() => T('select 1;\n-- shipyard:auth-trigger:end'), /without a matching start/);
  assert.throws(() => T('-- shipyard:auth-trigger:start\n-- shipyard:project-wide:start\n-- shipyard:project-wide:end\n-- shipyard:auth-trigger:end'), /nested/);
  assert.throws(() => T('-- shipyard:auth-trigger:start\n-- shipyard:project-wide:end'), /without a matching start/);
});

test('transform: refuses anything that touches auth, other schemas or the whole project', () => {
  refuses('create trigger t after insert on auth.users for each row execute function app_x.f();', /trigger on auth\.users/);
  refuses('drop trigger if exists on_auth_user_created on auth.users;', /trigger on auth\.users/);
  refuses('alter table auth.users add column x int;', /schema "auth"/);
  refuses('alter table "auth"."users" disable trigger all;', /schema "auth"/);
  refuses('insert into auth.users (id) values (gen_random_uuid());', /changes rows in the schema "auth"/);
  refuses('update auth.users set email = null;', /changes rows in the schema "auth"/);
  refuses('delete from auth.users;', /changes rows in the schema "auth"/);
  refuses('create policy p on storage.objects for select using (true);', /schema "storage"/);
  refuses('grant select on auth.users to anon;', /schema "auth"/);
  refuses('create table other_app.t (id int);', /schema "other_app"/);
  refuses('alter table public.profiles add column x int;\ncreate table extensions.t (id int);', /schema "extensions"/);
  refuses('create schema other;', /creates or changes a schema/);
  refuses('drop schema app_x cascade;', /creates or changes a schema/);
  refuses('grant usage on schema public to anon;', /schema "public"|public/);
  refuses('alter default privileges in schema auth grant all on tables to anon;', /schema "auth"/);
  refuses('alter default privileges grant all on tables to anon;', /default privileges/);
  refuses('create extension if not exists pg_cron;', /extension/);
  refuses("select cron.schedule('job', '* * * * *', 'select 1');", /Cron/);
  refuses('alter role authenticator set pgrst.db_schemas = \'x\';', /role/);
  refuses('create role mallory;', /role/);
  refuses('alter database postgres set x = 1;', /whole database/);
  refuses('set role postgres;', /another database role/);
  refuses('create or replace function app_x.f() returns int language sql set search_path = public as $$ select 1 $$;', /search path/);
  refuses('do $$ begin insert into auth.users (id) values (null); end $$;', /changes rows in the schema "auth"/);
});

test('transform: reading auth.users, auth.uid() and foreign keys to it are fine', () => {
  assert.doesNotThrow(() => T([
    'create table public.t (id uuid primary key, user_id uuid not null default auth.uid() references auth.users on delete cascade);',
    'alter table public.t add constraint fk foreign key (id) references auth.users (id);',
    'create policy "own" on public.t for all to authenticated using (user_id = auth.uid()) with check (user_id = (select auth.uid()));',
    'create or replace function public.who() returns uuid language sql stable security definer set search_path = \'\' as $$ select u.id from auth.users as u where u.id = auth.uid() $$;',
    'create or replace function public.j() returns setof public.t language sql as $$ select t.* from public.t join auth.users u on u.id = t.user_id join public.t t2 on auth.uid() = t2.user_id $$;',
    'revoke execute on function public.who() from public, anon, authenticated;',
    'revoke execute on function public.j() from public, anon, authenticated;',
  ].join('\n').replace('references auth.users (id);', 'references auth.users (id) on delete cascade;')));
});

test('transform: comments are ignored by the checks', () => {
  assert.doesNotThrow(() => T([
    '-- create trigger on auth.users, create extension, public. schema',
    '/* alter table auth.users; set search_path = public; */',
    'create table public.t (id int); -- insert into auth.users',
  ].join('\n')));
  // ... but a "--" inside a string is not a comment.
  refuses("select '--'; create extension pg_cron;", /extension/);
});

test('transform: the project-wide block (extensions, Cron) is dropped like the auth-trigger block, and nowhere else', () => {
  const sql = 'create table public.t (id int);\n-- shipyard:project-wide:start\ncreate extension pg_cron;\nselect cron.schedule(\'a\', \'* * * * *\', \'select 1\');\n-- shipyard:project-wide:end\n';
  const { sql: out, dropped } = S.transformMigration(sql, { schema: 'app_x', file: 'x.sql' });
  assert.deepEqual(dropped, ['project-wide']);
  assert.ok(!/extension|cron/.test(out));
  refuses('create extension pg_cron;', /extension/);
});

test('transform: names without a schema in front are refused (they would land in public)', () => {
  refuses('create table items (id int);', /"items" has no schema in front|the table "items"/);
  refuses('create or replace function f() returns int language sql as $$ select 1 $$;', /function "f"/);
  refuses('alter table items enable row level security;', /"items"/);
  refuses('create index i on items (id);', /"items" has no schema/);
  refuses('create policy p on items for select using (true);', /"items" has no schema/);
  refuses('revoke all on items from anon;', /"items" has no schema/);
  refuses('grant select on app_x.a, b to anon;', /"b" has no schema/);
  refuses('create table app_x.t (id uuid references profiles (id));', /"profiles" has no schema/);
  refuses('insert into items (id) values (1);', /"items" has no schema/);
  refuses('update items set a = 1;', /"items" has no schema/);
  refuses('delete from items;', /"items" has no schema/);
  assert.doesNotThrow(() => T('create temp table scratch (id int);'));
  assert.deepEqual(S.findUnqualified('create table app_x.t (id int);\ngrant all on app_x.t to service_role;'), []);
  assert.equal(S.findUnqualified('grant execute on function app_x.f(text, int) to service_role;').length, 0);
  assert.equal(S.findUnqualified('grant select on all tables in schema app_x to service_role;').length, 0);
});

test('transform: a long list of problems is cut short, still naming the first ones', () => {
  const many = Array.from({ length: 20 }, (_, i) => `create table t${i} (id int);`).join('\n');
  assert.throws(() => T(many), (e) => /and 8 more/.test(e.message) && /line 1:/.test(e.message));
});

// ---------- the strict layer (allow-list) ----------

test('strict: giving or taking a database role is refused (it would let every visitor skip the privacy rules)', () => {
  refuses('grant service_role to anon;', /database role/);
  refuses('grant authenticated to anon;', /database role/);
  refuses('grant postgres to authenticated with admin option;', /database role/);
  refuses('revoke service_role from authenticator;', /database role/);
  refuses('GRANT   service_role\n  TO anon;', /database role/);
  // Real grants on the app's own objects are fine.
  assert.doesNotThrow(() => T('create table public.t (id int);\ngrant select on public.t to authenticated;\ngrant select, insert (id) on public.t to authenticated;\ngrant usage on schema public to anon;'.replace('grant usage on schema public to anon;', '')));
});

test('strict: code inside $$ bodies is held to the same rules', () => {
  refuses('do $$ begin drop table other_app.secrets; end $$;', /may not run|other_app/);
  refuses('do $$ begin alter table auth.users add column x int; end $$;', /may not run|auth\.users/);
  refuses('do $$ begin grant select on auth.users to anon; end $$;', /may not run|auth\.users/);
  refuses('do $$ begin create policy p on storage.objects for select using (true); end $$;', /may not run|storage\.objects/);
  refuses('create function app_x.f() returns void language plpgsql as $$ begin drop table other_app.secrets; end $$;', /other_app\.secrets/);
  refuses('create function app_x.f() returns void language plpgsql as $$ begin truncate other_app.x; end $$;', /truncate|other_app\.x/);
  refuses('create function app_x.f() returns void language plpgsql as $$ begin delete from storage.objects; end $$;', /storage\.objects/);
  refuses('create function app_x.f() returns void language plpgsql as $$ begin perform other_app.reset_all(); end $$;', /other_app\.reset_all/);
  refuses("create function app_x.f() returns void language sql as 'select other_app.reset_all()';", /other_app\.reset_all/);
  refuses("create function app_x.f() returns bigint language sql as 'select count(*) from other_app.x';", /other_app\.x/);
  refuses("create table app_x.t (id bigint default nextval('other_app.seq'));", /other_app\.seq/);
});

test('strict: statement kinds that can destroy data, lock or kill connections are refused', () => {
  for (const sql of [
    'truncate other_app.x;', 'truncate table app_x.t;', 'merge into other_app.x using app_x.y on true when matched then delete;',
    'copy other_app.x from stdin;', 'copy (select 1) to stdout;', 'call other_app.cleanup();', 'select other_app.reset_all();', 'select 1;',
    'lock table storage.objects in access exclusive mode;', 'vacuum full storage.objects;', 'vacuum;', 'reindex database postgres;', 'cluster;',
    "security label on table storage.objects is 'x';", 'create cast (text as int) with inout;', 'create aggregate app_x.a (int) (sfunc = int4pl, stype = int);',
    'create operator app_x.+++ (function = int4pl);', 'select pg_terminate_backend(pid) from pg_stat_activity;',
    'create materialized view app_x.m as select 1;', 'create rule r as on insert to app_x.t do instead nothing;',
    'create event trigger e on ddl_command_end execute function app_x.f();', 'set role postgres;', 'reset all;', "notify pgrst, 'reload schema';",
    'refresh materialized view app_x.m;', 'with x as (select 1) delete from app_x.t;',
  ]) {
    assert.throws(() => T(sql), (e) => e.data?.reason === 'unsafe-migration', `should refuse: ${sql}`);
  }
  refuses('begin;\ncreate table public.t (id int);\ncommit;', /transaction/);
  refuses('create table public.t (id int);\nrollback;', /transaction/);
  refuses('savepoint a;', /transaction/);
  refuses('start transaction;', /transaction/);
  refuses('create function app_x.f() returns void language plpgsql as $$ begin perform pg_terminate_backend(1); end $$;', /pg_terminate_backend/);
  refuses("create function app_x.f() returns void language plpgsql as $$ begin perform set_config('role', 'postgres', false); end $$;", /set_config/);
  refuses("create function app_x.f() returns void language plpgsql as $$ begin perform dblink_exec('x', 'drop table y'); end $$;", /dblink/);
  refuses("create function app_x.f() returns xml language sql as $$ select query_to_xml('select * from other_app.x', true, false, '') $$;", /query_to_xml/);
  refuses('create function app_x.f() returns void language c as \'x\';', /language/);
  refuses('create function app_x.f() returns void language plpgsql as $$ begin truncate app_x.t; end $$;', /truncate/);
});

test('strict: dynamic SQL is refused', () => {
  refuses("create function app_x.f() returns void language plpgsql as $$ begin execute 'drop table other_app.x'; end $$;", /EXECUTE/);
  refuses("create function app_x.f(t text) returns void language plpgsql as $$ begin execute format('drop table %I', t); end $$;", /EXECUTE/);
  refuses("create function app_x.f(t text) returns void language plpgsql as $$ begin execute $q$ drop table other_app.x $q$; end $$;", /EXECUTE|other_app/);
  refuses("create function app_x.f(t text) returns void language plpgsql as $$ declare s text := 'x'; begin execute s || t; end $$;", /EXECUTE/);
  // Trigger and privilege wording that contains the word is fine.
  assert.doesNotThrow(() => T('create table public.t (id int);\ncreate function public.tf() returns trigger language plpgsql as $$ begin return new; end $$;\ncreate trigger tr before insert on public.t for each row execute function public.tf();\ncreate trigger tr2 before update on public.t for each row execute procedure public.tf();\nrevoke execute on function public.tf() from public;\ngrant execute on function public.tf() to service_role;'));
});

test('strict: reading other schemas is refused, in views, definer functions and plain queries', () => {
  refuses('create view public.users_list as select email from auth.users;\ngrant select on public.users_list to authenticated;', /auth\.users|security_invoker/);
  refuses('create view public.v as select * from postbox.messages;\ngrant select on public.v to anon;', /postbox\.messages/);
  refuses('create view public.v with (security_invoker = true) as select * from postbox.messages;', /postbox\.messages/);
  refuses('create table public.t (id int);\ncreate view public.v as select * from public.t;', /security_invoker/);
  refuses('create or replace function public.leak() returns setof auth.users language sql security definer as $$ select * from auth.users $$;', /auth\.users/);
  refuses('create or replace function public.leak() returns table (e text) language sql security definer as $$ select email from auth.users $$;', /auth\.users/);
  refuses('create table public.t (id int);\ncreate policy p on public.t for select using (exists (select 1 from auth.users u where u.id = auth.uid()));', /auth\.users/);
  refuses('create table public.t (id int);\ninsert into public.t select id from postbox.messages;', /postbox\.messages/);
  refuses('create table public.t (id int);\ncreate table public.u (like postbox.messages);', /postbox\.messages/);
  refuses('create table public.t (c postbox.status);', /postbox\.status/);
  refuses('create table public.t (id int);\nalter table public.t alter column id type postbox.myint;', /postbox\.myint/);
  refuses('create table public.t (id int);\nalter table public.t set schema postbox;', /another schema/);
  refuses('create table public.t (id int);\nalter table public.t owner to postgres;', /owns/);
  refuses("create function public.f() returns int language sql as $$ select 1 $$ set search_path = postbox;", /search path/);
  refuses("create function public.f() returns int language sql set search_path = 'postbox, public' as $$ select 1 $$;", /search path/);
  refuses("create function public.f() returns int language sql set search_path to default as $$ select 1 $$;", /search path/);
  refuses('create table public.t (id int);\ncreate trigger tr before insert on public.t for each row execute function postbox.f();', /postbox\.f/);
  refuses('create table public.t (a int);\nselect_x', /./); // any garbage still refuses
  refuses('create function public.f() returns int language sql as $$ select a.id from public.t as a, postbox.secrets $$;', /postbox\.secrets/);
  refuses('create function public.f() returns int language sql as $$ select 1 from public.t join postbox.s on true $$;', /postbox\.s/);
  refuses('create function public.f() returns int language sql as $$ select id::postbox.thing from public.t $$;', /postbox\.thing/);
  refuses('create function public.f() returns int language sql as $$ select cast(id as postbox.thing) from public.t $$;', /postbox\.thing/);
  refuses('create function public.f() returns int language sql as $$ select x from public.t as postbox, postbox.secrets $$;', /postbox\.secrets/);
});

test('strict: the shared login table can only be read by a function nobody but the server can call', () => {
  const fn = 'create or replace function public.who(e text) returns uuid language sql stable security definer set search_path = \'\' as $$ select u.id from auth.users as u where u.email = $1 $$;';
  refuses(fn, /revoke execute on function app_x\.who/);
  refuses(`${fn}\nrevoke execute on function public.who(text) from public;`, /revoke execute on function app_x\.who/);
  refuses(`${fn}\nrevoke execute on function public.who(text) from public, anon, authenticated;\ngrant execute on function public.who(text) to authenticated;`, /not grant it back/);
  refuses(`${fn}\nrevoke execute on function public.other(text) from public, anon, authenticated;`, /revoke execute on function app_x\.who/);
  assert.doesNotThrow(() => T(`${fn}\nrevoke execute on function public.who(text) from public, anon, authenticated;\ngrant execute on function public.who(text) to service_role;`));
  assert.doesNotThrow(() => T(`${fn}\nrevoke execute on all functions in schema app_x from public, anon, authenticated;`));
  refuses('select 1 from auth.sessions;', /./);
  refuses('create function public.f() returns int language sql as $$ select count(*) from auth.sessions $$;', /auth\.sessions/);
  refuses('create function public.f() returns int language sql as $$ select count(*) from auth.identities $$;', /auth\.identities/);
});

test('strict: a foreign key to auth.users needs on delete cascade or set null', () => {
  refuses('create table public.t (id uuid references auth.users);', /on delete/);
  refuses('create table public.t (id uuid references auth.users (id));', /on delete/);
  refuses('create table public.t (id uuid references auth.users (id) on delete restrict);', /on delete/);
  refuses('create table public.t (id uuid, constraint fk foreign key (id) references auth.users (id) on delete no action, n int);', /on delete/);
  refuses('create table public.t (id uuid);\nalter table public.t add constraint fk foreign key (id) references auth.users (id);', /on delete/);
  for (const ok of [
    'create table public.t (id uuid references auth.users on delete cascade);',
    'create table public.t (id uuid references auth.users (id) on delete set null);',
    'create table public.t (id uuid not null default auth.uid() references auth.users on delete cascade, n int);',
    'create table public.t (id uuid, n int, constraint fk foreign key (id) references auth.users (id) on delete cascade);',
  ]) assert.doesNotThrow(() => T(ok), ok);
  // The words on delete cascade after a comma belong to another column, not this key.
  refuses('create table public.t (a uuid references auth.users, b uuid references public.t (id) on delete cascade);', /on delete/);
});

test('strict: ordinary app code is accepted (aliases, row variables, joins, extract, policies, triggers)', () => {
  assert.doesNotThrow(() => T([
    'create table public.items (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users on delete cascade, title text, created_at timestamptz default now());',
    'alter table public.items enable row level security;',
    'create policy "own" on public.items for all to authenticated using (user_id = (select auth.uid())) with check (items.user_id = auth.uid());',
    'create index if not exists items_user_idx on public.items (user_id);',
    'create view public.recent with (security_invoker = true) as select i.id, extract(epoch from i.created_at) as ts from public.items i where i.created_at > now() - interval \'1 day\';',
    'create view public.mine with (security_invoker = on) as select items.title from public.items where items.user_id = auth.uid();',
    'create or replace function public.touch() returns trigger language plpgsql set search_path = \'\' as $$ begin new.created_at := now(); if old.title is distinct from new.title then new.title := trim(both \' \' from new.title); end if; return new; end $$;',
    'create trigger items_touch before update on public.items for each row execute function public.touch();',
    'create or replace function public.count_mine() returns bigint language plpgsql stable security invoker set search_path = \'\' as $$ declare r record; n bigint := 0; begin for r in select i.id from public.items as i, public.items j where i.id = j.id and j.user_id = auth.uid() loop n := n + 1; end loop; return n; end $$;',
    'create or replace function public.rate(a numeric) returns numeric language sql immutable as $$ select a.value from (select a as value) a $$;',
    'revoke all on public.items from anon;',
    'grant select, insert, update, delete on public.items to authenticated;',
    'grant all on public.items to service_role;',
    'grant execute on function public.count_mine() to authenticated;',
    'create type public.status as enum (\'a\', \'b\');',
    'create sequence public.counter;',
    'comment on table public.items is \'A list. e.g. notes, i.e. things.\';',
    'insert into public.items (title) values (\'see example.com and e.g. this\');',
    'update public.items set title = lower(items.title) where items.id = (select min(i2.id) from public.items i2);',
    'delete from public.items using public.items other where other.id = items.id and other.title is null;',
    'alter table public.items add column if not exists note text;',
    'alter default privileges in schema app_x grant all on tables to service_role;',
    'drop policy if exists "own" on public.items;',
    'drop index if exists public.items_user_idx;',
    'create temp table scratch (id int);',
    'create table public.t2 (id bigint default nextval(\'public.counter\'), c public.status default \'a\');',
  ].join('\n')), 'ordinary code');
});

test('strict: the file the template and the modules ship pass through unchanged by the strict layer', async () => {
  for (const { file, sql } of await allMigrations()) {
    const { sql: out } = S.transformMigration(sql, { schema: 'app_probe', file });
    assert.deepEqual(S.findStrictProblems(S.blankComments(out), 'app_probe'), [], file);
  }
});

test('strict: begin/commit and friends inside a marker block are removed with the block and do not matter', () => {
  const sql = 'create table public.t (id int);\n-- shipyard:project-wide:start\ndo $$ begin execute \'select 1\'; end $$;\ncommit;\n-- shipyard:project-wide:end\n';
  assert.doesNotThrow(() => T(sql));
});

test('strict: schema setup keeps functions private by default', () => {
  const sql = S.createSchemaSql('app_notes', 'notes');
  assert.match(sql, /alter default privileges in schema "app_notes" revoke execute on functions from public;/);
  assert.equal(S.revokePublicFunctionsSql('app_notes'), 'revoke execute on all functions in schema "app_notes" from public;');
  assert.throws(() => S.revokePublicFunctionsSql('public'), { name: 'ProvisionError' });
});

test('strict: a battery of ordinary student SQL is accepted', () => {
  const ordinary = [
 "create table app_x.notes (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade, title text not null check (length(title) < 100), tags text[] default '{}', created_at timestamptz default now());",
 "create or replace function app_x.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;",
 "create trigger set_updated_at before update on app_x.notes for each row execute function app_x.set_updated_at();",
 "insert into app_x.categories (name) values ('a'), ('b') on conflict do nothing;",
 "create or replace function app_x.mine() returns table (id uuid, title text) language sql stable as $$ select n.id, n.title from app_x.notes n where n.user_id = auth.uid() order by n.created_at desc, n.id; $$;",
 "create or replace function app_x.t() returns void language plpgsql as $$ declare r record; begin for r in select * from app_x.notes loop update app_x.notes set title = r.title where id = r.id; end loop; end $$;",
 "insert into app_x.notes (user_id, title) values ('3b241101-e2bb-4255-8caf-4136c566a962', 'e.g. a note, see example.com') on conflict (id) do update set title = excluded.title;",
 "create policy \"x\" on app_x.notes using (notes.user_id = auth.uid());",
 "comment on column app_x.notes.title is 'Title, e.g. foo.bar';",
 "create table app_x.t (like app_x.notes including all);",
 "alter type app_x.mood add value 'ok';",
 "create or replace function app_x.f() returns int language plpgsql as $$ begin if not exists (select 1 from app_x.notes n where n.id is not null) then raise exception 'x.y is bad'; end if; return (select count(*) from app_x.notes n where n.created_at > date_trunc('day', now())); end $$;",
 "create index on app_x.notes using gin (to_tsvector('english', title));",
 "create or replace view app_x.v with (security_invoker = true) as select n.id, row_number() over (partition by n.user_id order by n.created_at) as rn from app_x.notes n;",
 "create table app_x.p (n int generated always as identity, id uuid default extensions.uuid_generate_v4());",
  ];
  for (const sql of ordinary) assert.doesNotThrow(() => T(sql), sql);
});

test('strict: a battery of sneaky ways to reach another schema, run SQL or hold locks is refused', () => {
  const sneaky = [
 "create table app_x.t (id int, c int default (select max(id) from other.t));",
 "create function app_x.f() returns int language sql as $$ select a.id from app_x.t a, other.secrets $$;",
 "create function app_x.f() returns int language sql as $$ select a.id from app_x.t a join app_x.u b on true, other.secrets $$;",
 "create function app_x.f() returns int language sql as $$ select x.id from app_x.t as x(id) where exists (select 1 from storage.objects) $$;",
 "alter table app_x.t add column c int default nextval('other.seq');",
 "create function app_x.f() returns int language sql as $$ select nextval('other.seq')::int $$;",
 "create function app_x.f() returns int language sql as $$ select setval('\"other\".seq', 1)::int $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin PERFORM other.reset(); end $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin perform \"other\".\"reset\"(); end $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin insert into OTHER.t values (1); end $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin insert into other . t values (1); end $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin update \"other\".t set a = 1; end $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin delete from  other.t; end $$;",
 "drop table other.t;",
 "drop table if exists app_x.t, other.t;",
 "revoke all on all tables in schema other from anon;",
 "grant all on other.t to anon;",
 "grant select on app_x.a, other.b to anon;",
 "create policy p on app_x.t using (id in (select id from other.t));",
 "create policy p on other.t using (true);",
 "alter table app_x.t add constraint c foreign key (id) references other.t (id);",
 "create function app_x.f() returns void language plpgsql as $$ begin execute 'x'; end $$;",
 "create function app_x.f() returns void language plpgsql security definer as $$ begin perform 1 from auth.users; end $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin perform auth.admin_x(); end $$;",
 "create function app_x.f() returns void language plpgsql as $$ begin perform extensions.http_get('x'); end $$;",
 "create function app_x.f() returns int language sql as $$ select count(*) from pg_catalog.pg_authid $$ ;",
 "alter table app_x.t rename to u; alter table app_x.u set schema other;",
 "alter function app_x.f() set search_path = other;",
 "set search_path = other;",
 "create function app_x.f() returns int language sql as $$ select 1 $$ ; select pg_sleep(100);",
 "create function app_x.f() returns int language sql as $$ select pg_sleep(100) $$;",
 "create function app_x.f() returns int language sql as $$ select pg_advisory_lock(1) $$;",
 "alter default privileges for role postgres in schema other grant all on tables to anon;",
 "alter default privileges grant all on tables to anon;",
 "create table app_x.t (id int); alter table app_x.t disable row level security; revoke all on app_x.t from anon; grant all on app_x.t to anon, authenticated; create schema other2;",
  ];
  for (const sql of sneaky) assert.throws(() => T(sql), (e) => e.name === 'ProvisionError' && e.data.reason === 'unsafe-migration', `should refuse: ${sql}`);
});

// ---------- statements and comments ----------

test('blankComments and splitStatements', () => {
  const sql = "select 1; -- one\n/* two ; */ select 'a;b', $$ x; y $$; select \"q;\" ";
  const code = S.blankComments(sql);
  assert.equal(code.length, sql.length);
  assert.ok(!code.includes('one') && !code.includes('two'));
  assert.deepEqual(S.splitStatements(code).map((s) => s.text.trim()), ['select 1', "select 'a;b', $$ x; y $$", 'select "q;"']);
  assert.ok(S.blankComments("select $$ -- not data\n select 1 $$").includes('select 1'));
});

// ---------- the API's schema list ----------

test('db_schemas merge: every existing entry stays in place, the new one is appended', () => {
  assert.deepEqual(S.mergeDbSchemas('public, storage, graphql_public', 'app_x'), { list: ['public', 'storage', 'graphql_public', 'app_x'], merged: 'public, storage, graphql_public, app_x', changed: true, added: true });
  assert.equal(S.mergeDbSchemas('public,storage', 'app_x').merged, 'public,storage,app_x');
  assert.equal(S.mergeDbSchemas('app_b, public, app_a', 'app_x').merged, 'app_b, public, app_a, app_x');
  assert.equal(S.mergeDbSchemas('public, storage,', 'app_x').merged, 'public, storage, app_x');
  assert.equal(S.mergeDbSchemas('  public ,  storage ', 'app_x').merged, 'public ,  storage, app_x');
});

test('db_schemas merge: no duplicates, no change when already there', () => {
  const r = S.mergeDbSchemas('public, app_x, storage', 'app_x');
  assert.equal(r.changed, false);
  assert.deepEqual(r.list, ['public', 'app_x', 'storage']);
  assert.equal(r.merged, 'public, app_x, storage');
});

test('db_schemas merge: empty or missing lists give just the new schema (the caller must not use that blindly)', () => {
  for (const empty of [null, undefined, '', '  ', ',']) assert.deepEqual(S.mergeDbSchemas(empty, 'app_x'), { list: ['app_x'], merged: 'app_x', changed: true, added: true });
});

test('db_schemas merge: an entry it does not understand stops the merge', () => {
  assert.throws(() => S.mergeDbSchemas("public, o'brien", 'app_x'), { name: 'ProvisionError' });
  assert.throws(() => S.mergeDbSchemas('public, "quoted"', 'app_x'), { name: 'ProvisionError' });
  assert.throws(() => S.mergeDbSchemas('public', 'public'), { name: 'ProvisionError' });
});

test('db_schemas setting: read from the role settings (array or Postgres array text), null when absent', () => {
  assert.deepEqual(S.readDbSchemasSetting(['statement_timeout=8s', 'pgrst.db_schemas=public, storage']), { present: true, raw: 'public, storage' });
  assert.deepEqual(S.readDbSchemasSetting('{statement_timeout=8s,"pgrst.db_schemas=public, storage"}'), { present: true, raw: 'public, storage' });
  assert.deepEqual(S.readDbSchemasSetting(['statement_timeout=8s']), { present: false, raw: null });
  assert.deepEqual(S.readDbSchemasSetting(null), { present: false, raw: null });
  assert.deepEqual(S.readDbSchemasSetting(undefined), { present: false, raw: null });
  assert.deepEqual(S.readDbSchemasSetting('{}'), { present: false, raw: null });
  assert.deepEqual(S.splitSchemaList(' a , b,,c '), ['a', 'b', 'c']);
});

test('db_schemas statements quote their values', () => {
  const set = S.setDbSchemasSql('public, app_x', 'public');
  assert.match(set, /^do \$shipyard\$\n/);
  assert.match(set, /alter role authenticator set pgrst\.db_schemas = 'public, app_x';/);
  assert.match(set, /if cur is distinct from 'public' then/);
  assert.match(set, /raise exception 'shipyard: the exposed schema list changed meanwhile, nothing written';/);
  assert.match(set, /substr\(c, 18\)/);
  assert.equal('pgrst.db_schemas='.length + 1, 18);
  assert.match(set, /\$shipyard\$;\nnotify pgrst, 'reload config';\nnotify pgrst, 'reload schema';$/);
  assert.match(S.setDbSchemasSql('app_x', null), /if cur is distinct from null then/);
  assert.match(S.setDbSchemasSql('public, app_x', "a'b"), /distinct from 'a''b' then/);
  assert.throws(() => S.setDbSchemasSql('public, a$shipyard$b', 'public'), { name: 'ProvisionError' });
  assert.match(S.restoreDbSchemasSql("a'b"), /SET pgrst\.db_schemas = 'a''b';/);
  assert.match(S.restoreDbSchemasSql(null), /^ALTER ROLE authenticator RESET pgrst\.db_schemas;/);
  assert.match(S.restoreDbSchemasSql('public'), /NOTIFY pgrst, 'reload config';/);
});

// ---------- the template and the modules obey the rules ----------

async function allMigrations() {
  const out = [];
  const dirs = [path.join(root, 'template', 'supabase', 'migrations')];
  for (const m of await readdir(path.join(root, 'modules'), { withFileTypes: true })) {
    if (m.isDirectory()) dirs.push(path.join(root, 'modules', m.name, 'migrations'));
  }
  for (const dir of dirs) {
    let names = [];
    try { names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort(); } catch { continue; }
    for (const f of names) out.push({ file: path.relative(root, path.join(dir, f)), sql: await readFile(path.join(dir, f), 'utf8') });
  }
  return out;
}

test('every template and module migration is accepted by the shared-mode rewrite, with nothing left over', async () => {
  const files = await allMigrations();
  assert.ok(files.length >= 6, 'found the template and module migrations');
  for (const { file, sql } of files) {
    const { sql: out } = S.transformMigration(sql, { schema: 'app_probe', file });
    assert.ok(!/\bpublic\s*\./i.test(S.blankComments(out)), `${file}: public. left after the rewrite`);
    assert.ok(S.findUnqualified(sql).length === 0, `${file}: a name without a schema in front: ${JSON.stringify(S.findUnqualified(sql))}`);
  }
});

test('no template or module migration puts a trigger on auth.users outside the marker lines', async () => {
  for (const { file, sql } of await allMigrations()) {
    const outside = S.blankComments(S.dropMarkedBlocks(sql, file).sql).replace(/"/g, ' ');
    assert.ok(!/\btrigger\b[^;]*\bauth\s*\./i.test(outside), `${file}: trigger on auth.* outside the markers`);
    assert.ok(!/\b(alter|drop)\s+table\s+(if\s+exists\s+)?auth\s*\./i.test(outside), `${file}: changes an auth table`);
    assert.ok(!/\bcreate\s+extension\b|\bcron\s*\.\s*schedule/i.test(outside), `${file}: changes the whole project outside the markers`);
  }
});

test('the template profile migration keeps its sign-up trigger inside the markers, and the shared rewrite leaves it out', async () => {
  const sql = await readFile(path.join(root, 'template', 'supabase', 'migrations', '0001_profiles.sql'), 'utf8');
  assert.match(sql, /-- shipyard:auth-trigger:start[\s\S]*create trigger on_auth_user_created[\s\S]*-- shipyard:auth-trigger:end/);
  const { sql: out, dropped } = S.transformMigration(sql, { schema: 'app_probe', file: '0001_profiles.sql' });
  assert.deepEqual(dropped, ['auth-trigger']);
  assert.ok(!/handle_new_user|on_auth_user_created/.test(out));
  assert.match(out, /create table if not exists app_probe\.profiles/);
});

test('the errors module keeps its Cron setup inside the project-wide markers', async () => {
  const sql = await readFile(path.join(root, 'modules', 'errors', 'migrations', 'error_log.sql'), 'utf8');
  assert.match(sql, /-- shipyard:project-wide:start[\s\S]*create extension[\s\S]*cron\.schedule[\s\S]*-- shipyard:project-wide:end/);
  const { sql: out } = S.transformMigration(sql, { schema: 'app_probe', file: 'error_log.sql' });
  assert.ok(!/extension|cron/i.test(S.blankComments(out)));
  assert.match(out, /create table if not exists app_probe\.error_log/);
  assert.match(out, /create or replace function app_probe\.error_log_delete_old/);
});
