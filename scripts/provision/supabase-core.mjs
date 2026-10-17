// Create (or reuse) the app's Supabase project, build its database, set the sign-in
// addresses and write the keys into .env.local. Safe to run again at any time.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as api from '../lib/supabase-api.mjs';
import { getSecret as realGetSecret } from '../lib/secrets.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import {
  APP_CONFIG_FILE, ProvisionError, readAppConfig, updateAppConfig, originOf, isLocalOrigin,
} from './common.mjs';
import { updateEnvFile, readEnvText } from './envfile.mjs';

export const DEFAULT_REGION = 'eu-central-1';
const REF_RE = /^[a-z0-9]{20}$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const FREE_PLAN_ACTIVE_LIMIT = 2;
const LOCAL_SITE = 'http://localhost:3000';
// A project in one of these states does not use one of the free "active" slots.
const NOT_ACTIVE = new Set(['INACTIVE', 'REMOVED', 'INIT_FAILED', 'GOING_DOWN']);

const TRACKING_SQL = `
create table if not exists public._shipyard_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
alter table public._shipyard_migrations enable row level security;
revoke all on public._shipyard_migrations from anon, authenticated;
`;

export const refOf = (project) => project?.ref ?? project?.id ?? '';
export const orgOf = (project) => project?.organization_slug ?? project?.organization_id ?? '';
export const countsAsActive = (project) => !NOT_ACTIVE.has(project?.status);
export const projectUrl = (ref) => `https://${ref}.supabase.co`;

/**
 * Redirect addresses the app needs Supabase to accept after sign-in or email links:
 * the local address and the app's exact web address, nothing else.
 *
 * No wildcard for Vercel preview addresses on purpose. In these patterns `*` matches any host word, and
 * anyone with a Vercel account can create a project called `<slug>-anything` and so own an address that
 * matches. Supabase would then send sign-in tokens to it. (Preview builds also have no Supabase settings,
 * so sign-in cannot work there anyway.) If previews are wanted later, add only the account-owned form
 * `https://*-<scope>.vercel.app/**`, only when the scope is known and only together with preview env vars.
 */
export function buildAllowList({ appUrl }) {
  const list = [`${LOCAL_SITE}/**`];
  if (appUrl) list.push(`${appUrl.replace(/\/$/, '')}/**`);
  return list;
}

/** Migration files in the app, in filename order: [{ file, sql }] */
export async function readMigrations(appDir) {
  const dir = path.join(appDir, 'supabase', 'migrations');
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.sql')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const file of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file)) {
      throw new ProvisionError(`The migration file name "${file}" has unusual characters. Rename it to use only letters, numbers, dashes and underscores.`);
    }
    out.push({ file, sql: await readFile(path.join(dir, file), 'utf8') });
  }
  return out;
}

/** Name stored in _shipyard_migrations. Includes the app, so two apps sharing one project don't skip each other's files. */
export const migrationKey = (slug, file) => `${slug}/${file}`;

/** Run `fn`; if Supabase's database is not ready yet (no answer or a 5xx), wait and try again. */
export async function withRetry(fn, { tries = 6, delayMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = err?.name === 'ApiError' && (err.status === 0 || err.status >= 500);
      if (!transient || attempt >= tries) throw err;
      await sleep(delayMs);
    }
  }
}

/** True when git will not commit .env.local. Called before any key is written. */
export async function envLocalIsIgnored(run, appDir) {
  const r = await run('git', ['check-ignore', '-q', '.env.local'], { cwd: appDir });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  // Not a git repo (or no git): fall back to reading .gitignore.
  const text = await readEnvText(path.join(appDir, '.gitignore'));
  return text.split(/\r?\n/).map((l) => l.trim()).some((l) => ['.env.local', '.env*.local', '.env.*', '.env*', '*.local'].includes(l));
}

function freeLimitError(active, orgId = '', { fromSupabase = false } = {}) {
  const list = active.map((p) => `${p.name} (${refOf(p)})${orgId && orgOf(p) && orgOf(p) !== orgId ? ' in another organization' : ''}`).join(', ');
  const first = fromSupabase && active.length < FREE_PLAN_ACTIVE_LIMIT
    ? `Supabase says you have reached the free plan limit of ${FREE_PLAN_ACTIVE_LIMIT} active projects (it also counts projects in organizations this token cannot see${active.length ? `; the ones visible here: ${list}` : ''}).\n`
    : `Your Supabase free plan allows ${FREE_PLAN_ACTIVE_LIMIT} active projects in total, across all your organizations, and you already have ${active.length}: ${list}.\n`;
  return new ProvisionError(
    first
    + 'Pick one:\n'
    + '  (a) Pause an old project you do not use: Supabase dashboard > the project > Settings > General > Pause project. Then run this again. This is the safe choice.\n'
    + '  (b) Share one of them with this app: run this again with --reuse <project id>. Think twice: the apps then share one list of users (anyone who signed up in one app can sign in to the other, and the admin flag carries over), and tables with the same name are shared too. Every app made by Shipyard starts with "profiles" and "items", so Shipyard stops if it finds a table name that is already taken.',
    { reason: 'free-limit', activeProjects: active.map((p) => ({ name: p.name, ref: refOf(p) })) },
  );
}

