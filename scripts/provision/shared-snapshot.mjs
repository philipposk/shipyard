// Shared-project mode, part 2: look before, look after, compare.
//
// A shared project is used by other apps (maybe live ones). Before Shipyard changes anything it writes down how
// the project looks (read-only questions only). After the change it looks again, and the two must differ in exactly
// the ways shared mode is allowed to change things. Anything else is reported with commands to put it back.
// Shipyard never puts things back by itself.
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './common.mjs';
import { readDbSchemasSetting, rolconfigList, splitSchemaList, restoreDbSchemasSql, dropSchemaSql, sqlLiteral, assertSchemaName } from './shared-sql.mjs';

export const SNAPSHOT_DIR = '.shipyard';

// Read-only questions. None of them contains a name from outside this file.
const Q_ROLCONFIG = "select rolconfig from pg_roles where rolname = 'authenticator';";
export const Q_AUTH_TRIGGERS = "select tgname, tgfoid::regproc::text as fn from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal order by tgname;";
const Q_SCHEMAS = "select nspname as schema_name from pg_namespace where nspname !~ '^pg_(toast|temp)' order by nspname;";
const Q_POLICIES = "select schemaname, tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname;";
const Q_GRANTS = "select grantee, table_name, privilege_type, is_grantable from information_schema.role_table_grants where table_schema = 'public' order by grantee, table_name, privilege_type;";
const Q_FUNCTIONS = "select p.oid::regprocedure::text as name, md5(pg_get_functiondef(p.oid)) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1;";

// Everything outside the app's own schema, reduced to "how many rows" and "a fingerprint of them". The rows
// themselves are hashed inside the database, so nothing but two small values comes back and nothing is stored.
// The comment on the last line names the question (the tests use it to tell the questions apart).
const NOT_SYSTEM = (col) => `${col} !~ '^pg_(toast|temp)' and ${col} not in ('pg_catalog', 'information_schema')`;
const hashed = (tag, rows) => `select count(*)::int as n, md5(coalesce(string_agg(x.r, E'\\n' order by x.r), '')) as h from (${rows}) x(r);\n-- shipyard:snapshot:${tag}`;

/** The read-only fingerprint questions, for every schema except the app's own one. [{ key, sql }] */
export function fingerprintQueries(schema) {
  const s = sqlLiteral(assertSchemaName(schema));
  return [
    { key: 'policies', sql: hashed('policies', `select concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check) from pg_policies where schemaname <> ${s}`) },
    // relfilenode changes when a table is emptied by TRUNCATE or rewritten by VACUUM FULL / CLUSTER (not for materialized views: they are refreshed on purpose).
    { key: 'relations', sql: hashed('relations', `select concat_ws('|', n.nspname, c.relname, c.relkind::text, case when c.relkind = 'm' then '' else c.relfilenode::text end, c.relrowsecurity::text, c.relforcerowsecurity::text, coalesce(c.relacl::text, ''), pg_get_userbyid(c.relowner)) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname <> ${s} and ${NOT_SYSTEM('n.nspname')} and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and not c.relispartition`) },
    { key: 'columnAcls', sql: hashed('columnAcls', `select concat_ws('|', n.nspname, c.relname, a.attname, a.attacl::text) from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where a.attacl is not null and n.nspname <> ${s} and ${NOT_SYSTEM('n.nspname')}`) },
    { key: 'functions', sql: hashed('functions', `select concat_ws('|', n.nspname, p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), coalesce(p.proacl::text, ''), pg_get_userbyid(p.proowner), p.prosecdef::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname <> ${s} and ${NOT_SYSTEM('n.nspname')} and p.prokind in ('f', 'p') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`) },
    { key: 'schemaAcls', sql: hashed('schemaAcls', `select concat_ws('|', nspname, coalesce(nspacl::text, ''), pg_get_userbyid(nspowner)) from pg_namespace where nspname <> ${s} and nspname !~ '^pg_(toast|temp)'`) },
    { key: 'defaultAcls', sql: hashed('defaultAcls', `select concat_ws('|', pg_get_userbyid(d.defaclrole), coalesce(n.nspname, ''), d.defaclobjtype::text, d.defaclacl::text) from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace where coalesce(n.nspname, '') <> ${s}`) },
    { key: 'roleMembers', sql: hashed('roleMembers', `select concat_ws('|', r.rolname, m.rolname, am.admin_option::text) from pg_auth_members am join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member`) },
    { key: 'roles', sql: hashed('roles', `select concat_ws('|', rolname, rolsuper::text, rolinherit::text, rolcreaterole::text, rolcreatedb::text, rolcanlogin::text, rolreplication::text, rolbypassrls::text, rolconnlimit::text) from pg_roles where rolname !~ '^pg_'`) },
    { key: 'extensions', sql: hashed('extensions', "select concat_ws('|', extname, extversion, extnamespace::regnamespace::text) from pg_extension") },
    { key: 'publications', sql: hashed('publications', "select concat_ws('|', 'table', pubname, schemaname, tablename) from pg_publication_tables union all select concat_ws('|', 'publication', pubname, puballtables::text, pubinsert::text, pubupdate::text, pubdelete::text, pubtruncate::text) from pg_publication") },
    { key: 'eventTriggers', sql: hashed('eventTriggers', "select concat_ws('|', evtname, evtevent, evtfoid::regproc::text, evtenabled::text) from pg_event_trigger") },
    { key: 'triggers', sql: hashed('triggers', `select concat_ws('|', n.nspname, c.relname, t.tgname, t.tgfoid::regproc::text, t.tgenabled::text) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname <> ${s} and ${NOT_SYSTEM('n.nspname')}`) },
  ];
}

