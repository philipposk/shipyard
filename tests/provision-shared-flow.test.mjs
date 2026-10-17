// Shared-project mode, the whole flow against a pretend project: what it may write, what it must never touch,
// what it does when something unexpected shows up. No network, no real keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-shared-flow-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const P = await import('../scripts/provision/supabase-core.mjs');
const { provisionShared, SHARED_WARNING } = await import('../scripts/provision/shared-core.mjs');
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { saveProfile, loadProfile, defaultProfile } = await import('../scripts/lib/profile.mjs');
const { readAppConfig, updateAppConfig } = await import('../scripts/provision/common.mjs');
const { makeSharedProject, TOKEN, PUBLIC_KEY, SERVER_KEY, REF, getSecret, sleep, noApiCalls } = await import('./provision-shared-helpers.mjs');

const OLD_LIST = 'public, storage, graphql_public';
let n = 0;
async function makeApp(slugBase = 'sh-app') {
  const slug = `${slugBase}-${++n}`;
  const parent = path.join(tmp, `p${n}`);
  await scaffold({ slug, name: slug, description: 'd', parent });
  return { slug, dir: path.join(parent, slug), schema: `app_${slug.replace(/-/g, '_')}` };
}
const deps = (fake, extra = {}) => ({ fetch: fake.fetch, sleep, getSecret, now: () => new Date('2026-10-18T10:15:30.000Z'), ...extra });
const run = (opts, fake, extra) => provisionShared({ shared: REF, ...opts }, deps(fake, extra));
const everything = (fake) => JSON.stringify([fake.state.writes, fake.state.patches, fake.state.calls]);

before(async () => {
  const p = defaultProfile();
  p.accounts.supabase.orgId = 'my-org';
  await saveProfile(p);
});
after(() => rm(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------

test('dry run: looks, prints the plan, saves the snapshot and changes nothing at all', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject();
  const envBefore = await readFile(path.join(dir, '.env.local'), 'utf8');
  const cfgBefore = await readFile(path.join(dir, '.shipyard-app.json'), 'utf8');

  const result = await run({ appDir: dir, dryRun: true }, fake);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.schema, schema);

  // Zero writes of any kind.
  assert.deepEqual(fake.state.writes, []);
  assert.deepEqual(fake.state.patches, []);
  assert.ok(fake.state.calls.every((c) => c.route.startsWith('GET ') || c.route.endsWith('/database/query')));
  assert.equal(fake.state.rolconfig.at(-1), `pgrst.db_schemas=${OLD_LIST}`);
  assert.equal(fake.state.schemas.has(schema), false);
  assert.equal(await readFile(path.join(dir, '.env.local'), 'utf8'), envBefore);
  assert.equal(await readFile(path.join(dir, '.shipyard-app.json'), 'utf8'), cfgBefore);

  // The plan shows the rewritten SQL and the planned values.
  assert.equal(result.plan.createSchema, true);
  assert.deepEqual(result.plan.migrations.map((m) => m.file), ['0001_profiles.sql', '0002_items.sql', '0003_email_lookup.sql']);
  assert.deepEqual(result.plan.migrations[0].leftOut, ['auth-trigger']);
  for (const m of result.plan.migrations) assert.ok(!/\bpublic\./.test(m.sql) && m.sql.includes(`${schema}.`));
  assert.equal(result.plan.dbSchemas.after, `${OLD_LIST}, ${schema}`);
  assert.deepEqual(result.plan.redirectAddresses.added, []); // localhost is already allowed and there is no web address yet
  assert.equal(result.plan.siteUrl, 'unchanged');

  // The snapshot file is saved in the app's .shipyard folder and holds no secret.
  const files = await readdir(path.join(dir, '.shipyard'));
  assert.deepEqual(files, ['shared-snapshot-20261018T101530Z.json']);
  const text = await readFile(path.join(dir, '.shipyard', files[0]), 'utf8');
  const snap = JSON.parse(text);
  assert.equal(snap.pre.auth.siteUrl, 'https://first-app.example.com');
  assert.deepEqual(snap.pre.auth.smtpFieldsSet, { smtp_host: true, smtp_pass: true });
  for (const secret of ['smtp-secret-value-123', 'smtp.example.com', TOKEN, PUBLIC_KEY, SERVER_KEY]) assert.ok(!text.includes(secret), 'a secret or smtp value is in the snapshot');
  assert.equal(snap.pre.apiRole.dbSchemas.raw, OLD_LIST);
  assert.deepEqual(snap.pre.apiRole.otherSettings.map((o) => o.name), ['statement_timeout']);
  assert.ok(!text.includes('8s'), 'other role settings are kept as fingerprints only');
  assert.equal(snap.pre.authUsersTriggers[0].name, 'on_auth_user_created');
  assert.ok(snap.pre.publicPolicies.hash && snap.pre.publicGrants.hash && snap.pre.publicFunctions.hash);
});