/** Supabase answers HTTP 400 "... (2 project limit)" when the free-project limit is hit. */
const isFreeLimitRefusal = (err) => err instanceof api.ApiError && err.status === 400 && /project limit|maximum limits/i.test(err.message);

/** Table names a set of migration files would create in the public schema. */
export function tablesCreatedBy(migrations) {
  const names = new Set();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(?:"?([a-z_][a-z0-9_]*)"?)\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const { sql } of migrations) {
    for (const m of String(sql).replace(/--[^\n]*/g, '').matchAll(re)) {
      if (m[1] && m[1].toLowerCase() !== 'public') continue;
      names.add(m[2].toLowerCase());
    }
  }
  return [...names];
}

const LIST_TABLES_SQL = "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE';";

function sharedOverlapError(others, overlap) {
  return new ProvisionError(
    `This Supabase project is already used by ${others.length === 1 ? 'another app' : 'other apps'} (${others.join(', ')}), and these table names are already taken there: ${overlap.join(', ')}.\n`
    + 'Running this app here would rewrite the privacy rules of those tables, so a change in one app could show the other app\'s data. Nothing was changed.\n'
    + 'Pause an old project in the Supabase dashboard (Settings > General > Pause project) and run this again without --reuse, or rename the tables in this app\'s supabase/migrations first.',
    { reason: 'shared-overlap', apps: others, tables: overlap },
  );
}

/**
 * Add the app's addresses to the project's sign-in settings. Never removes an address.
 * keepForeignSiteUrl: in a shared project, leave another app's main address alone.
 */
export async function updateAuthUrls(auth, ref, { appUrl, keepForeignSiteUrl = false }) {
  const current = (await api.getAuthConfig(auth, ref)) ?? {};
  const currentList = String(current.uri_allow_list ?? '');
  const currentSite = String(current.site_url ?? '');
  const additions = buildAllowList({ appUrl });
  const mergedList = api.mergeUriAllowList(currentList, additions);

  let siteUrl = appUrl || LOCAL_SITE;
  const foreign = currentSite && !isLocalOrigin(currentSite) && currentSite.replace(/\/$/, '') !== siteUrl;
  if (foreign && (keepForeignSiteUrl || !appUrl)) siteUrl = currentSite;

  const patch = {};
  if (siteUrl !== currentSite) patch.site_url = siteUrl;
  if (mergedList !== currentList) patch.uri_allow_list = mergedList;
  const known = new Set(currentList.split(',').map((s) => s.trim()));
  const added = additions.filter((a) => !known.has(a));
  if (Object.keys(patch).length > 0) await api.patchAuthConfig(auth, ref, patch);
  return { changed: Object.keys(patch).length > 0, siteUrl, added };
}

async function connect(deps) {
  const getSecret = deps.getSecret ?? realGetSecret;
  const token = await getSecret('SUPABASE_ACCESS_TOKEN');
  return { token, fetch: deps.fetch, sleep: deps.sleep };
}

async function profileFacts(profileApi, slug) {
  const profile = await profileApi.loadProfile();
  return {
    profile,
    orgId: profile.accounts?.supabase?.orgId ?? '',
    scope: profile.accounts?.vercel?.scope ?? '',
    region: profile.accounts?.supabase?.region || profile.defaults?.region || '',
    app: (profile.apps ?? []).find((a) => a.slug === slug) ?? null,
  };
}

async function saveRef({ appDir, profileApi, slug, ref, shared }) {
  await updateAppConfig(appDir, { supabaseRef: ref, ...(shared ? { supabaseShared: true } : {}) });
  await profileApi.upsertApp({ slug, supabaseRef: ref });
}

/**
 * Only the sign-in addresses (used after the app has its real web address).
 * opts: { appDir, url }
 */
