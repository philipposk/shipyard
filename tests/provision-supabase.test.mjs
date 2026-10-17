import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-supabase-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const P = await import('../scripts/provision/supabase-core.mjs');
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { loadProfile, saveProfile, defaultProfile } = await import('../scripts/lib/profile.mjs');
const { readAppConfig, updateAppConfig } = await import('../scripts/provision/common.mjs');

const TOKEN = `sbp_${'a1b2c3d4'.repeat(5)}`;
const PUBLIC_KEY = `sb_publishable_${'P'.repeat(30)}`;
const SERVER_KEY = `sb_secret_${'S'.repeat(30)}`;
const REF = 'abcdefghij0123456789';
const getSecret = async () => TOKEN;
const sleep = async () => {};

/** A tiny in-memory stand-in for the Supabase Management API. */
function makeSupabase({ projects = [], authConfig, keys, failSql, orgPlans } = {}) {
  const state = {
    projects: projects.map((p) => ({ ...p })),
    authConfig: { site_url: 'http://localhost:3000', uri_allow_list: '', ...(authConfig ?? {}) },
    applied: new Set(),
    tables: [],
    calls: [],
    sql: [],
    patches: [],
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const route = `${init.method ?? 'GET'} ${u.pathname.replace(/^\/v1/, '')}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ route, auth: init.headers?.Authorization, body, search: u.search });
    if (route === 'GET /projects') return json(state.projects);
    const om = /^GET \/organizations\/([^/]+)$/.exec(route);
    if (om && orgPlans) return orgPlans[om[1]] ? json({ slug: om[1], plan: orgPlans[om[1]] }) : json({ message: 'not found' }, 404);
    if (route === 'POST /projects') {
      const project = { id: REF, ref: REF, name: body.name, organization_slug: body.organization_slug, status: 'COMING_UP', region: body.region_selection?.code };
      state.projects.push(project);
      return json(project, 201);
    }
    let m = /^GET \/projects\/([^/]+)$/.exec(route);
    if (m) {
      const p = state.projects.find((x) => x.ref === m[1] || x.id === m[1]);
      if (!p) return json({ message: 'not found' }, 404);
      const snapshot = { ...p };
      if (p.status === 'COMING_UP') p.status = 'ACTIVE_HEALTHY';
      return json(snapshot);
    }
    m = /^POST \/projects\/([^/]+)\/database\/query$/.exec(route);
    if (m) {
      state.sql.push(body.query);
      const failure = failSql?.(body.query, state);
      if (failure) return failure;
      if (body.query.includes('select name from public._shipyard_migrations')) return json([...state.applied].map((name) => ({ name })));
      if (body.query.includes('information_schema.tables')) return json((state.tables ?? []).map((table_name) => ({ table_name })));
      const ins = /insert into public\._shipyard_migrations \(name\) values \('((?:[^']|'')*)'\)/.exec(body.query);
      if (ins) state.applied.add(ins[1].replace(/''/g, "'"));
      return json([]);
    }
    if (/^GET \/projects\/[^/]+\/api-keys$/.test(route)) {
      return json(keys ?? [
        { type: 'publishable', name: 'default', api_key: PUBLIC_KEY },
        { type: 'secret', name: 'default', api_key: SERVER_KEY },
      ]);
    }
    if (/^GET \/projects\/[^/]+\/config\/auth$/.test(route)) return json(state.authConfig);
    if (/^PATCH \/projects\/[^/]+\/config\/auth$/.test(route)) {
      state.patches.push(body);
      Object.assign(state.authConfig, body);
      return json(state.authConfig);
    }
    return json({ message: `no route ${route}` }, 404);
  };
  return { fetch, state, count: (route) => state.calls.filter((c) => c.route === route).length };
}

let n = 0;
async function makeApp(slugBase = 'sb-app') {
  const slug = `${slugBase}-${++n}`;
  const parent = path.join(tmp, `p${n}`);
  await scaffold({ slug, name: slug, description: 'd', parent });
  return { slug, dir: path.join(parent, slug) };
}

before(async () => {
  const p = defaultProfile();
  p.accounts.supabase.orgId = 'my-org';
  p.accounts.vercel.scope = 'my-team';
  await saveProfile(p);
});
after(() => rm(tmp, { recursive: true, force: true }));

const deps = (fake, extra = {}) => ({ fetch: fake.fetch, sleep, getSecret, ...extra });

test('a first run creates the project, builds the database, sets sign-in addresses and saves keys', async () => {
  const { slug, dir } = await makeApp();
  await writeFile(path.join(dir, '.env.local'), `# mine\nCUSTOM_FLAG=1\n${await readFile(path.join(dir, '.env.local'), 'utf8')}`);
  const fake = makeSupabase();
  const result = await P.provisionSupabase({ appDir: dir }, deps(fake));

  assert.equal(result.ok, true);
  assert.equal(result.ref, REF);
  assert.equal(result.url, `https://${REF}.supabase.co`);
  assert.equal(result.created, true);
  assert.deepEqual(result.migrations.applied, ['0001_profiles.sql', '0002_items.sql', '0003_email_lookup.sql']);

  // Every call used the token; the project was made with the organization slug and the default region.
  assert.ok(fake.state.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  const create = fake.state.calls.find((c) => c.route === 'POST /projects');
  assert.equal(create.body.name, slug);
  assert.equal(create.body.organization_slug, 'my-org');
  assert.deepEqual(create.body.region_selection, { type: 'specific', code: 'eu-central-1' });
  assert.match(create.body.db_pass, /^[A-Za-z0-9]{32}$/);

  // Migrations ran in filename order and are recorded per app.
  const migrationSql = fake.state.sql.filter((q) => q.includes('insert into public._shipyard_migrations'));
  assert.equal(migrationSql.length, 3);
  assert.ok(migrationSql[0].includes('public.profiles') && migrationSql[1].includes('public.items'));
  assert.deepEqual([...fake.state.applied], [`${slug}/0001_profiles.sql`, `${slug}/0002_items.sql`, `${slug}/0003_email_lookup.sql`]);
  assert.match(fake.state.sql[0], /_shipyard_migrations/);
  assert.match(fake.state.sql[0], /enable row level security/);

  // Sign-in settings.
  assert.equal(fake.state.patches.length, 1);
  assert.equal(fake.state.authConfig.site_url, 'http://localhost:3000');
  assert.deepEqual(fake.state.authConfig.uri_allow_list.split(','), [
    'http://localhost:3000/**',
  ]);

  // Keys landed in .env.local, other lines survived, the file is private.
  const env = await readFile(path.join(dir, '.env.local'), 'utf8');
  assert.match(env, /^# mine$/m);
  assert.match(env, /^CUSTOM_FLAG=1$/m);
  assert.match(env, /^NEXT_PUBLIC_SITE_URL=http:\/\/localhost:3000$/m);
  assert.match(env, new RegExp(`^NEXT_PUBLIC_SUPABASE_URL=https://${REF}\\.supabase\\.co$`, 'm'));
  assert.match(env, new RegExp(`^NEXT_PUBLIC_SUPABASE_ANON_KEY=${PUBLIC_KEY}$`, 'm'));
  assert.match(env, new RegExp(`^SUPABASE_SERVICE_ROLE_KEY=${SERVER_KEY}$`, 'm'));
  if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, '.env.local'))).mode & 0o077, 0);

  // Recorded in the app file and the profile.
  assert.equal((await readAppConfig(dir)).supabaseRef, REF);
  const app = (await loadProfile()).apps.find((a) => a.slug === slug);
  assert.equal(app.supabaseRef, REF);
  assert.equal(app.status, 'provisioned');

  // The result and the app file never hold a key or the token.
  const printed = JSON.stringify(result) + (await readFile(path.join(dir, '.shipyard-app.json'), 'utf8')) + JSON.stringify(app);
  for (const secret of [TOKEN, PUBLIC_KEY, SERVER_KEY, create.body.db_pass]) assert.ok(!printed.includes(secret));
});