test('a real run makes only the allowed changes and records them', async () => {
  const { slug, dir, schema } = await makeApp();
  const fake = makeSharedProject();
  await writeFile(path.join(dir, '.env.local'), `# mine\nCUSTOM_FLAG=1\n${await readFile(path.join(dir, '.env.local'), 'utf8')}`);
  const result = await run({ appDir: dir }, fake);

  assert.equal(result.ok, true);
  assert.equal(result.shared, true);
  assert.equal(result.schema, schema);
  assert.equal(result.schemaCreated, true);
  assert.deepEqual(result.migrations.applied, ['0001_profiles.sql', '0002_items.sql', '0003_email_lookup.sql']);
  assert.equal(result.dbSchemas.changed, true);

  // 1. The schema, its bookkeeping, the migrations: all inside the schema.
  assert.ok(fake.state.schemas.has(schema));
  assert.deepEqual([...fake.state.apps.get(schema).slugs], [slug]);
  assert.deepEqual([...fake.state.apps.get(schema).applied], ['0001_profiles.sql', '0002_items.sql', '0003_email_lookup.sql']);
  assert.match(fake.state.writes[0], new RegExp(`create schema if not exists "${schema}"`));
  assert.match(fake.state.writes[0], new RegExp(`grant usage on schema "${schema}" to anon, authenticated, service_role`));
  assert.match(fake.state.writes[0], new RegExp(`alter default privileges in schema "${schema}"`));

  // 2. The API schema list: every old entry in its place, ours at the end. Other settings on the role untouched.
  assert.deepEqual(fake.state.rolconfig, ['statement_timeout=8s', `pgrst.db_schemas=${OLD_LIST}, ${schema}`]);
  const alter = fake.state.writes.filter((q) => /alter role/i.test(q));
  assert.equal(alter.length, 1);
  assert.match(alter[0], /notify pgrst, 'reload config'/);
  assert.match(alter[0], new RegExp(`alter role authenticator set pgrst\\.db_schemas = 'public, storage, graphql_public, ${schema}';`));

  // 3. Sign-in settings: main address, email server, providers untouched; the address list only grew (here: nothing to add).
  assert.equal(fake.state.authConfig.site_url, 'https://first-app.example.com');
  assert.equal(fake.state.authConfig.smtp_host, 'smtp.example.com');
  assert.equal(fake.state.authConfig.external_google_enabled, true);
  assert.deepEqual(fake.state.patches, []);

  // Nothing outside the allowed list was written: no statement touches public, auth, triggers or roles other than authenticator's schema list.
  for (const q of fake.state.writes) {
    assert.ok(!/\bpublic\./i.test(q), `a statement still names public.: ${q.slice(0, 80)}`);
    assert.ok(!/\bcreate\s+(or\s+replace\s+)?trigger\b|\bdrop\s+trigger\b/i.test(q), 'no trigger statements at all');
    assert.ok(!/\b(insert\s+into|update|delete\s+from)\s+auth\.|\balter\s+table\s+auth\b/i.test(q));
    assert.ok(!/\bcreate\s+extension\b|\bcron\.schedule\b|\bsite_url\b|\bsmtp/i.test(q));
    // The only role statement is the schema list, written by the compare-and-set block.
    assert.ok(!/\balter\s+role\b/i.test(q) || (/^do \$shipyard\$/i.test(q.trim()) && (q.match(/alter\s+role/gi) ?? []).length === 1 && /alter role authenticator set pgrst\.db_schemas = /.test(q)));
  }
  // The schema's functions were taken away from everybody by default, after the files ran.
  assert.ok(fake.state.writes.some((q) => q === `revoke execute on all functions in schema "${schema}" from public;`));
  assert.ok(fake.state.writes.findIndex((q) => q.startsWith('revoke execute on all functions')) > fake.state.writes.findIndex((q) => q.includes('items_user_id_idx')));
  // The list is written only if it is still what was read (compare-and-set).
  const casWrite = fake.state.writes.find((q) => /^do \$shipyard\$/.test(q));
  assert.match(casWrite, /cur is distinct from 'public, storage, graphql_public' then/);
  assert.ok(!fake.state.writes.join('\n').includes('handle_new_user'), 'the sign-up function and trigger were left out');

  // Keys + schema in .env.local (other lines kept), records in config and profile.
  const env = await readFile(path.join(dir, '.env.local'), 'utf8');
  assert.match(env, /^# mine$/m);
  assert.match(env, /^CUSTOM_FLAG=1$/m);
  assert.match(env, new RegExp(`^NEXT_PUBLIC_SUPABASE_URL=https://${REF}\\.supabase\\.co$`, 'm'));
  assert.match(env, new RegExp(`^NEXT_PUBLIC_SUPABASE_SCHEMA=${schema}$`, 'm'));
  assert.ok(env.includes(PUBLIC_KEY) && env.includes(SERVER_KEY));
  const cfg = await readAppConfig(dir);
  assert.equal(cfg.supabaseRef, REF);
  assert.equal(cfg.schema, schema);
  assert.equal(cfg.shared, true);
  assert.ok(cfg.env.includes('NEXT_PUBLIC_SUPABASE_SCHEMA'));
  const app = (await loadProfile()).apps.find((a) => a.slug === slug);
  assert.deepEqual([app.supabaseRef, app.schema, app.shared, app.status], [REF, schema, true, 'provisioned']);

  // The snapshot file now holds before, after and the (clean) comparison. No secret anywhere.
  const [name] = await readdir(path.join(dir, '.shipyard'));
  const text = await readFile(path.join(dir, '.shipyard', name), 'utf8');
  const snap = JSON.parse(text);
  assert.equal(snap.phase, 'after');
  assert.equal(snap.diff.ok, true);
  assert.deepEqual(snap.probes.after, { public: 'ok', storage: 'ok', graphql_public: 'ok', [schema]: 'ok' });
  for (const secret of [TOKEN, PUBLIC_KEY, SERVER_KEY, 'smtp-secret-value-123']) {
    assert.ok(!text.includes(secret) && !JSON.stringify(result).includes(secret), 'a secret leaked');
  }
  // Probes used the public key only and the Accept-Profile header, as HEAD.
  assert.ok(fake.state.probes.length >= 7);
  assert.ok(fake.state.probes.every((p) => p.method === 'HEAD' && p.hasApikey && p.schema));
  assert.ok(fake.state.probes.some((p) => p.schema === 'public') && fake.state.probes.some((p) => p.schema === schema));
  // A made-up password-less run: the secret key never leaves the process except in .env.local.
  assert.ok(!fake.state.probes.some((p) => p.bearer?.includes(SERVER_KEY)));
});

test('the main sign-in address is not touched even when the app has a web address and the current one is localhost', async () => {
  const { dir } = await makeApp();
  await updateAppConfig(dir, { url: 'https://my-app.vercel.app' });
  const fake = makeSharedProject({ authConfig: { site_url: 'http://localhost:3000', uri_allow_list: 'https://other.example.com/**' } });
  const result = await run({ appDir: dir }, fake);
  assert.equal(result.ok, true);
  assert.equal(fake.state.authConfig.site_url, 'http://localhost:3000');
  assert.equal(fake.state.patches.length, 1);
  assert.deepEqual(Object.keys(fake.state.patches[0]), ['uri_allow_list']);
  assert.equal(fake.state.authConfig.uri_allow_list, 'https://other.example.com/**,http://localhost:3000/**,https://my-app.vercel.app/**');
  assert.deepEqual(result.auth.added, ['http://localhost:3000/**', 'https://my-app.vercel.app/**']);
});

test('running it again changes nothing and the app keeps working', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject();
  await run({ appDir: dir }, fake);
  const rolAfterFirst = JSON.stringify(fake.state.rolconfig);
  fake.state.writes.length = 0;
  fake.state.patches.length = 0;
  const again = await run({ appDir: dir }, fake);
  assert.equal(again.ok, true);
  assert.equal(again.schemaCreated, false);
  assert.deepEqual(again.migrations.applied, []);
  assert.equal(again.migrations.skipped.length, 3);
  assert.equal(again.dbSchemas.changed, false);
  assert.equal(JSON.stringify(fake.state.rolconfig), rolAfterFirst);
  assert.ok(!fake.state.writes.some((q) => /alter role/i.test(q) || /_shipyard_migrations \(name\)/.test(q)));
  assert.deepEqual(fake.state.patches, []);
  assert.equal(fake.state.rolconfig.at(-1).split(',').filter((s) => s.trim() === schema).length, 1, 'listed once');
});

