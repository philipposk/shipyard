// Shared-project mode: the snapshot, the comparison (allowed vs unexpected), the PostgREST probes, the restore text,
// and the redirect-address merge. Fakes only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Snap from '../scripts/provision/shared-snapshot.mjs';
import * as api from '../scripts/lib/supabase-api.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-shared-snap-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const P = await import('../scripts/provision/supabase-core.mjs');
const { makeSharedProject, REF, TOKEN, PUBLIC_KEY, sleep } = await import('./provision-shared-helpers.mjs');
after(() => rm(tmp, { recursive: true, force: true }));

const auth = (fake) => ({ token: TOKEN, fetch: fake.fetch, sleep });
const execOn = (fake) => async (sql) => JSON.parse(await (await fake.fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ query: sql }) })).text());
const snapOf = (fake) => Snap.takeSnapshot({ auth: auth(fake), ref: REF, exec: execOn(fake), api, now: () => new Date('2026-10-18T10:00:00Z'), schema: 'app_x' });

const clone = (x) => JSON.parse(JSON.stringify(x));
const expectAdd = { schema: 'app_x', dbSchemasAfter: ['public', 'storage', 'graphql_public', 'app_x'], allowListAdds: ['https://app.example.com/**'] };

// ---------- the snapshot ----------

test('snapshot: what is recorded, and that no secret or email-server value is', async () => {
  const fake = makeSharedProject();
  const s = await snapOf(fake);
  assert.equal(s.takenAt, '2026-10-18T10:00:00.000Z');
  assert.equal(s.auth.siteUrl, 'https://first-app.example.com');
  assert.equal(s.auth.uriAllowList, 'https://first-app.example.com/**,http://localhost:3000/**');
  assert.deepEqual(s.auth.smtpFieldsSet, { smtp_host: true, smtp_pass: true });
  assert.deepEqual(s.apiRole.dbSchemas, { present: true, raw: 'public, storage, graphql_public' });
  assert.equal(s.apiRole.otherSettings.length, 1);
  assert.equal(s.apiRole.otherSettings[0].name, 'statement_timeout');
  assert.match(s.apiRole.otherSettings[0].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(s.authUsersTriggers, [{ name: 'on_auth_user_created', fn: 'public.handle_new_user' }]);
  assert.ok(s.schemas.includes('public') && s.schemas.includes('auth'));
  assert.equal(s.publicPolicies.count, 1);
  assert.equal(s.publicGrants.count, 1);
  assert.equal(s.publicFunctions.count, 1);
  const text = JSON.stringify(s);
  for (const secret of ['smtp-secret-value-123', 'smtp.example.com', '8s']) assert.ok(!text.includes(secret), secret);
  // Only reads were sent.
  assert.deepEqual(fake.state.writes, []);
  assert.ok(fake.state.reads.length >= 6 + 13);
  assert.ok(fake.state.reads.every((q) => /^select /i.test(q.trim())));
});

test('snapshot: missing settings are recorded as missing; empty smtp fields count as not set', async () => {
  const fake = makeSharedProject({ rolconfig: null, authConfig: { smtp_host: '', smtp_pass: null } });
  const s = await snapOf(fake);
  assert.deepEqual(s.apiRole.dbSchemas, { present: false, raw: null });
  assert.deepEqual(s.apiRole.otherSettings, []);
  assert.deepEqual(s.auth.smtpFieldsSet, { smtp_host: false, smtp_pass: false });
});

test('snapshot file: saved in .shipyard with the UTC stamp in its name', async () => {
  assert.equal(Snap.utcStamp(new Date('2026-10-18T10:15:30.123Z')), '20261018T101530Z');
  const file = await Snap.saveSnapshotFile(tmp, 'shared-snapshot-20261018T101530Z.json', { a: 1 });
  assert.equal(file, path.join(tmp, '.shipyard', 'shared-snapshot-20261018T101530Z.json'));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 1 });
});

// ---------- the comparison ----------

async function beforeAfter(mutatePost, { mutateFake } = {}) {
  const fake = makeSharedProject();
  const pre = await snapOf(fake);
  const post = clone(pre);
  post.apiRole.dbSchemas.raw = 'public, storage, graphql_public, app_x';
  post.schemas = [...post.schemas, 'app_x'].sort();
  post.auth.uriAllowList += ',https://app.example.com/**';
  mutatePost?.(post);
  return { pre, post };
}