test('running it again changes nothing and creates nothing', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase();
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  const envBefore = await readFile(path.join(dir, '.env.local'), 'utf8');
  const callsBefore = fake.state.calls.length;
  const again = await P.provisionSupabase({ appDir: dir }, deps(fake));

  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.deepEqual(again.migrations.applied, []);
  assert.equal(again.migrations.skipped.length, 3);
  assert.equal(fake.count('POST /projects'), 1);
  assert.equal(fake.state.patches.length, 1, 'no second PATCH');
  assert.equal(again.auth.changed, false);
  assert.equal(await readFile(path.join(dir, '.env.local'), 'utf8'), envBefore);
  assert.ok(fake.state.calls.length > callsBefore);
  assert.equal(fake.state.sql.filter((q) => q.includes('insert into public._shipyard_migrations')).length, 3);
  assert.equal(slug.startsWith('sb-app'), true);
});

test('a half-finished run continues with the project it already created', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase({ failSql: (q) => (q.includes('public.items') ? new Response(JSON.stringify({ message: 'syntax error near x' }), { status: 400 }) : undefined) });
  await assert.rejects(() => P.provisionSupabase({ appDir: dir }, deps(fake)), /0002_items\.sql/);
  assert.equal((await readAppConfig(dir)).supabaseRef, REF, 'ref saved right after creating the project');

  const healed = makeSupabase({ projects: fake.state.projects });
  healed.state.applied = new Set(fake.state.applied);
  const ok = await P.provisionSupabase({ appDir: dir }, deps(healed));
  assert.equal(ok.created, false);
  assert.equal(healed.count('POST /projects'), 0);
  assert.deepEqual(ok.migrations.applied, ['0002_items.sql', '0003_email_lookup.sql']);
  assert.deepEqual(ok.migrations.skipped, ['0001_profiles.sql']);
});