test('the dispatcher: a shared app run without --shared goes through the shared flow, never the public schema', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject();
  await P.provisionSupabase({ appDir: dir, shared: REF }, deps(fake));
  fake.state.writes.length = 0;
  const result = await P.provisionSupabase({ appDir: dir }, deps(fake)); // like re-running after adding a module
  assert.equal(result.shared, true);
  assert.equal(result.schema, schema);
  assert.ok(!fake.state.writes.some((q) => /_shipyard_migrations/.test(q) && !q.includes(`"${schema}"`)), 'no bookkeeping in public');
  assert.equal(fake.state.calls.filter((c) => c.route === 'POST /projects').length, 0);
});

test('--url on a shared app only adds redirect addresses and never changes the main address', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({ authConfig: { site_url: 'http://localhost:3000', uri_allow_list: 'https://other.example.com/**' } });
  await P.provisionSupabase({ appDir: dir, shared: REF }, deps(fake));
  fake.state.patches.length = 0;
  const result = await P.provisionSupabase({ appDir: dir, url: 'https://live-app.vercel.app/some/path' }, deps(fake));
  assert.equal(result.ok, true);
  assert.equal(fake.state.authConfig.site_url, 'http://localhost:3000');
  assert.ok(fake.state.patches.every((p) => !('site_url' in p)));
  assert.ok(fake.state.authConfig.uri_allow_list.split(',').includes('https://live-app.vercel.app/**'));
  assert.ok(fake.state.authConfig.uri_allow_list.split(',').includes('https://other.example.com/**'));
});