const Q_CRON_EXISTS = "select to_regclass('cron.job') is not null as found;\n-- shipyard:snapshot:cronExists";
const Q_CRON = hashed('cron', "select concat_ws('|', jobname, schedule, md5(command), active::text, username) from cron.job");

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowsOf = (result) => (Array.isArray(result) ? result : []);
const isTrue = (v) => v === true || v === 't' || v === 'true' || v === 1;
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '' && v !== false;

/** Short, stable UTC stamp for file names: 20261018T101530Z */
export const utcStamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * How the project looks right now. Only reads. Secrets never go in: the sign-in settings are reduced to the two
 * address settings and "is it set" flags for the email server fields, and the API role's other settings are only
 * kept as a name plus a fingerprint.
 */
export async function takeSnapshot({ auth, ref, exec, api, now = () => new Date(), schema }) {
  const config = (await api.getAuthConfig(auth, ref)) ?? {};
  const smtp = {};
  for (const key of Object.keys(config).filter((k) => k.startsWith('smtp_')).sort()) smtp[key] = hasValue(config[key]);

  const rolconfig = rowsOf(await exec(Q_ROLCONFIG))[0]?.rolconfig ?? null;
  const dbSchemas = readDbSchemasSetting(rolconfig);
  const others = rolconfigList(rolconfig)
    .filter((e) => !e.startsWith('pgrst.db_schemas='))
    .map((e) => {
      const i = e.indexOf('=');
      return { name: i === -1 ? e : e.slice(0, i), hash: sha(e) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const triggers = rowsOf(await exec(Q_AUTH_TRIGGERS)).map((r) => ({ name: String(r.tgname), fn: String(r.fn) }));
  const schemas = rowsOf(await exec(Q_SCHEMAS)).map((r) => String(r.schema_name));
  const policies = rowsOf(await exec(Q_POLICIES));
  const grants = rowsOf(await exec(Q_GRANTS));
  const functions = rowsOf(await exec(Q_FUNCTIONS)).map((r) => ({ name: String(r.name), def: String(r.def) }));

  // Everything outside the app's own schema: count + fingerprint only. Needs the schema's name to leave it out.
  const everywhere = {};
  if (schema !== undefined) {
    for (const q of fingerprintQueries(schema)) {
      const row = rowsOf(await exec(q.sql))[0] ?? {};
      everywhere[q.key] = { count: Number(row.n ?? 0), hash: String(row.h ?? '') };
    }
    // The Cron list exists only when the Cron extension is on.
    if (isTrue(rowsOf(await exec(Q_CRON_EXISTS))[0]?.found)) {
      const row = rowsOf(await exec(Q_CRON))[0] ?? {};
      everywhere.cron = { count: Number(row.n ?? 0), hash: String(row.h ?? '') };
    } else {
      everywhere.cron = { count: 0, hash: 'no-cron' };
    }
  }
  // All sign-in settings except the address list (the one thing that may grow), as one fingerprint. Values never stored.
  const authRest = Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'uri_allow_list').sort(([a], [b]) => a.localeCompare(b)));

  return {
    takenAt: now().toISOString(),
    auth: {
      siteUrl: String(config.site_url ?? ''),
      uriAllowList: String(config.uri_allow_list ?? ''),
      smtpFieldsSet: smtp,
      otherSettingsHash: sha(authRest),
    },
    apiRole: { dbSchemas, otherSettings: others },
    authUsersTriggers: triggers,
    schemas,
    publicPolicies: { count: policies.length, hash: sha(policies) },
    publicGrants: { count: grants.length, hash: sha(grants) },
    publicFunctions: { count: functions.length, hash: sha(functions), items: functions },
    everywhere,
  };
}

const EVERYWHERE_LABELS = {
  policies: 'The privacy rules (policies) outside the app\'s own schema',
  relations: 'The tables, views or sequences outside the app\'s own schema (one was added, removed, emptied or rewritten, row-level security was switched on or off, or its permissions changed)',
  columnAcls: 'The column permissions outside the app\'s own schema',
  functions: 'The functions outside the app\'s own schema (or who may run them)',
  schemaAcls: 'The permissions on the schemas themselves',
  defaultAcls: 'The default permissions (for objects created later)',
  roleMembers: 'Which database roles belong to which (role memberships)',
  roles: 'The database roles themselves',
  extensions: 'The installed extensions',
  publications: 'The publications (what is sent to Realtime and replicas)',
  eventTriggers: 'The event triggers (they run on every schema change)',
  triggers: 'The triggers on tables outside the app\'s own schema',
  cron: 'The scheduled jobs (Cron)',
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allowEntries = (raw) => String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Compare two snapshots. `expect`:
 *   schema            the app's schema
 *   dbSchemasAfter    the exact list the API role should now expose
 *   allowListAdds     the addresses this run may have added to the redirect list
 * Returns { ok, unexpected: [plain sentences], allowed: [plain sentences] }.
 */
export function diffSnapshots(pre, post, expect) {
  const unexpected = [];
  const allowed = [];

  // Sign-in settings
  if (pre.auth.siteUrl !== post.auth.siteUrl) unexpected.push(`The sign-in "site URL" changed (was "${pre.auth.siteUrl}", now "${post.auth.siteUrl}").`);
  if (!sameJson(pre.auth.smtpFieldsSet, post.auth.smtpFieldsSet)) unexpected.push('The email (SMTP) settings changed.');
  const preList = allowEntries(pre.auth.uriAllowList);
  const postList = allowEntries(post.auth.uriAllowList);
  const removed = preList.filter((u) => !postList.includes(u));
  if (removed.length > 0) unexpected.push(`These redirect addresses were removed: ${removed.join(', ')}.`);
  const added = postList.filter((u) => !preList.includes(u));
  const surprise = added.filter((u) => !(expect.allowListAdds ?? []).includes(u));
  if (surprise.length > 0) unexpected.push(`These redirect addresses were added but are not this app's: ${surprise.join(', ')}.`);
  if (added.length > 0 && surprise.length === 0) allowed.push(`Redirect addresses added: ${added.join(', ')}.`);

  // The API role: the exposed-schema list may only gain the new schema, everything else on it stays.
  const preSchemas = splitSchemaList(pre.apiRole.dbSchemas.raw);
  const postSchemas = splitSchemaList(post.apiRole.dbSchemas.raw);
  const wanted = expect.dbSchemasAfter ?? [];
  if (!sameJson(postSchemas, wanted)) {
    unexpected.push(`The list of schemas the API exposes is "${postSchemas.join(', ')}", expected "${wanted.join(', ')}".`);
  } else {
    const lost = preSchemas.filter((s) => !postSchemas.includes(s));
    if (lost.length > 0) unexpected.push(`These schemas are no longer exposed by the API: ${lost.join(', ')}.`);
    const gained = postSchemas.filter((s) => !preSchemas.includes(s));
    if (gained.length > 0) allowed.push(`The API now also exposes: ${gained.join(', ')}.`);
  }
  if (!sameJson(pre.apiRole.otherSettings, post.apiRole.otherSettings)) unexpected.push('Another setting on the API role changed.');

  // Sign-up triggers
  if (!sameJson(pre.authUsersTriggers, post.authUsersTriggers)) unexpected.push('The triggers on auth.users (the shared login table) changed.');

  // Schemas in the database
  const schemaGain = post.schemas.filter((s) => !pre.schemas.includes(s));
  const schemaLoss = pre.schemas.filter((s) => !post.schemas.includes(s));
  if (schemaLoss.length > 0) unexpected.push(`These schemas disappeared: ${schemaLoss.join(', ')}.`);
  const unwanted = schemaGain.filter((s) => s !== expect.schema);
  if (unwanted.length > 0) unexpected.push(`These schemas appeared but are not this app's: ${unwanted.join(', ')}.`);
  if (schemaGain.includes(expect.schema)) allowed.push(`The app's own schema "${expect.schema}" was created.`);

  // Everything in public belongs to the other apps and must be exactly as it was.
  if (pre.publicPolicies.count !== post.publicPolicies.count || pre.publicPolicies.hash !== post.publicPolicies.hash) {
    unexpected.push(`The privacy rules (policies) in the public schema changed (${pre.publicPolicies.count} before, ${post.publicPolicies.count} after).`);
  }
  if (pre.publicGrants.count !== post.publicGrants.count || pre.publicGrants.hash !== post.publicGrants.hash) {
    unexpected.push(`The table permissions in the public schema changed (${pre.publicGrants.count} before, ${post.publicGrants.count} after).`);
  }
  if (pre.publicFunctions.count !== post.publicFunctions.count || pre.publicFunctions.hash !== post.publicFunctions.hash) {
    const before = new Map(pre.publicFunctions.items.map((f) => [f.name, f.def]));
    const names = new Set([...before.keys(), ...post.publicFunctions.items.map((f) => f.name)]);
    const changed = [...names].filter((n) => before.get(n) !== post.publicFunctions.items.find((f) => f.name === n)?.def);
    unexpected.push(`Functions in the public schema changed${changed.length ? `: ${changed.slice(0, 8).join(', ')}` : ''}.`);
  }

  // The rest of the project, outside the app's own schema (every other app's folder, auth, storage ...).
  if (pre.auth.otherSettingsHash !== undefined && pre.auth.otherSettingsHash !== post.auth.otherSettingsHash) {
    unexpected.push('Another sign-in setting changed (email confirmation, login providers, hooks or similar).');
  }
  for (const [key, label] of Object.entries(EVERYWHERE_LABELS)) {
    const a = pre.everywhere?.[key];
    const b = post.everywhere?.[key];
    if (!a || !b) continue;
    if (a.count !== b.count || a.hash !== b.hash) unexpected.push(`${label} changed (${a.count} before, ${b.count} after).`);
  }
  return { ok: unexpected.length === 0, unexpected, allowed };
}

/**
 * Ask the project's API about one schema, the way the apps do: a HEAD request with Accept-Profile.
 * A schema the API does not expose is answered with HTTP 406 (PostgREST code PGRST106).
 * Returns 'ok' | 'not-exposed' | 'unknown' (could not tell: no answer, or the key was refused).
 */
export async function probeSchema({ fetch: doFetch = fetch, url, anonKey, schema, timeoutMs = 15_000 }) {
  const headers = { apikey: anonKey, 'Accept-Profile': schema };
  if (/^eyJ/.test(anonKey)) headers.authorization = `Bearer ${anonKey}`;
  const ask = async (pathname) => {
    try {
      const res = await doFetch(`${url}${pathname}`, { method: 'HEAD', headers, signal: AbortSignal.timeout(timeoutMs) });
      return res.status;
    } catch {
      return 0;
    }
  };
  const root = await ask('/rest/v1/');
  if (root >= 200 && root < 300) return 'ok';
  if (root === 406) return 'not-exposed';
  // Newer projects keep the API description for the secret key only. A made-up table name still shows whether
  // the schema is accepted: exposed schema -> "table not found" (404); not exposed -> 406.
  const table = await ask('/rest/v1/_shipyard_probe_no_such_table');
  if (table === 406) return 'not-exposed';
  if (table === 404 || (table >= 200 && table < 300)) return 'ok';
  return 'unknown';
}

/** Probe several schemas. Returns { <schema>: 'ok' | 'not-exposed' | 'unknown' }. A schema just added may need a moment. */
export async function probeSchemas({ fetch: doFetch, url, anonKey, schemas, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settle = 0 }) {
  const result = {};
  for (const schema of schemas) {
    let status = await probeSchema({ fetch: doFetch, url, anonKey, schema });
    for (let attempt = 0; attempt < settle && status !== 'ok'; attempt++) {
      await sleep(1500);
      status = await probeSchema({ fetch: doFetch, url, anonKey, schema });
    }
    result[schema] = status;
  }
  return result;
}

/** Exact commands that put the project's sign-in and API settings back as they were before. */
export function restoreCommands({ pre, schema, schemaCreated }) {
  const lines = [];
  lines.push('Run this in the Supabase dashboard > SQL Editor to put the API schema list back:');
  lines.push(...restoreDbSchemasSql(pre.apiRole.dbSchemas.raw).split('\n').map((l) => `  ${l}`));
  lines.push('In Supabase dashboard > Authentication > URL Configuration, set:');
  lines.push(`  Site URL: ${pre.auth.siteUrl || '(empty)'}`);
  const before = allowEntries(pre.auth.uriAllowList);
  lines.push(`  Redirect URLs (exactly these, one per line)${before.length === 0 ? ': none' : ':'}`);
  for (const u of before) lines.push(`    ${u}`);
  if (schemaCreated) {
    lines.push('Only if you also want the app\'s own space gone (this DELETES everything in it):');
    lines.push(`  ${dropSchemaSql(schema)}`);
  }
  return lines;
}

/** Write the snapshot file (inside the app's gitignored .shipyard folder). Holds no secrets. */
export async function saveSnapshotFile(appDir, name, data) {
  const dir = path.join(appDir, SNAPSHOT_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}