test('a failing database step stops there and says which file', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase({ failSql: (q) => (q.includes('public.items') ? new Response(JSON.stringify({ message: 'relation "x" does not exist' }), { status: 400 }) : undefined) });
  await assert.rejects(
    () => P.provisionSupabase({ appDir: dir }, deps(fake)),
    (e) => /0002_items\.sql/.test(e.message) && /nothing after it was run/.test(e.message) && /does not exist/.test(e.message),
  );
  assert.deepEqual([...fake.state.applied], [`${slug}/0001_profiles.sql`]);
  assert.ok(!fake.state.sql.some((q) => q.includes('auth_user_id_by_email')), '0003 never ran');
  assert.equal(fake.state.patches.length, 0);
  assert.ok(!(await readFile(path.join(dir, '.env.local'), 'utf8')).includes('SUPABASE_SERVICE_ROLE_KEY'), 'no keys written after a failure');
});

test('a database that is not ready yet is retried', async () => {
  const { dir } = await makeApp();
  let failures = 2;
  const fake = makeSupabase({ failSql: () => (failures-- > 0 ? new Response('upstream down', { status: 503 }) : undefined) });
  const naps = [];
  const result = await P.provisionSupabase({ appDir: dir }, deps(fake, { sleep: async (ms) => { naps.push(ms); } }));
  assert.equal(result.ok, true);
  assert.ok(naps.length >= 2);
});

test('the free plan limit stops before creating anything and lists the active projects', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase({
    projects: [
      { id: 'aaaaaaaaaaaaaaaaaaaa', ref: 'aaaaaaaaaaaaaaaaaaaa', name: 'old-one', organization_slug: 'my-org', status: 'ACTIVE_HEALTHY' },
      { id: 'bbbbbbbbbbbbbbbbbbbb', ref: 'bbbbbbbbbbbbbbbbbbbb', name: 'old-two', organization_slug: 'my-org', status: 'COMING_UP' },
      { id: 'cccccccccccccccccccc', ref: 'cccccccccccccccccccc', name: 'paused-one', organization_slug: 'my-org', status: 'INACTIVE' },
      { id: 'dddddddddddddddddddd', ref: 'dddddddddddddddddddd', name: 'other-org', organization_slug: 'someone-else', status: 'ACTIVE_HEALTHY' },
    ],
  });
  await assert.rejects(
    () => P.provisionSupabase({ appDir: dir }, deps(fake)),
    (e) => {
      assert.match(e.message, /old-one/);
      assert.match(e.message, /old-two/);
      assert.ok(!/paused-one/.test(e.message));
      assert.match(e.message, /other-org/); // the limit counts every organization
      assert.match(e.message, /Pause a project/);
      assert.ok(e.message.indexOf('Pause a project') < e.message.indexOf('--shared'), 'pausing is offered first');
      assert.match(e.message, /dashboard/);
      assert.match(e.message, /--shared <project id>/);
      assert.match(e.message, /safe: the app gets its own space/);
      assert.match(e.message, /does not touch the other apps/);
      assert.ok(!/--reuse/.test(e.message), 'the old unsafe option is gone');
      assert.equal(e.data.reason, 'free-limit');
      assert.deepEqual(e.data.activeProjects.map((p) => p.name), ['old-one', 'old-two', 'other-org']);
      return true;
    },
  );
  assert.equal(fake.count('POST /projects'), 0);
});