// ---------------------------------------------------------------------------------------------------------------
// Refusals that happen before anything is changed

test('a schema name Supabase uses itself is refused before any call', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject();
  for (const bad of ['public', 'auth', 'storage', 'extensions', 'graphql_public', 'realtime', 'supabase_functions', 'pg_temp_x', 'vault', 'net', 'cron', 'Bad Name', 'x']) {
    await assert.rejects(() => run({ appDir: dir, schema: bad }, fake), (e) => e.name === 'ProvisionError' && /schema name|name Supabase uses/.test(e.message), bad);
  }
  assert.ok(noApiCalls(fake));
});

test('an app name that makes too long a schema name asks for --schema', async () => {
  const { dir } = await makeApp('abcdefghijklmnopqrstuvwxyz-abcdefghi');
  const fake = makeSharedProject();
  await assert.rejects(() => run({ appDir: dir }, fake), /--schema/);
  assert.ok(noApiCalls(fake));
});

test('a schema that another app already owns is refused and nothing is written', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject({ owners: { [schema]: ['somebody-else'] } });
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'schema-taken' && /another app already uses this name/.test(e.message));
  assert.deepEqual(fake.state.writes, []);
  assert.deepEqual(fake.state.patches, []);
  assert.equal((await readAppConfig(dir)).shared, undefined);
});

test('an existing schema without the Shipyard marker table is refused too', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject({ noMarker: [schema] });
  await assert.rejects(() => run({ appDir: dir }, fake), /another app already uses this name/);
  assert.deepEqual(fake.state.writes, []);
});

test('a schema this app owns continues where it left off', async () => {
  const { slug, dir, schema } = await makeApp();
  const fake = makeSharedProject({ owners: { [schema]: [slug] } });
  fake.state.apps.get(schema).applied.add('0001_profiles.sql');
  const result = await run({ appDir: dir }, fake);
  assert.equal(result.schemaCreated, false);
  assert.deepEqual(result.migrations.applied, ['0002_items.sql', '0003_email_lookup.sql']);
  assert.deepEqual(result.migrations.skipped, ['0001_profiles.sql']);
});

test('a migration that adds a trigger on auth.users stops everything before Supabase is asked anything', async () => {
  const { dir } = await makeApp();
  await writeFile(path.join(dir, 'supabase', 'migrations', '0004_bad.sql'),
    '-- adds a welcome email\ncreate trigger welcome after insert on auth.users\n  for each row execute function public.welcome();\n');
  const fake = makeSharedProject();
  await assert.rejects(
    () => run({ appDir: dir }, fake),
    (e) => e.data.reason === 'unsafe-migration' && /0004_bad\.sql, line 2/.test(e.message) && /create trigger welcome after insert on auth\.users/.test(e.message) && /Nothing was changed/.test(e.message),
  );
  assert.ok(noApiCalls(fake));
});

test('a migration that leaves the public name in a quoted form is refused', async () => {
  const { dir } = await makeApp();
  await writeFile(path.join(dir, 'supabase', 'migrations', '0004_sneaky.sql'), 'set search_path = public;\ncreate table public.notes (id int);\n');
  const fake = makeSharedProject();
  await assert.rejects(() => run({ appDir: dir }, fake), /search path/);
  assert.ok(noApiCalls(fake));
});

test('a paused or missing project is reported before anything else', async () => {
  const { dir } = await makeApp();
  const paused = makeSharedProject({ projectStatus: 'INACTIVE' });
  await assert.rejects(() => run({ appDir: dir }, paused), /is paused/);
  assert.deepEqual(paused.state.writes, []);
  const other = makeSharedProject();
  await assert.rejects(() => provisionShared({ appDir: dir, shared: 'nnnnnnnnnnnnnnnnnnnn' }, deps(other)), /was not found/);
  await assert.rejects(() => provisionShared({ appDir: dir, shared: 'short' }, deps(other)), /not a Supabase project id/);
});

test('an app that already has its own project, or another project, is not moved', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject();
  await updateAppConfig(dir, { supabaseRef: REF }); // its own project (no shared flag)
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'already-provisioned');
  await updateAppConfig(dir, { supabaseRef: 'qqqqqqqqqqqqqqqqqqqq', shared: true, schema: 'app_one' });
  await assert.rejects(() => run({ appDir: dir }, fake), /already connected to the Supabase project qqqqqqqqqqqqqqqqqqqq/);
  await updateAppConfig(dir, { supabaseRef: REF, shared: true, schema: 'app_one' });
  await assert.rejects(() => run({ appDir: dir, schema: 'app_two' }, fake), (e) => e.data.reason === 'schema-mismatch');
  assert.ok(noApiCalls(fake));
});