test('diff: exactly the allowed changes pass, and are described', async () => {
  const { pre, post } = await beforeAfter();
  const d = Snap.diffSnapshots(pre, post, expectAdd);
  assert.deepEqual(d.unexpected, []);
  assert.equal(d.ok, true);
  assert.equal(d.allowed.length, 3);
  assert.ok(d.allowed.some((a) => /API now also exposes: app_x/.test(a)));
  assert.ok(d.allowed.some((a) => /Redirect addresses added: https:\/\/app\.example\.com\/\*\*/.test(a)));
  assert.ok(d.allowed.some((a) => /own schema "app_x" was created/.test(a)));
});

test('diff: no changes at all (a re-run) is fine too', async () => {
  const fake = makeSharedProject();
  const pre = await snapOf(fake);
  const d = Snap.diffSnapshots(pre, clone(pre), { schema: 'app_x', dbSchemasAfter: ['public', 'storage', 'graphql_public'], allowListAdds: [] });
  assert.equal(d.ok, true);
  assert.deepEqual(d.allowed, []);
});

const unexpectedCases = [
  ['the main sign-in address changed', (p) => { p.auth.siteUrl = 'https://app.example.com'; }, /site URL.*changed/],
  ['an email server field appeared or vanished', (p) => { p.auth.smtpFieldsSet.smtp_pass = false; }, /email \(SMTP\) settings changed/],
  ['a redirect address was removed', (p) => { p.auth.uriAllowList = 'https://app.example.com/**'; }, /removed: .*first-app/],
  ['a redirect address that is not this app\'s was added', (p) => { p.auth.uriAllowList += ',https://evil.example/**'; }, /not this app's: https:\/\/evil\.example\/\*\*/],
  ['the API schema list lost an entry', (p) => { p.apiRole.dbSchemas.raw = 'public, graphql_public, app_x'; }, /exposes is "public, graphql_public, app_x", expected/],
  ['the API schema list was reordered', (p) => { p.apiRole.dbSchemas.raw = 'storage, public, graphql_public, app_x'; }, /expected/],
  ['the API schema list gained something else', (p) => { p.apiRole.dbSchemas.raw += ', other'; }, /expected/],
  ['another setting on the API role changed', (p) => { p.apiRole.otherSettings[0].hash = 'x'; }, /Another setting on the API role/],
  ['a trigger on auth.users was added', (p) => { p.authUsersTriggers.push({ name: 'welcome', fn: 'public.welcome' }); }, /triggers on auth\.users/],
  ['a trigger on auth.users was removed', (p) => { p.authUsersTriggers = []; }, /triggers on auth\.users/],
  ['another schema appeared', (p) => { p.schemas.push('sneaky'); }, /not this app's: sneaky/],
  ['a schema disappeared', (p) => { p.schemas = p.schemas.filter((s) => s !== 'storage'); }, /disappeared: storage/],
  ['a public policy changed', (p) => { p.publicPolicies.hash = 'y'; }, /policies\) in the public schema changed/],
  ['a public policy was added', (p) => { p.publicPolicies.count += 1; }, /policies\) in the public schema changed \(1 before, 2 after\)/],
  ['a public table permission changed', (p) => { p.publicGrants.hash = 'z'; }, /table permissions in the public schema changed/],
  ['a public function changed', (p) => { p.publicFunctions.hash = 'q'; p.publicFunctions.items[0].def = 'different'; }, /Functions in the public schema changed: public\.handle_new_user\(\)/],
];
for (const [name, mutate, pattern] of unexpectedCases) {
  test(`diff: unexpected - ${name}`, async () => {
    const { pre, post } = await beforeAfter(mutate);
    const d = Snap.diffSnapshots(pre, post, expectAdd);
    assert.equal(d.ok, false, name);
    assert.match(d.unexpected.join('\n'), pattern);
  });
}