test('one active project plus a paused one is under the limit', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase({
    projects: [
      { id: 'aaaaaaaaaaaaaaaaaaaa', ref: 'aaaaaaaaaaaaaaaaaaaa', name: 'old-one', organization_slug: 'my-org', status: 'ACTIVE_HEALTHY' },
      { id: 'cccccccccccccccccccc', ref: 'cccccccccccccccccccc', name: 'paused-one', organization_slug: 'my-org', status: 'INACTIVE' },
    ],
  });
  const result = await P.provisionSupabase({ appDir: dir, region: 'us-east-1' }, deps(fake));
  assert.equal(result.created, true);
  assert.equal(fake.state.calls.find((c) => c.route === 'POST /projects').body.region_selection.code, 'us-east-1');
});

test('the limit counts projects in other organizations too, before anything is created', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase({
    projects: [
      { id: 'aaaaaaaaaaaaaaaaaaaa', ref: 'aaaaaaaaaaaaaaaaaaaa', name: 'full-org-a', organization_slug: 'full-org', status: 'ACTIVE_HEALTHY' },
      { id: 'bbbbbbbbbbbbbbbbbbbb', ref: 'bbbbbbbbbbbbbbbbbbbb', name: 'full-org-b', organization_slug: 'full-org', status: 'ACTIVE_HEALTHY' },
    ],
  }); // the chosen org ("my-org") is empty, but the account is already full
  await assert.rejects(
    () => P.provisionSupabase({ appDir: dir }, deps(fake)),
    (e) => e.data.reason === 'free-limit' && /another organization/.test(e.message) && /--shared <project id>/.test(e.message) && !/--reuse/.test(e.message),
  );
  assert.equal(fake.count('POST /projects'), 0);
});

test('a limit refusal from Supabase itself becomes the friendly message', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  const inner = fake.fetch;
  fake.fetch = async (url, init = {}) => (init.method === 'POST' && new URL(url).pathname === '/v1/projects'
    ? new Response(JSON.stringify({ message: 'The following organization members have reached their maximum limits for the number of active free projects (someone (2 project limit)).' }), { status: 400 })
    : inner(url, init));
  await assert.rejects(
    () => P.provisionSupabase({ appDir: dir }, deps(fake)),
    (e) => e.data?.reason === 'free-limit' && /Pause/.test(e.message) && !/HTTP 400/.test(e.message) && !/you already have 0/.test(e.message),
  );
});

test('projects in a paid organization do not count toward the free limit', async () => {
  const { dir } = await makeApp();
  const pro = (n, c) => ({ id: c.repeat(20), ref: c.repeat(20), name: n, organization_slug: 'pro-org', status: 'ACTIVE_HEALTHY' });
  const fake = makeSupabase({
    projects: [pro('p1', 'a'), pro('p2', 'b'), pro('p3', 'c')],
    orgPlans: { 'pro-org': 'pro', 'my-org': 'free' },
  });
  const result = await P.provisionSupabase({ appDir: dir }, deps(fake));
  assert.equal(result.created, true);
  assert.equal(fake.count('POST /projects'), 1);
});

/** An app made before shared-schema mode: it sits in the public schema of a project other apps use. */
async function makeLegacySharedApp(shared) {
  const made = await makeApp();
  await updateAppConfig(made.dir, { supabaseRef: shared, supabaseShared: true });
  return made;
}

test('--reuse is gone: the core refuses it and points to --shared', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  await assert.rejects(
    () => P.provisionSupabase({ appDir: dir, reuse: 'zzzzzzzzzzzzzzzzzzzz' }, deps(fake)),
    (e) => /--reuse was removed/.test(e.message) && /--shared <project id>/.test(e.message),
  );
  assert.equal(fake.state.calls.length, 0, 'nothing was asked of Supabase');
});