test('it refuses to write keys when git would not ignore .env.local, before any call', async () => {
  const { dir } = await makeApp();
  await writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  const fake = makeSharedProject();
  await assert.rejects(() => run({ appDir: dir }, fake, { run: async () => ({ code: 1, stdout: '', stderr: '' }) }), /\.env\.local/);
  assert.ok(noApiCalls(fake));
});

// ---------------------------------------------------------------------------------------------------------------
// The API schema list

test('a list with an entry it does not understand is not touched', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({ rolconfig: ["pgrst.db_schemas=public, we'ird"] });
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'odd-db-schemas');
  assert.ok(!fake.state.writes.some((q) => /alter role/i.test(q)));
});

test('when the project does not say which schemas it exposes, it starts from the platform setting and keeps every entry', async () => {
  const { dir, schema } = await makeApp();
  // No pgrst.db_schemas on the role: the API serves the platform's own list, which the new setting would replace.
  const fake = makeSharedProject({ rolconfig: ['statement_timeout=8s'], platformDbSchema: 'public,graphql_public,extra_one' });
  const result = await run({ appDir: dir }, fake);
  assert.equal(result.dbSchemas.inferred, true);
  assert.equal(fake.state.rolconfig.at(-1), `pgrst.db_schemas=public, graphql_public, extra_one, ${schema}`);
  assert.deepEqual(fake.state.rolconfig[0], 'statement_timeout=8s');
  // Every entry of that list is served before and after.
  assert.deepEqual(result.probes.before, { public: 'ok', graphql_public: 'ok', extra_one: 'ok' });
  assert.deepEqual(result.probes.after, { public: 'ok', graphql_public: 'ok', extra_one: 'ok', [schema]: 'ok' });
  // The platform answer also holds the JWT secret: only the schema list was kept.
  assert.ok(!JSON.stringify(result).includes('jwt-secret-value-never-print'));
  const [name] = await readdir(path.join(dir, '.shipyard'));
  assert.ok(!(await readFile(path.join(dir, '.shipyard', name), 'utf8')).includes('jwt-secret-value-never-print'));
  // The compare-and-set expects "no setting yet".
  assert.match(fake.state.writes.find((q) => /^do \$shipyard\$/.test(q)), /cur is distinct from null then/);
  assert.ok(fake.state.calls.some((c) => c.route.endsWith('/postgrest')));
});

test('when neither the project nor the platform says which schemas are served, it refuses instead of guessing', async () => {
  for (const platformDbSchema of ['', null]) {
    const { dir } = await makeApp();
    const fake = makeSharedProject({ rolconfig: null, platformDbSchema });
    await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'unknown-db-schemas' && !e.message.includes('jwt-secret'));
    assert.deepEqual(fake.state.writes, []);
    assert.deepEqual(fake.state.patches, []);
  }
});

test('probing still works when the API root needs the secret key (newer projects)', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject({ rootStatus: 401 });
  const result = await run({ appDir: dir }, fake);
  assert.deepEqual(result.probes.after, { public: 'ok', storage: 'ok', graphql_public: 'ok', [schema]: 'ok' });
  assert.ok(fake.state.probes.some((p) => p.path === '/rest/v1/_shipyard_probe_no_such_table'));
});

test('the new schema is given a moment to appear in the API before it is called missing', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({ exposeDelay: 2 });
  const result = await run({ appDir: dir }, fake);
  assert.equal(result.ok, true);
});

test('a new schema the API never serves is an error, with a plain way forward', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({ exposeDelay: 99 });
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'unexpected-change' && /does not serve the new schema/.test(e.message) && /safe to repeat/.test(e.message));
  assert.equal((await readAppConfig(dir)).shared, undefined, 'not recorded as done');
});

// ---------------------------------------------------------------------------------------------------------------
// Postflight: unexpected differences

test('if the API stops serving another schema, it stops with the exact commands to put things back', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject({ dropFromList: 'storage' });
  await assert.rejects(
    () => run({ appDir: dir }, fake),
    (e) => {
      assert.equal(e.data.reason, 'unexpected-change');
      assert.match(e.message, /stopped serving the schema "storage"/);
      assert.match(e.message, /Nothing was put back automatically/);
      assert.match(e.message, new RegExp(`ALTER ROLE authenticator SET pgrst\\.db_schemas = '${OLD_LIST}';`));
      assert.match(e.message, /NOTIFY pgrst, 'reload config'/);
      assert.match(e.message, /Site URL: https:\/\/first-app\.example\.com/);
      assert.match(e.message, /https:\/\/first-app\.example\.com\/\*\*/);
      assert.match(e.message, /http:\/\/localhost:3000\/\*\*/);
      assert.match(e.message, new RegExp(`DROP SCHEMA "${schema}" CASCADE`));
      assert.match(e.message, /shared-snapshot-/);
      assert.ok(e.data.restore.length > 5);
      return true;
    },
  );
  // Nothing was reverted on its own.
  assert.ok(!fake.state.writes.some((q) => /^alter role authenticator set pgrst\.db_schemas = 'public, storage, graphql_public';/i.test(q)));
  assert.equal((await readAppConfig(dir)).shared, undefined);
  assert.ok(!(await readFile(path.join(dir, '.env.local'), 'utf8')).includes('NEXT_PUBLIC_SUPABASE_SCHEMA'));
});

