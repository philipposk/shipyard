// A pretend shared Supabase project for the shared-mode tests: the Management API (project, keys, sign-in
// settings, SQL) and the project's own API (the HEAD probes), all in memory. It understands just the SQL Shipyard
// sends. Every statement that is not a plain read is recorded in `state.writes`. No network, no real keys.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TOKEN = `sbp_${'a1b2c3d4'.repeat(5)}`;
export const PUBLIC_KEY = `sb_publishable_${'P'.repeat(30)}`;
export const SERVER_KEY = `sb_secret_${'S'.repeat(30)}`;
export const REF = 'sharedproject0123456';
export const getSecret = async () => TOKEN;
export const sleep = async () => {};
export const tempDir = (prefix = 'shipyard-shared-') => mkdtemp(path.join(os.tmpdir(), prefix));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unquote = (s) => s.replace(/^"|"$/g, '');

/**
 * opts:
 *   rolconfig        array of "name=value" (default: statement_timeout + a db_schemas list), or null for "not set"
 *   schemas          extra schemas that exist
 *   owners           { schema: [slugs] } schemas that already hold a Shipyard app
 *   noMarker         [schemas] that exist without the _shipyard_app table
 *   authConfig       sign-in settings
 *   projectStatus    default ACTIVE_HEALTHY
 *   rootStatus       what HEAD /rest/v1/ answers for an exposed schema (default 200; 401 = newer projects)
 *   exposeDelay      number of probes of a schema the API was just told about that still answer 406
 *   onWrite          (sql, state) => void | Response : change the pretend project (to simulate harm) or fail
 *   dropFromList     entry the "API" silently loses when db_schemas is set (to simulate harm)
 *   patchStatus      HTTP status the sign-in settings PATCH answers (to simulate a failure after the schema list was written)
 *   platformDbSchema what the platform's own PostgREST setting says (default 'public,graphql_public'); '' = empty; null = the call fails
 *
 * state.snap[tag] = { n, h } is the answer to a fingerprint question (change it to simulate harm outside public);
 * state.cronExists / state.cron say whether Cron is on.
 */