export async function setAuthUrlsForApp({ appDir, url }, deps = {}) {
  const profileApi = deps.profile ?? realProfile;
  const config = await readAppConfig(appDir);
  const { app } = await profileFacts(profileApi, config.slug);
  const ref = config.supabaseRef || app?.supabaseRef;
  if (!ref) throw new ProvisionError('This app has no Supabase project yet. Run provision-supabase.mjs on the app folder first.');
  const appUrl = originOf(url);
  const auth = await connect(deps);
  const result = await updateAuthUrls(auth, ref, { appUrl, keepForeignSiteUrl: Boolean(config.supabaseShared) });
  return { ok: true, ref, ...result };
}

/**
 * opts: { appDir, reuse, region, url }
 * deps: { fetch, sleep, getSecret, run, profile } (all optional, for tests)
 */
export async function provisionSupabase(opts, deps = {}) {
  const { appDir } = opts;
  const profileApi = deps.profile ?? realProfile;
  const run = deps.run ?? realRun;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const config = await readAppConfig(appDir);
  const slug = config.slug;

  if (opts.url) {
    log.step(1, 1, 'Updating the sign-in addresses in Supabase');
    const result = await setAuthUrlsForApp({ appDir, url: opts.url }, deps);
    log.ok(result.changed ? `Sign-in addresses updated (${result.siteUrl}).` : 'Sign-in addresses were already up to date.');
    return result;
  }

  if (opts.region && !REGION_RE.test(opts.region)) {
    throw new ProvisionError(`"${opts.region}" does not look like a Supabase region. Use something like eu-central-1 or us-east-1.`);
  }
  if (opts.reuse && !REF_RE.test(opts.reuse)) {
    throw new ProvisionError(`"${opts.reuse}" is not a Supabase project id. It is 20 lowercase letters and numbers, shown in the project's address in the dashboard.`);
  }

  const { orgId, region: profileRegion, app } = await profileFacts(profileApi, slug);
  if (!orgId) {
    throw new ProvisionError('No Supabase organization is saved yet. Run /shipyard:setup and finish the "supabase" step.');
  }
  const auth = await connect(deps);
  const total = 5;

  // Before spending anything: make sure the keys can not end up on GitHub.
  if (!(await envLocalIsIgnored(run, appDir))) {
    throw new ProvisionError('Git would save the file .env.local (it will hold your keys). Add the line ".env.local" to .gitignore first, then run this again.');
  }

  // 1. The project
  log.step(1, total, 'Finding or creating the Supabase project');
  const projects = (await api.listProjects(auth)) ?? [];
  const inOrg = projects.filter((p) => !orgOf(p) || orgOf(p) === orgId);
  const recordedRef = config.supabaseRef || app?.supabaseRef || '';
  if (opts.reuse && recordedRef && recordedRef !== opts.reuse) {
    throw new ProvisionError(`This app is already connected to the Supabase project ${recordedRef}. To point it at ${opts.reuse} instead, remove "supabaseRef" from ${APP_CONFIG_FILE} (and from the app's entry in your Shipyard profile) first.`);
  }
  let ref = opts.reuse || recordedRef;
  let created = false;
  let shared = Boolean(opts.reuse) || Boolean(config.supabaseShared);

  if (ref) {
    const found = projects.find((p) => refOf(p) === ref);
    if (!found) {
      throw new ProvisionError(`The Supabase project ${ref} was not found in your account. If you deleted it, remove "supabaseRef" from .shipyard-app.json and run this again.`);
    }
    if (found.status === 'INACTIVE') {
      throw new ProvisionError(`The Supabase project "${found.name}" is paused. Open it in the Supabase dashboard, press Restore project, wait a minute, then run this again.`);
    }
    log.ok(`${opts.reuse ? 'Using the shared project' : 'Using the project'} "${found.name}" (${ref}).`);
  } else {
    const sameName = inOrg.find((p) => p.name === slug && p.status !== 'REMOVED');
    if (sameName) {
      throw new ProvisionError(`A Supabase project called "${slug}" already exists (${refOf(sameName)}). If it is the one for this app, run this again with --reuse ${refOf(sameName)}. Otherwise pick another app name.`);
    }
    // The free limit is per person, across every FREE organization (paid organizations do not count).
    const planOf = async (slugOrg) => {
      try { return (await api.getOrganization(auth, slugOrg))?.plan ?? 'free'; } catch { return 'free'; }
    };
    const chosenPlan = await planOf(orgId);
    let active = projects.filter(countsAsActive);
    if (chosenPlan === 'free') {
      const slugs = [...new Set(projects.map(orgOf).filter(Boolean))];
      const freeOrgs = new Set();
      for (const o of slugs) if (o === orgId ? true : (await planOf(o)) === 'free') freeOrgs.add(o);
      active = projects.filter((p) => countsAsActive(p) && (!orgOf(p) || freeOrgs.has(orgOf(p))));
      if (active.length >= FREE_PLAN_ACTIVE_LIMIT) throw freeLimitError(active, orgId);
    }
    const region = opts.region || profileRegion || DEFAULT_REGION;
    let project;
    try {
      project = await api.createProject(auth, { name: slug, organization_slug: orgId, region });
    } catch (err) {
      // Safety net: Supabase may count projects we cannot see here. Show the same friendly help.
      if (isFreeLimitRefusal(err)) throw freeLimitError(active, orgId, { fromSupabase: true });
      throw err;
    }
    ref = refOf(project);
    if (!ref) throw new ProvisionError('Supabase created the project but did not tell us its id. Check the dashboard, then run this again with --reuse <project id>.');
    created = true;
    shared = false;
    // Save at once: if anything below stops, a re-run continues with this project.
    await saveRef({ appDir, profileApi, slug, ref, shared });
    log.ok(`Created the project "${slug}" (${ref}) in ${region}.`);
  }
  if (opts.reuse) await saveRef({ appDir, profileApi, slug, ref, shared: true });

  log.info('Waiting for the project to start (this can take a few minutes the first time)...');
  await api.waitHealthy(auth, ref, { timeoutMs: created ? 8 * 60_000 : 3 * 60_000 });

  // 2. The database
  log.step(2, total, 'Building the database');
  const migrations = await readMigrations(appDir);
  const applied = [];
  const skipped = [];
  const exec = (sql) => withRetry(() => api.runSql(auth, ref, sql), { sleep });
  await exec(TRACKING_SQL);
  const rows = await exec('select name from public._shipyard_migrations;');
  const done = new Set((Array.isArray(rows) ? rows : []).map((r) => r.name));

  // A shared project: another Shipyard app may already own tables with the same names. This app's
  // migrations re-create policies by name, which would silently rewrite the other app's privacy rules.
  const sharedWith = [...new Set([...done].filter((n) => !n.startsWith(`${slug}/`)).map((n) => n.split('/')[0]))];
  if (shared && sharedWith.length > 0) {
    const pending = migrations.filter((m) => !done.has(migrationKey(slug, m.file)));
    const existing = new Set(((await exec(LIST_TABLES_SQL)) ?? []).map((r) => String(r.table_name).toLowerCase()));
    const overlap = tablesCreatedBy(pending).filter((t) => existing.has(t));
    if (overlap.length > 0) throw sharedOverlapError(sharedWith, overlap);
    log.warn(`This project is shared with ${sharedWith.join(', ')}: all of these apps use one list of users.`);
  }

  for (const { file, sql } of migrations) {
    const key = migrationKey(slug, file);
    if (done.has(key)) {
      skipped.push(file);
      continue;
    }
    const record = `insert into public._shipyard_migrations (name) values ('${key.replace(/'/g, "''")}') on conflict do nothing;`;
    try {
      await exec(`${sql}\n;\n${record}\n`);
    } catch (err) {
      throw new ProvisionError(`The database step "${file}" failed, so nothing after it was run. ${err.message}`);
    }
    applied.push(file);
  }
  if (migrations.length === 0) log.warn('No database files found in supabase/migrations.');
  else log.ok(`Database ready: ${applied.length} new step${applied.length === 1 ? '' : 's'} run, ${skipped.length} already done.`);

  // 3. Sign-in addresses
  log.step(3, total, 'Setting the sign-in addresses');
  const appUrl = config.url || app?.url || '';
  const authResult = await updateAuthUrls(auth, ref, { appUrl, keepForeignSiteUrl: shared });
  log.ok(authResult.changed ? `Sign-in addresses updated (${authResult.added.length} added).` : 'Sign-in addresses were already up to date.');

  // 4. Keys
  log.step(4, total, 'Saving the project keys to .env.local');
  const keys = await api.getApiKeys(auth, ref);
  await updateEnvFile(path.join(appDir, '.env.local'), {
    NEXT_PUBLIC_SUPABASE_URL: projectUrl(ref),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.publicKey,
    SUPABASE_SERVICE_ROLE_KEY: keys.serverKey,
  });
  log.ok('Keys saved in .env.local (this file never goes to GitHub).');

  // 5. Remember
  log.step(5, total, 'Saving what we did');
  await saveRef({ appDir, profileApi, slug, ref, shared });
  const status = app?.status === 'live' ? 'live' : 'provisioned';
  await profileApi.upsertApp({ slug, status, step: 'supabase' });

  return {
    ok: true,
    ref,
    url: projectUrl(ref),
    created,
    shared,
    sharedWith,
    keyKind: keys.kind,
    migrations: { applied, skipped },
    auth: { siteUrl: authResult.siteUrl, changed: authResult.changed, added: authResult.added },
    envFile: '.env.local',
  };
}