test('if something in the public schema changed, it stops and says what', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({
    onWrite: (q, state) => {
      if (q.includes('items_user_id_idx')) state.policies = state.policies.map((p) => ({ ...p, qual: 'true' }));
    },
  });
  await assert.rejects(
    () => run({ appDir: dir }, fake),
    (e) => e.data.reason === 'unexpected-change' && /privacy rules \(policies\) in the public schema changed/.test(e.message) && /ALTER ROLE authenticator SET/.test(e.message),
  );
});

test('a schema that was already not served before is only a warning, not blamed on this run', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({ rolconfig: ['pgrst.db_schemas=public, ghost'] });
  const inner = fake.fetch;
  // "ghost" is listed but the API never served it (for example it does not exist).
  fake.fetch = async (url, init) => (init?.headers?.['Accept-Profile'] === 'ghost' ? new Response(null, { status: 406 }) : inner(url, init));
  const result = await run({ appDir: dir }, fake);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /"ghost"/.test(w) && /before this run either/.test(w)));
});

test('a failing database step stops there, names the file and does not touch the API schema list', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({
    onWrite: (q) => (q.includes('items_user_id_idx') ? new Response(JSON.stringify({ message: 'syntax error near "x"' }), { status: 400 }) : undefined),
  });
  await assert.rejects(
    () => run({ appDir: dir }, fake),
    (e) => /"0002_items\.sql" failed/.test(e.message) && /Done before it stopped: .*0001_profiles\.sql/.test(e.message) && /Running the same command again/.test(e.message),
  );
  assert.ok(!fake.state.writes.some((q) => /alter role/i.test(q)));
  assert.deepEqual(fake.state.patches, []);
});

test('the sharing warning is printed once, and no key is printed', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject();
  const printed = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true; };
  log.setQuiet(false);
  try {
    await run({ appDir: dir }, fake);
  } finally {
    log.setQuiet(true);
    process.stdout.write = original;
  }
  const text = printed.join('');
  assert.equal(text.split('share one login list').length - 1, 1);
  assert.ok(text.includes(SHARED_WARNING.slice(0, 40)));
  for (const secret of [TOKEN, PUBLIC_KEY, SERVER_KEY, 'smtp-secret-value-123']) assert.ok(!text.includes(secret));
});

test('nothing ever puts a value into SQL that was not validated first', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject();
  await run({ appDir: dir }, fake);
  // Every identifier in the statements Shipyard built itself is the validated schema name.
  const schema = (await readAppConfig(dir)).schema;
  for (const q of [...fake.state.reads, ...fake.state.writes]) {
    for (const m of q.matchAll(/"([^"]+)"/g)) assert.ok([schema].includes(m[1]) || /^[a-z_]+$/.test(m[1]) || q.includes('create policy'), `unexpected quoted name ${m[1]}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The app's own code, the dry run's keys, the race on the schema list, a failure after it was written

test('an app whose code does not use the schema yet is refused before Supabase is asked anything', async () => {
  // Like a pilot built from an older template: no schema helper, clients that talk to `public`.
  const { dir } = await makeApp();
  await rm(path.join(dir, 'src', 'lib', 'supabase', 'schema.mjs'));
  const fake = makeSharedProject();
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => {
    assert.equal(e.data.reason, 'app-not-schema-aware');
    assert.match(e.message, /update the app to the current template first/i);
    assert.match(e.message, /schema\.mjs is missing/);
    return true;
  });
  assert.ok(noApiCalls(fake), 'nothing was asked of Supabase');
  assert.equal((await readAppConfig(dir)).shared, undefined);
});

test('every client file must pass the schema: an old client file is named and stops the run', async () => {
  for (const file of ['src/lib/supabase/client.ts', 'src/lib/supabase/server.ts', 'src/lib/admin.ts', 'src/proxy.ts', 'src/app/api/profile/route.ts']) {
    const { dir } = await makeApp();
    const full = path.join(dir, file);
    const code = await readFile(full, 'utf8');
    assert.match(code, /db:\s*\{\s*schema:\s*SUPABASE_SCHEMA\s*\}/, `${file} has the schema in the template`);
    await writeFile(full, code.replace(/db:\s*\{\s*schema:\s*SUPABASE_SCHEMA\s*\},?/, ''));
    const fake = makeSharedProject();
    await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'app-not-schema-aware' && e.message.includes(file), file);
    assert.ok(noApiCalls(fake), file);
  }
  // A required file that is gone counts too.
  const { dir } = await makeApp();
  await rm(path.join(dir, 'src', 'lib', 'admin.ts'));
  await assert.rejects(() => run({ appDir: dir }, makeSharedProject()), (e) => e.data.reason === 'app-not-schema-aware' && /admin\.ts is missing/.test(e.message));
});