export function makeSharedProject(opts = {}) {
  const state = {
    project: { id: REF, ref: REF, name: 'big-shared', organization_slug: 'someone', status: opts.projectStatus ?? 'ACTIVE_HEALTHY' },
    authConfig: {
      site_url: 'https://first-app.example.com',
      uri_allow_list: 'https://first-app.example.com/**,http://localhost:3000/**',
      smtp_host: 'smtp.example.com',
      smtp_pass: 'smtp-secret-value-123',
      external_google_enabled: true,
      ...(opts.authConfig ?? {}),
    },
    rolconfig: opts.rolconfig === undefined
      ? ['statement_timeout=8s', 'pgrst.db_schemas=public, storage, graphql_public']
      : opts.rolconfig,
    schemas: new Set(['public', 'auth', 'storage', 'graphql_public', 'extensions', 'pg_catalog', 'information_schema', ...(opts.schemas ?? [])]),
    apps: new Map(Object.entries(opts.owners ?? {}).map(([s, slugs]) => [s, { slugs: new Set(slugs), applied: new Set() }])),
    authTriggers: [{ tgname: 'on_auth_user_created', fn: 'public.handle_new_user' }],
    policies: [{ schemaname: 'public', tablename: 'profiles', policyname: 'other app policy', cmd: 'SELECT', qual: '(auth.uid() = id)' }],
    grants: [{ grantee: 'authenticated', table_name: 'profiles', privilege_type: 'SELECT', is_grantable: 'NO' }],
    functions: [{ name: 'public.handle_new_user()', def: 'abc123' }],
    writes: [],
    reads: [],
    patches: [],
    calls: [],
    probes: [],
    exposedNow: new Set(),
    pendingExposure: new Map(),
    platformDbSchema: opts.platformDbSchema === undefined ? 'public,graphql_public' : opts.platformDbSchema,
    snap: {},
    cronExists: false,
    cron: { n: 1, h: 'cron-hash' },
  };
  for (const s of opts.schemas ?? []) state.schemas.add(s);
  for (const s of state.apps.keys()) state.schemas.add(s);
  for (const s of opts.noMarker ?? []) state.schemas.add(s);

  const listFromRol = () => {
    const e = (state.rolconfig ?? []).find((x) => x.startsWith('pgrst.db_schemas='));
    return e ? e.slice('pgrst.db_schemas='.length).split(',').map((x) => x.trim()).filter(Boolean) : null;
  };
  const exposed = () => new Set(listFromRol() ?? String(state.platformDbSchema ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  state.exposed = exposed;

  const readQuery = (q) => {
    if (/^\s*do \$/i.test(q) || /alter role/i.test(q)) return null; // writes, even though they look things up
    const tag = /-- shipyard:snapshot:(\w+)/.exec(q)?.[1];
    if (tag === 'cronExists') return [{ found: state.cronExists }];
    if (tag === 'cron') return [state.cron];
    if (tag) return [state.snap[tag] ?? { n: 1, h: `hash-of-${tag}` }];
    if (q.includes("rolname = 'authenticator'")) return [{ rolconfig: state.rolconfig }];
    if (q.includes('from pg_trigger')) return state.authTriggers;
    if (q.includes('from pg_namespace where nspname !~')) return [...state.schemas].sort().map((schema_name) => ({ schema_name }));
    if (q.includes('from pg_policies')) return state.policies;
    if (q.includes('role_table_grants')) return state.grants;
    if (q.includes('pg_get_functiondef')) return state.functions;
    let m = /from pg_namespace where nspname = '([^']+)'/.exec(q);
    if (m) return state.schemas.has(m[1]) ? [{ found: 1 }] : [];
    m = /to_regclass\('"([^"]+)"\._shipyard_app'\)/.exec(q);
    if (m) return [{ found: state.apps.has(m[1]) }];
    m = /select slug from "([^"]+)"\._shipyard_app/.exec(q);
    if (m) return [...(state.apps.get(m[1])?.slugs ?? [])].map((slug) => ({ slug }));
    m = /to_regclass\('"([^"]+)"\._shipyard_migrations'\)/.exec(q);
    if (m) return [{ found: state.apps.has(m[1]) }];
    m = /select name from "([^"]+)"\._shipyard_migrations/.exec(q);
    if (m) return [...(state.apps.get(m[1])?.applied ?? [])].map((name) => ({ name }));
    return null;
  };

  const applyWrite = (q) => {
    let m = /create schema if not exists "([^"]+)"/.exec(q);
    if (m) {
      state.schemas.add(m[1]);
      if (!state.apps.has(m[1])) state.apps.set(m[1], { slugs: new Set(), applied: new Set() });
    }
    m = /insert into "([^"]+)"\._shipyard_app \(slug\) values \('([^']+)'\)/.exec(q);
    if (m) state.apps.get(m[1]).slugs.add(m[2]);
    m = /insert into "([^"]+)"\._shipyard_migrations \(name\) values \('((?:[^']|'')*)'\)/.exec(q);
    if (m) state.apps.get(m[1]).applied.add(m[2].replace(/''/g, "'"));
    m = /alter role authenticator set pgrst\.db_schemas = '((?:[^']|'')*)'/i.exec(q);
    if (m) {
      let value = m[1].replace(/''/g, "'");
      if (opts.dropFromList) value = value.split(',').map((x) => x.trim()).filter((x) => x !== opts.dropFromList).join(', ');
      state.rolconfig = [...(state.rolconfig ?? []).filter((x) => !x.startsWith('pgrst.db_schemas=')), `pgrst.db_schemas=${value}`];
      for (const s of value.split(',').map((x) => x.trim())) {
        if (!state.exposedNow.has(s) && opts.exposeDelay) state.pendingExposure.set(s, opts.exposeDelay);
        state.exposedNow.add(s);
      }
    }
  };

  const fetch = async (input, init = {}) => {
    const u = new URL(input);
    const method = init.method ?? 'GET';
    // ----- the project's own API (probes) -----
    if (u.hostname === `${REF}.supabase.co`) {
      const schema = init.headers?.['Accept-Profile'] ?? null;
      state.probes.push({ method, path: u.pathname, schema, hasApikey: Boolean(init.headers?.apikey), bearer: init.headers?.authorization ?? null });
      if (schema && !exposed().has(schema)) return new Response(null, { status: 406 });
      if (schema && state.pendingExposure.get(schema) > 0) {
        state.pendingExposure.set(schema, state.pendingExposure.get(schema) - 1);
        return new Response(null, { status: 406 });
      }
      if (u.pathname === '/rest/v1/') return new Response(null, { status: opts.rootStatus ?? 200 });
      return new Response(null, { status: 404 });
    }
    // ----- the Management API -----
    const route = `${method} ${u.pathname.replace(/^\/v1/, '')}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ route, auth: init.headers?.Authorization, body, query: u.search });
    let m = /^GET \/projects\/([^/]+)$/.exec(route);
    if (m) return m[1] === REF ? json(state.project) : json({ message: 'not found' }, 404);
    if (/^GET \/projects\/[^/]+\/api-keys$/.test(route)) {
      // Like the real API: the secret key is only sent in full when asked for with reveal=true.
      const reveal = u.searchParams.get('reveal') === 'true';
      return json([{ type: 'publishable', name: 'default', api_key: PUBLIC_KEY }, { type: 'secret', name: 'default', api_key: reveal ? SERVER_KEY : 'sb_secret_****' }]);
    }
    if (/^GET \/projects\/[^/]+\/postgrest$/.test(route)) {
      if (state.platformDbSchema === null) return json({ message: 'boom' }, 500);
      return json({ db_schema: state.platformDbSchema, db_extra_search_path: 'public', max_rows: 1000, jwt_secret: 'jwt-secret-value-never-print' });
    }
    if (/^GET \/projects\/[^/]+\/config\/auth$/.test(route)) return json(state.authConfig);
    if (/^PATCH \/projects\/[^/]+\/config\/auth$/.test(route)) {
      state.patches.push(body);
      if (opts.patchStatus) return json({ message: 'refused' }, opts.patchStatus);
      Object.assign(state.authConfig, body);
      return json(state.authConfig);
    }
    if (/^POST \/projects\/[^/]+\/database\/query$/.test(route)) {
      const q = body.query;
      const rows = readQuery(q);
      if (rows !== null) {
        state.reads.push(q);
        return json(rows);
      }
      state.writes.push(q);
      const hook = opts.onWrite?.(q, state);
      if (hook instanceof Response) return hook;
      // The compare-and-set in the statement that saves the schema list: it fails if the list is not what was read.
      const cas = /cur is distinct from (null|'((?:[^']|'')*)')/.exec(q);
      if (cas && q.includes('changed meanwhile')) {
        const expected = cas[1] === 'null' ? null : cas[2].replace(/''/g, "'");
        const entry = (state.rolconfig ?? []).find((x) => x.startsWith('pgrst.db_schemas='));
        const current = entry ? entry.slice('pgrst.db_schemas='.length) : null;
        if (current !== expected) return json({ message: 'shipyard: the exposed schema list changed meanwhile, nothing written' }, 400);
      }
      applyWrite(q);
      return json([]);
    }
    return json({ message: `no route ${route}` }, 404);
  };
  return { fetch, state };
}

export const noApiCalls = (fake) => fake.state.calls.length === 0 && fake.state.probes.length === 0;