test('an older shared app (supabaseShared) still leaves another app\'s main address alone', async () => {
  const shared = 'zzzzzzzzzzzzzzzzzzzz';
  const { slug, dir } = await makeLegacySharedApp(shared);
  const fake = makeSupabase({
    projects: [{ id: shared, ref: shared, name: 'shared-db', organization_slug: 'my-org', status: 'ACTIVE_HEALTHY' }],
    authConfig: { site_url: 'https://first-app.vercel.app', uri_allow_list: 'https://first-app.vercel.app/**' },
  });
  const result = await P.provisionSupabase({ appDir: dir }, deps(fake));
  assert.equal(result.ref, shared);
  assert.equal(result.shared, true);
  assert.equal(result.created, false);
  assert.equal(fake.count('POST /projects'), 0);
  assert.equal(fake.state.authConfig.site_url, 'https://first-app.vercel.app');
  assert.ok(fake.state.authConfig.uri_allow_list.split(',').includes('https://first-app.vercel.app/**'));
  assert.ok(!fake.state.authConfig.uri_allow_list.includes('*.vercel.app'), 'no wildcard preview address');
  assert.ok(!fake.state.authConfig.uri_allow_list.includes(`${slug}-*`));
});

test('an older shared app is refused when table names overlap, and nothing is changed', async () => {
  const shared = 'zzzzzzzzzzzzzzzzzzzz';
  const { dir } = await makeLegacySharedApp(shared);
  const fake = makeSupabase({ projects: [{ id: shared, ref: shared, name: 'shared-db', organization_slug: 'my-org', status: 'ACTIVE_HEALTHY' }] });
  fake.state.applied.add('first-app/0001_profiles.sql');
  fake.state.tables = ['profiles', 'items', '_shipyard_migrations'];
  await assert.rejects(
    () => P.provisionSupabase({ appDir: dir }, deps(fake)),
    (e) => e.data.reason === 'shared-overlap' && /first-app/.test(e.message) && /profiles/.test(e.message) && /items/.test(e.message) && /Nothing was changed/.test(e.message) && !/--reuse/.test(e.message),
  );
  assert.equal(fake.state.sql.filter((q) => q.includes('public.profiles')).length, 0, 'no migration ran');
  assert.equal(fake.state.patches.length, 0, 'sign-in settings untouched');
});

test('an older shared app with no overlapping table names goes ahead with a warning in the result', async () => {
  const shared = 'zzzzzzzzzzzzzzzzzzzz';
  const { dir } = await makeLegacySharedApp(shared);
  const fake = makeSupabase({ projects: [{ id: shared, ref: shared, name: 'shared-db', organization_slug: 'my-org', status: 'ACTIVE_HEALTHY' }] });
  fake.state.applied.add('first-app/0001_notes.sql');
  fake.state.tables = ['notes'];
  const result = await P.provisionSupabase({ appDir: dir }, deps(fake));
  assert.equal(result.shared, true);
  assert.deepEqual(result.sharedWith, ['first-app']);
});

test('tablesCreatedBy finds public tables and ignores other schemas and comments', () => {
  const found = P.tablesCreatedBy([
    { sql: '-- create table fake (x int);\ncreate table if not exists public.profiles (id uuid);\ncreate table items (id uuid);\ncreate table "notes" (id uuid);\ncreate table auth.hack (id uuid);' },
  ]);
  assert.deepEqual(found.sort(), ['items', 'notes', 'profiles']);
});

test('a bad region is refused before anything is created', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  await assert.rejects(() => P.provisionSupabase({ appDir: dir, region: 'Mars' }, deps(fake)), /region/);
  assert.equal(fake.count('POST /projects'), 0);
});

test('--schema and --dry-run without --shared are refused', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  await assert.rejects(() => P.provisionSupabase({ appDir: dir, dryRun: true }, deps(fake)), /--shared/);
  await assert.rejects(() => P.provisionSupabase({ appDir: dir, schema: 'app_x' }, deps(fake)), /--shared/);
  assert.equal(fake.state.calls.length, 0);
});

test('a project with the app\'s name that is not recorded is not adopted silently', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase({ projects: [{ id: 'eeeeeeeeeeeeeeeeeeee', ref: 'eeeeeeeeeeeeeeeeeeee', name: slug, organization_slug: 'my-org', status: 'ACTIVE_HEALTHY' }] });
  await assert.rejects(() => P.provisionSupabase({ appDir: dir }, deps(fake)), (e) => /already exists/.test(e.message) && /eeeeeeeeeeeeeeeeeeee/.test(e.message) && /supabaseRef/.test(e.message) && !/--reuse/.test(e.message));
  assert.equal(fake.count('POST /projects'), 0);
});

test('a recorded project that no longer exists is reported, not recreated', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  const empty = makeSupabase();
  await assert.rejects(() => P.provisionSupabase({ appDir: dir }, deps(empty)), /was not found in your account/);
  assert.equal(empty.count('POST /projects'), 0);
});