test('the check passes for an app made from the current template', async () => {
  const { assertSchemaAware, schemaAwareProblems } = await import('../scripts/provision/app-schema-check.mjs');
  const { dir } = await makeApp();
  assert.deepEqual(await schemaAwareProblems(dir), []);
  await assertSchemaAware(dir);
});

test('a dry run asks only for the public key: the secret server key is never requested', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject();
  const result = await run({ appDir: dir, dryRun: true }, fake);
  assert.equal(result.ok, true);
  const keyCalls = fake.state.calls.filter((c) => c.route.endsWith('/api-keys'));
  assert.ok(keyCalls.length >= 1);
  assert.ok(keyCalls.every((c) => !/reveal/.test(c.query ?? '')), 'no reveal=true in a dry run');
  const everything = JSON.stringify([result, await readFile(path.join(dir, '.shipyard', (await readdir(path.join(dir, '.shipyard')))[0]), 'utf8')]);
  assert.ok(!everything.includes(SERVER_KEY));
  assert.ok(!fake.state.probes.some((p) => p.bearer?.includes(SERVER_KEY)));
  // A real run does ask for it (to write .env.local), only after the checks, and before the first change.
  const real = makeSharedProject();
  const { dir: dir2 } = await makeApp();
  await run({ appDir: dir2 }, real);
  const revealAt = real.state.calls.findIndex((c) => c.route.endsWith('/api-keys') && /reveal=true/.test(c.query ?? ''));
  const firstWriteAt = real.state.calls.findIndex((c) => c.route.endsWith('/database/query') && /create schema/.test(c.body?.query ?? ''));
  assert.ok(revealAt !== -1 && revealAt < firstWriteAt);
});

test('if another tool changes the schema list while the files run, nothing is written to it and the other change is kept', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({
    onWrite: (q, state) => {
      // Another app's factory appends its own schema in the window between our read and our write.
      if (q.includes('items_user_id_idx')) state.rolconfig = state.rolconfig.map((e) => (e.startsWith('pgrst.db_schemas=') ? `${e}, other_app_schema` : e));
    },
  });
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => {
    assert.equal(e.data.reason, 'db-schemas-changed');
    assert.match(e.message, /Another tool changed the project's list of exposed schemas/);
    assert.match(e.message, /wrote nothing to it/);
    assert.match(e.message, /Running the same command again/);
    assert.ok(!/ALTER ROLE/.test(e.message), 'nothing to put back: nothing was written');
    return true;
  });
  assert.equal(fake.state.rolconfig.at(-1), `pgrst.db_schemas=${OLD_LIST}, other_app_schema`, 'the other tool\'s schema is still there');
  assert.equal((await readAppConfig(dir)).shared, undefined);
  // Running it again sees the new list and appends to it.
  const again = await run({ appDir: dir }, fake);
  assert.equal(again.ok, true);
});

test('a failure after the schema list was written probes the other schemas and prints the restore commands', async () => {
  const { dir, schema } = await makeApp();
  // The sign-in address list needs a change (no localhost in it yet), and that call fails.
  const fake = makeSharedProject({ authConfig: { uri_allow_list: 'https://first-app.example.com/**' }, patchStatus: 400, dropFromList: 'storage' });
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => {
    assert.equal(e.data.reason, 'stopped-midway');
    assert.match(e.message, /added the schema to the API list/);
    assert.match(e.message, /The API no longer serves: storage/);
    assert.match(e.message, new RegExp(`ALTER ROLE authenticator SET pgrst\\.db_schemas = '${OLD_LIST}';`));
    assert.match(e.message, new RegExp(`DROP SCHEMA "${schema}" CASCADE`));
    assert.ok(e.data.restore.length > 5);
    return true;
  });
  assert.ok(fake.state.probes.some((p) => p.schema === 'storage'), 'the existing schemas were probed');
  // Nothing was put back by itself.
  assert.ok(!fake.state.writes.some((q) => /^alter role authenticator set pgrst\.db_schemas = 'public, storage, graphql_public';/i.test(q)));
});

test('a failure after the list was written, with every schema still served, still says how to put it back', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({ authConfig: { uri_allow_list: 'https://first-app.example.com/**' }, patchStatus: 400 });
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'stopped-midway' && /ALTER ROLE authenticator SET pgrst\.db_schemas/.test(e.message) && !/no longer serves/.test(e.message));
});