const everywhereCases = [
  ['policies', /privacy rules \(policies\) outside the app's own schema changed \(1 before, 2 after\)/],
  ['relations', /tables, views or sequences outside the app's own schema/i],
  ['columnAcls', /column permissions/i],
  ['functions', /functions outside the app's own schema/i],
  ['schemaAcls', /permissions on the schemas/i],
  ['defaultAcls', /default permissions/i],
  ['roleMembers', /role memberships/i],
  ['roles', /database roles themselves/i],
  ['extensions', /installed extensions/i],
  ['publications', /publications/i],
  ['eventTriggers', /event triggers/i],
  ['triggers', /triggers on tables outside/i],
  ['cron', /scheduled jobs/i],
];
for (const [key, pattern] of everywhereCases) {
  test(`diff: unexpected - ${key} outside the app's own schema changed (count or fingerprint)`, async () => {
    const { pre, post } = await beforeAfter();
    assert.ok(pre.everywhere[key], `${key} is recorded`);
    post.everywhere[key] = { count: pre.everywhere[key].count + 1, hash: 'different' };
    assert.match(Snap.diffSnapshots(pre, post, expectAdd).unexpected.join('\n'), pattern);
    // The same count with another fingerprint is caught too (a row changed, none added).
    const { pre: pre2, post: post2 } = await beforeAfter();
    post2.everywhere[key] = { count: pre2.everywhere[key].count, hash: 'other' };
    assert.equal(Snap.diffSnapshots(pre2, post2, expectAdd).ok, false);
  });
}

test('diff: another sign-in setting (not the address list) changing is caught', async () => {
  const { pre, post } = await beforeAfter((p) => { p.auth.otherSettingsHash = 'x'.repeat(64); });
  assert.match(Snap.diffSnapshots(pre, post, expectAdd).unexpected.join('\n'), /Another sign-in setting changed/);
});

test('snapshot: the sign-in fingerprint ignores the address list, which may grow, and reacts to anything else', async () => {
  const a = makeSharedProject();
  const b = makeSharedProject({ authConfig: { uri_allow_list: 'https://first-app.example.com/**,http://localhost:3000/**,https://new.example/**' } });
  const c = makeSharedProject({ authConfig: { mailer_autoconfirm: true } });
  const d = makeSharedProject({ authConfig: { external_google_enabled: false } });
  const [sa, sb, sc, sd] = await Promise.all([snapOf(a), snapOf(b), snapOf(c), snapOf(d)]);
  assert.equal(sa.auth.otherSettingsHash, sb.auth.otherSettingsHash);
  assert.notEqual(sa.auth.otherSettingsHash, sc.auth.otherSettingsHash);
  assert.notEqual(sa.auth.otherSettingsHash, sd.auth.otherSettingsHash);
  assert.ok(!JSON.stringify(sa).includes('smtp-secret-value-123'));
});

test('snapshot: the fingerprint questions are read-only, leave the app\'s schema out, hash inside the database, and validate the name', async () => {
  const qs = Snap.fingerprintQueries('app_x');
  assert.deepEqual(qs.map((q) => q.key), ['policies', 'relations', 'columnAcls', 'functions', 'schemaAcls', 'defaultAcls', 'roleMembers', 'roles', 'extensions', 'publications', 'eventTriggers', 'triggers']);
  for (const q of qs) {
    assert.match(q.sql, /^select count\(\*\)::int as n, md5\(coalesce\(string_agg\(x\.r, E'\\n' order by x\.r\), ''\)\) as h from \(select /);
    assert.ok(!/\b(insert|update|delete|alter|drop|create|grant|revoke|truncate)\b/i.test(q.sql.replace(/ttl/g, '')), q.key);
    assert.match(q.sql, new RegExp(`-- shipyard:snapshot:${q.key}$`));
  }
  const by = Object.fromEntries(qs.map((q) => [q.key, q.sql]));
  assert.match(by.policies, /pg_policies where schemaname <> 'app_x'/);
  assert.match(by.relations, /c\.relfilenode/);
  assert.match(by.relations, /c\.relrowsecurity/);
  assert.match(by.relations, /c\.relacl/);
  assert.match(by.relations, /n\.nspname <> 'app_x'/);
  assert.match(by.functions, /pg_get_functiondef/);
  assert.match(by.functions, /p\.proacl/);
  assert.match(by.schemaAcls, /nspacl/);
  assert.match(by.defaultAcls, /pg_default_acl/);
  assert.match(by.roleMembers, /pg_auth_members/);
  assert.match(by.extensions, /pg_extension/);
  assert.match(by.publications, /pg_publication_tables/);
  assert.match(by.eventTriggers, /pg_event_trigger/);
  assert.match(by.triggers, /not t\.tgisinternal/);
  for (const bad of ['public', "x'; drop table y; --", 'a"b']) assert.throws(() => Snap.fingerprintQueries(bad), { name: 'ProvisionError' });
});

test('snapshot: the Cron list is only asked about when Cron is on', async () => {
  const off = makeSharedProject();
  const on = makeSharedProject();
  on.state.cronExists = true;
  on.state.cron = { n: 3, h: 'jobs' };
  const a = await snapOf(off);
  const b = await snapOf(on);
  assert.deepEqual(a.everywhere.cron, { count: 0, hash: 'no-cron' });
  assert.deepEqual(b.everywhere.cron, { count: 3, hash: 'jobs' });
  assert.ok(!off.state.reads.some((q) => /snapshot:cron\b/.test(q)));
});

test('diff: snapshots from an older version without the wider fingerprints still compare', async () => {
  const { pre, post } = await beforeAfter();
  delete pre.everywhere;
  delete post.everywhere;
  delete pre.auth.otherSettingsHash;
  delete post.auth.otherSettingsHash;
  assert.equal(Snap.diffSnapshots(pre, post, expectAdd).ok, true);
});

test('diff: an existing app\'s own schema does not need to be created again', async () => {
  const { pre } = await beforeAfter();
  const withSchema = clone(pre);
  withSchema.schemas.push('app_x');
  const post = clone(withSchema);
  const d = Snap.diffSnapshots(withSchema, post, { schema: 'app_x', dbSchemasAfter: ['public', 'storage', 'graphql_public'], allowListAdds: [] });
  assert.equal(d.ok, true);
});

test('diff: when the project said nothing before, the exposed list may become the inferred one plus ours', async () => {
  const fake = makeSharedProject({ rolconfig: ['statement_timeout=8s'] });
  const pre = await snapOf(fake);
  const post = clone(pre);
  post.apiRole.dbSchemas = { present: true, raw: 'public, graphql_public, app_x' };
  post.schemas.push('app_x');
  assert.equal(Snap.diffSnapshots(pre, post, { schema: 'app_x', dbSchemasAfter: ['public', 'graphql_public', 'app_x'], allowListAdds: [] }).ok, true);
  post.apiRole.dbSchemas.raw = 'app_x';
  assert.equal(Snap.diffSnapshots(pre, post, { schema: 'app_x', dbSchemasAfter: ['public', 'graphql_public', 'app_x'], allowListAdds: [] }).ok, false);
});

// ---------- probes ----------

const answers = (map) => async (url, init) => {
  const key = `${init.method} ${new URL(url).pathname} ${init.headers['Accept-Profile']}`;
  const status = typeof map === 'function' ? map(key, init) : map[key];
  if (status === 'throw') throw new Error('network down');
  return new Response(null, { status: status ?? 404 });
};

test('probe: HEAD with Accept-Profile and the public key; 2xx is ok, 406 is not exposed', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return new Response(null, { status: new URL(url).pathname === '/rest/v1/' ? (init.headers['Accept-Profile'] === 'hidden' ? 406 : 200) : 404 }); };
  const base = { fetch, url: `https://${REF}.supabase.co`, anonKey: PUBLIC_KEY };
  assert.equal(await Snap.probeSchema({ ...base, schema: 'public' }), 'ok');
  assert.equal(await Snap.probeSchema({ ...base, schema: 'hidden' }), 'not-exposed');
  assert.equal(seen[0].init.method, 'HEAD');
  assert.equal(seen[0].url, `https://${REF}.supabase.co/rest/v1/`);
  assert.equal(seen[0].init.headers.apikey, PUBLIC_KEY);
  assert.equal(seen[0].init.headers.authorization, undefined, 'new-style keys go in apikey only');
  const jwt = 'eyJhbGciOi.eyJyb2xlIjoiYW5vbiJ9.sig';
  await Snap.probeSchema({ ...base, anonKey: jwt, schema: 'public' });
  assert.equal(seen.at(-1).init.headers.authorization, `Bearer ${jwt}`);
});

test('probe: falls back to a made-up table when the API root is closed, and says unknown when it cannot tell', async () => {
  const base = { url: `https://${REF}.supabase.co`, anonKey: PUBLIC_KEY };
  const closed = (schema406) => answers((key) => {
    if (key.includes('/rest/v1/ ')) return 401;
    return key.endsWith(schema406) ? 406 : 404;
  });
  assert.equal(await Snap.probeSchema({ ...base, fetch: closed('hidden'), schema: 'public' }), 'ok');
  assert.equal(await Snap.probeSchema({ ...base, fetch: closed('hidden'), schema: 'hidden' }), 'not-exposed');
  assert.equal(await Snap.probeSchema({ ...base, fetch: answers(() => 401), schema: 'public' }), 'unknown');
  assert.equal(await Snap.probeSchema({ ...base, fetch: answers(() => 'throw'), schema: 'public' }), 'unknown');
  assert.equal(await Snap.probeSchema({ ...base, fetch: answers(() => 500), schema: 'public' }), 'unknown');
});

test('probeSchemas: one answer per schema, and a brand-new schema is retried a few times', async () => {
  let hits = 0;
  const fetch = async (url, init) => {
    if (init.headers['Accept-Profile'] === 'fresh') { hits++; return new Response(null, { status: hits > 2 ? 200 : 406 }); }
    return new Response(null, { status: 200 });
  };
  const waits = [];
  const result = await Snap.probeSchemas({ fetch, url: 'https://x.supabase.co', anonKey: PUBLIC_KEY, schemas: ['public', 'fresh'], settle: 4, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(result, { public: 'ok', fresh: 'ok' });
  assert.equal(waits.length, 2);
  const never = await Snap.probeSchemas({ fetch: async () => new Response(null, { status: 406 }), url: 'https://x.supabase.co', anonKey: PUBLIC_KEY, schemas: ['gone'], settle: 2, sleep: async () => {} });
  assert.deepEqual(never, { gone: 'not-exposed' });
});

// ---------- restore text ----------

test('restore commands: the old schema list (quoted), the old redirect list and the old main address, verbatim', async () => {
  const fake = makeSharedProject({ rolconfig: ["pgrst.db_schemas=public, storage"], authConfig: { site_url: 'https://first-app.example.com', uri_allow_list: 'https://a.example/**,https://b.example/**' } });
  const pre = await snapOf(fake);
  const text = Snap.restoreCommands({ pre, schema: 'app_x', schemaCreated: true }).join('\n');
  assert.match(text, /ALTER ROLE authenticator SET pgrst\.db_schemas = 'public, storage';/);
  assert.match(text, /NOTIFY pgrst, 'reload config';/);
  assert.match(text, /Site URL: https:\/\/first-app\.example\.com/);
  assert.match(text, /^\s+https:\/\/a\.example\/\*\*$/m);
  assert.match(text, /^\s+https:\/\/b\.example\/\*\*$/m);
  assert.match(text, /DELETES everything in it/);
  assert.match(text, /DROP SCHEMA "app_x" CASCADE;/);
  const noDrop = Snap.restoreCommands({ pre, schema: 'app_x', schemaCreated: false }).join('\n');
  assert.ok(!/DROP SCHEMA/.test(noDrop), 'a schema that existed before is never offered for deletion');
  const absent = Snap.restoreCommands({ pre: clone({ ...pre, apiRole: { ...pre.apiRole, dbSchemas: { present: false, raw: null } } }), schema: 'app_x', schemaCreated: false }).join('\n');
  assert.match(absent, /RESET pgrst\.db_schemas;/);
});

// ---------- the redirect-address list ----------

test('redirect addresses: the new ones are added, none is removed, no duplicate, and the main address is left alone', async () => {
  const fake = makeSharedProject({ authConfig: { site_url: 'https://first-app.example.com', uri_allow_list: 'https://a.example/**,https://first-app.example.com/**' } });
  const r = await P.updateAuthUrls(auth(fake), REF, { appUrl: 'https://mine.example.com', leaveSiteUrl: true });
  assert.equal(r.siteUrl, 'https://first-app.example.com');
  assert.deepEqual(r.added, ['http://localhost:3000/**', 'https://mine.example.com/**']);
  assert.equal(fake.state.authConfig.uri_allow_list, 'https://a.example/**,https://first-app.example.com/**,http://localhost:3000/**,https://mine.example.com/**');
  assert.deepEqual(Object.keys(fake.state.patches[0]), ['uri_allow_list']);
  // Again: nothing to do, nothing patched.
  fake.state.patches.length = 0;
  const again = await P.updateAuthUrls(auth(fake), REF, { appUrl: 'https://mine.example.com', leaveSiteUrl: true });
  assert.equal(again.changed, false);
  assert.deepEqual(fake.state.patches, []);
  // Empty main address and no web address yet: still not touched in shared mode.
  const empty = makeSharedProject({ authConfig: { site_url: '', uri_allow_list: '' } });
  await P.updateAuthUrls(auth(empty), REF, { appUrl: '', leaveSiteUrl: true });
  assert.equal(empty.state.authConfig.site_url, '');
  assert.equal(empty.state.authConfig.uri_allow_list, 'http://localhost:3000/**');
});