test('legacy keys are accepted when the project has no new-style keys', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase({
    keys: [
      { type: 'legacy', name: 'anon', api_key: 'eyJanon.payload.sig-anon' },
      { type: 'legacy', name: 'service_role', api_key: 'eyJservice.payload.sig-service' },
    ],
  });
  const result = await P.provisionSupabase({ appDir: dir }, deps(fake));
  assert.equal(result.keyKind, 'legacy');
  const env = await readFile(path.join(dir, '.env.local'), 'utf8');
  assert.match(env, /^NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJanon\.payload\.sig-anon$/m);
  assert.match(env, /^SUPABASE_SERVICE_ROLE_KEY=eyJservice\.payload\.sig-service$/m);
});

test('it refuses to write keys when git would not ignore .env.local, before any network call', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  const run = async (cmd, args) => (cmd === 'git' && args[0] === 'check-ignore' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  await assert.rejects(() => P.provisionSupabase({ appDir: dir }, deps(fake, { run })), /\.gitignore/);
  assert.equal(fake.state.calls.length, 0);
});

test('envLocalIsIgnored falls back to .gitignore when git is unavailable', async () => {
  const { dir } = await makeApp();
  const noGit = async () => ({ code: 128, stdout: '', stderr: 'fatal' });
  assert.equal(await P.envLocalIsIgnored(noGit, dir), true, 'template .gitignore covers .env.local');
  await writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  assert.equal(await P.envLocalIsIgnored(noGit, dir), false);
});

test('without a saved organization or token it explains the setup step', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  const saved = await loadProfile();
  const blank = defaultProfile();
  await saveProfile(blank);
  try {
    await assert.rejects(() => P.provisionSupabase({ appDir: dir }, deps(fake)), /\/shipyard:setup/);
  } finally {
    await saveProfile(saved);
  }
  // Real getSecret: no keys file in the temp home.
  await assert.rejects(
    () => P.provisionSupabase({ appDir: dir }, { fetch: fake.fetch, sleep }),
    (e) => e.name === 'MissingSecretError' && /SUPABASE_ACCESS_TOKEN/.test(e.message) && !e.message.includes(TOKEN),
  );
  assert.equal(fake.state.calls.length, 0);
});

test('--url only touches the sign-in settings and never removes an address', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase();
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  fake.state.authConfig.uri_allow_list += ',https://keep-me.example/**';
  const before = fake.state.calls.length;
  const result = await P.provisionSupabase({ appDir: dir, url: `https://${slug}.vercel.app/some/path` }, deps(fake));

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(fake.state.authConfig.site_url, `https://${slug}.vercel.app`);
  const list = fake.state.authConfig.uri_allow_list.split(',');
  assert.ok(list.includes('https://keep-me.example/**'));
  assert.ok(list.includes(`https://${slug}.vercel.app/**`));
  assert.ok(list.includes('http://localhost:3000/**'));
  assert.equal(new Set(list).size, list.length);
  const newCalls = fake.state.calls.slice(before).map((c) => c.route);
  assert.deepEqual(newCalls, ['GET /projects/' + REF + '/config/auth', 'PATCH /projects/' + REF + '/config/auth', 'GET /projects/' + REF + '/config/auth']);

  // Same address again: nothing to change.
  const same = await P.provisionSupabase({ appDir: dir, url: `https://${slug}.vercel.app` }, deps(fake));
  assert.equal(same.changed, false);
  assert.equal(fake.state.patches.length, 2);
});

test('a later normal run keeps the real address that deploy saved', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase();
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  await P.provisionSupabase({ appDir: dir, url: `https://${slug}.vercel.app` }, deps(fake));
  const { updateAppConfig } = await import('../scripts/provision/common.mjs');
  await updateAppConfig(dir, { url: `https://${slug}.vercel.app` });
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  assert.equal(fake.state.authConfig.site_url, `https://${slug}.vercel.app`);
});

test('--url needs a project and a real web address', async () => {
  const { dir } = await makeApp();
  const fake = makeSupabase();
  await assert.rejects(() => P.provisionSupabase({ appDir: dir, url: 'https://x.vercel.app' }, deps(fake)), /no Supabase project yet/);
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  await assert.rejects(() => P.provisionSupabase({ appDir: dir, url: 'not-a-url' }, deps(fake)), /not a web address/);
});