test('a failure before the list is written does not print restore commands for it', async () => {
  const { dir } = await makeApp();
  const fake = makeSharedProject({ onWrite: (q) => (q.includes('items_user_id_idx') ? new Response(JSON.stringify({ message: 'syntax error' }), { status: 400 }) : undefined) });
  await assert.rejects(() => run({ appDir: dir }, fake), (e) => !/ALTER ROLE/.test(e.message));
});

test('after the change, damage outside the public schema is caught: roles, other apps\' folders, extensions, Cron ...', async () => {
  const cases = [
    ['a database role was given to another (role memberships)', (state) => { state.snap.roleMembers = { n: 2, h: 'changed' }; }, /role belong to which|role memberships/i],
    ['a table in another app\'s schema was emptied or its row security changed', (state) => { state.snap.relations = { n: 5, h: 'changed' }; }, /tables, views or sequences outside/i],
    ['a policy outside public changed', (state) => { state.snap.policies = { n: 9, h: 'changed' }; }, /privacy rules \(policies\) outside/],
    ['a function outside public changed', (state) => { state.snap.functions = { n: 9, h: 'changed' }; }, /functions outside/],
    ['permissions on a schema changed', (state) => { state.snap.schemaAcls = { n: 9, h: 'changed' }; }, /permissions on the schemas/],
    ['default permissions changed', (state) => { state.snap.defaultAcls = { n: 9, h: 'changed' }; }, /default permissions/],
    ['column permissions changed', (state) => { state.snap.columnAcls = { n: 9, h: 'changed' }; }, /column permissions/],
    ['an extension was installed', (state) => { state.snap.extensions = { n: 9, h: 'changed' }; }, /installed extensions/],
    ['a publication changed', (state) => { state.snap.publications = { n: 9, h: 'changed' }; }, /publications/],
    ['an event trigger was added', (state) => { state.snap.eventTriggers = { n: 9, h: 'changed' }; }, /event triggers/],
    ['a trigger on another table was added', (state) => { state.snap.triggers = { n: 9, h: 'changed' }; }, /triggers on tables outside/],
    ['the Cron list changed', (state) => { state.cronExists = true; state.cron = { n: 2, h: 'changed' }; }, /scheduled jobs/],
    ['another sign-in setting changed', (state) => { state.authConfig.mailer_autoconfirm = true; }, /Another sign-in setting changed/],
  ];
  for (const [name, harm, pattern] of cases) {
    const { dir } = await makeApp();
    const fake = makeSharedProject({ onWrite: (q, state) => { if (q.includes('items_user_id_idx')) harm(state); } });
    await assert.rejects(() => run({ appDir: dir }, fake), (e) => e.data.reason === 'unexpected-change' && pattern.test(e.message) && /Nothing was put back automatically/.test(e.message), name);
    assert.equal((await readAppConfig(dir)).shared, undefined, name);
  }
});

test('the fingerprint questions leave out the app\'s own schema, only read, and keep nothing but a count and a hash', async () => {
  const { dir, schema } = await makeApp();
  const fake = makeSharedProject();
  await run({ appDir: dir }, fake);
  const tagged = fake.state.reads.filter((q) => /-- shipyard:snapshot:/.test(q));
  assert.ok(tagged.length >= 2 * 12, 'both snapshots asked every question');
  for (const q of tagged) {
    assert.ok(/^select /.test(q.trim()), 'reads only');
    if (!/cronExists|snapshot:cron\b/.test(q) && !/roleMembers|roles|extensions|publications|eventTriggers/.test(q)) {
      assert.ok(q.includes(`<> '${schema}'`), `leaves out the app's own schema: ${q.slice(0, 80)}`);
    }
  }
  const [name] = await readdir(path.join(dir, '.shipyard'));
  const snap = JSON.parse(await readFile(path.join(dir, '.shipyard', name), 'utf8'));
  assert.deepEqual(Object.keys(snap.pre.everywhere).sort(), ['columnAcls', 'cron', 'defaultAcls', 'eventTriggers', 'extensions', 'functions', 'policies', 'publications', 'relations', 'roleMembers', 'roles', 'schemaAcls', 'triggers']);
  for (const v of Object.values(snap.pre.everywhere)) assert.deepEqual(Object.keys(v).sort(), ['count', 'hash']);
  assert.match(snap.pre.auth.otherSettingsHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(snap).includes('smtp-secret-value-123'));
});

// ---------------------------------------------------------------------------------------------------------------
// The command line

function cli(args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'provision-supabase.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'home'), NO_COLOR: '1' },
  });
}

test('provision-supabase.mjs --shared: a bad project id is a plain error (exit 1) and --json carries it', async () => {
  const { dir } = await makeApp();
  const r = cli([dir, '--shared', 'nope', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /not a Supabase project id/);
});