test('a folder that is not a Shipyard app is refused', async () => {
  const empty = await mkdtemp(path.join(tmp, 'plain-'));
  await assert.rejects(() => P.provisionSupabase({ appDir: empty }, deps(makeSupabase())), /not made by Shipyard/);
});

test('countsAsActive, refOf and orgOf read the shapes the API sends', () => {
  assert.equal(P.countsAsActive({ status: 'ACTIVE_HEALTHY' }), true);
  assert.equal(P.countsAsActive({ status: 'COMING_UP' }), true);
  assert.equal(P.countsAsActive({ status: 'INACTIVE' }), false);
  assert.equal(P.refOf({ id: 'abc' }), 'abc');
  assert.equal(P.refOf({ ref: 'r', id: 'i' }), 'r');
  assert.equal(P.orgOf({ organization_id: 'o' }), 'o');
  assert.equal(P.migrationKey('a', '0001_x.sql'), 'a/0001_x.sql');
});

function cli(args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'provision-supabase.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'home'), NO_COLOR: '1' },
  });
}

test('provision-supabase.mjs: --help exits 0, missing folder exits 2, unknown folder exits 1', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--shared/);
  assert.match(help.stdout, /--dry-run/);
  assert.ok(!/--reuse/.test(help.stdout), 'the old option is gone from the help');
  assert.equal(cli(['x', '--reuse', 'zzzzzzzzzzzzzzzzzzzz']).status, 2);
  assert.match(cli(['x', '--reuse', 'zzzzzzzzzzzzzzzzzzzz', '--json']).stdout, /--shared/);
  assert.equal(cli(['x', '--dry-run']).status, 2);
  assert.equal(cli(['x', '--url', 'https://a.example', '--shared', 'zzzzzzzzzzzzzzzzzzzz']).status, 2);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['a', 'b']).status, 2);
  assert.equal(cli(['x', '--nope']).status, 2);
  const missing = cli([path.join(tmp, 'does-not-exist'), '--json']);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
});

test('updateAuthUrls re-checks after the write and retries when another app overwrote the list', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase({ authConfig: { uri_allow_list: 'https://a.example/**' } });
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  const inner = fake.fetch;
  let raced = false;
  fake.fetch = async (url, init = {}) => {
    const res = await inner(url, init);
    // Another app's write lands right after ours and replaces the list with its own older copy plus its address.
    if (!raced && init.method === 'PATCH' && String(url).endsWith('/config/auth')) {
      raced = true;
      fake.state.authConfig.uri_allow_list = 'https://a.example/**,https://racer.example/**';
    }
    return res;
  };
  await P.provisionSupabase({ appDir: dir, url: `https://${slug}.vercel.app` }, deps(fake));
  const list = fake.state.authConfig.uri_allow_list.split(',');
  assert.ok(raced);
  assert.ok(list.includes('https://racer.example/**'), 'the other app address survives');
  assert.ok(list.includes(`https://${slug}.vercel.app/**`), 'ours was put back');
  assert.ok(list.includes('https://a.example/**'));
});

test('updateAuthUrls gives up with the lost addresses after 3 tries', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase();
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  const inner = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    const res = await inner(url, init);
    if (init.method === 'PATCH' && String(url).endsWith('/config/auth')) fake.state.authConfig.uri_allow_list = 'https://z.example/**';
    return res;
  };
  await assert.rejects(() => P.provisionSupabase({ appDir: dir, url: `https://${slug}.vercel.app` }, deps(fake)), /lost/);
});

test('updateAuthUrls does not rewrite the shared list when only spacing differs', async () => {
  const { slug, dir } = await makeApp();
  const fake = makeSupabase();
  await P.provisionSupabase({ appDir: dir }, deps(fake));
  fake.state.authConfig.uri_allow_list = fake.state.authConfig.uri_allow_list.split(',').join(' , ') + ',';
  const patches = fake.state.patches.length;
  const r = await P.provisionSupabase({ appDir: dir, url: `https://${slug}.vercel.app` }, deps(fake));
  assert.equal(fake.state.patches.length, patches + 1, 'first --url adds the real address');
  const again = fake.state.patches.length;
  fake.state.authConfig.uri_allow_list = fake.state.authConfig.uri_allow_list.split(',').join(' , ');
  const r2 = await P.provisionSupabase({ appDir: dir, url: `https://${slug}.vercel.app` }, deps(fake));
  assert.equal(r2.changed, false);
  assert.equal(fake.state.patches.length, again);
  assert.ok(r);
});
