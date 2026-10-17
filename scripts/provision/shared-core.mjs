// Put an app inside a Supabase project that other apps already use, without touching any of them.
//
// The app gets its own Postgres schema (a separate folder for its tables). Shipyard looks at the project first,
// changes only the few things shared mode is allowed to change, looks again, and stops with exact "put it back"
// commands if anything else is different. It never reverts anything by itself.
import path from 'node:path';
import * as api from '../lib/supabase-api.mjs';
import { getSecret as realGetSecret } from '../lib/secrets.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { APP_CONFIG_FILE, ProvisionError, readAppConfig, updateAppConfig } from './common.mjs';
import { updateEnvFile } from './envfile.mjs';
import {
  REF_RE, refOf, projectUrl, withRetry, envLocalIsIgnored, buildAllowList, readMigrations, updateAuthUrls,
} from './supabase-core.mjs';
import { assertSchemaAware } from './app-schema-check.mjs';
import {
  assertSchemaName, schemaNameProblem, defaultSchemaName, transformMigration, mergeDbSchemas, splitSchemaList,
  createSchemaSql, migrationSql, setDbSchemasSql, revokePublicFunctionsSql, DB_SCHEMAS_CHANGED_MESSAGE,
  schemaExistsSql, appTableExistsSql, readAppSlugsSql, migrationsTableExistsSql, readAppliedSql,
} from './shared-sql.mjs';
import {
  takeSnapshot, diffSnapshots, probeSchemas, restoreCommands, saveSnapshotFile, utcStamp, SNAPSHOT_DIR,
} from './shared-snapshot.mjs';

export const SCHEMA_ENV_NAME = 'NEXT_PUBLIC_SUPABASE_SCHEMA';
export const SHARED_WARNING = 'Apps in the same project share one login list: someone with an account in another app there can sign in here with the same email and password. Each app\'s data stays separate.';

const isTrue = (v) => v === true || v === 't' || v === 'true' || v === 1;
const asRows = (result) => (Array.isArray(result) ? result : []);

async function connect(deps) {
  const getSecret = deps.getSecret ?? realGetSecret;
  return { token: await getSecret('SUPABASE_ACCESS_TOKEN'), fetch: deps.fetch, sleep: deps.sleep };
}

function chooseSchema(slug, requested) {
  if (requested !== undefined && requested !== null && requested !== '') return assertSchemaName(String(requested));
  const name = defaultSchemaName(slug);
  const problem = schemaNameProblem(name);
  if (problem) {
    throw new ProvisionError(`The app name "${slug}" makes the schema name "${name}", and it can not be used. ${problem}\nChoose one yourself with --schema, for example --schema app_notes.`, { reason: 'bad-schema-name' });
  }
  return name;
}

/**
 * opts: { appDir, shared (project id), schema?, dryRun? }
 * deps: { fetch, restFetch?, sleep, getSecret, run, profile, now } (all optional, for tests)
 */
export async function provisionShared(opts, deps = {}) {
  const { appDir } = opts;
  const dryRun = Boolean(opts.dryRun);
  const ref = opts.shared;
  const profileApi = deps.profile ?? realProfile;
  const run = deps.run ?? realRun;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const total = 6;

  // ---- 0. Everything that can be decided without asking Supabase --------------------------------------------
  if (!REF_RE.test(String(ref))) {
    throw new ProvisionError(`"${ref}" is not a Supabase project id. It is 20 lowercase letters and numbers, shown in the project's address in the dashboard.`);
  }
  const config = await readAppConfig(appDir);
  const slug = config.slug;
  const schema = chooseSchema(slug, opts.schema);
  const profile = await profileApi.loadProfile();
  const app = (profile.apps ?? []).find((a) => a.slug === slug) ?? null;

  const recordedRef = config.supabaseRef || app?.supabaseRef || '';
  if (recordedRef && recordedRef !== ref) {
    throw new ProvisionError(`This app is already connected to the Supabase project ${recordedRef}. To use ${ref} instead, remove "supabaseRef" from ${APP_CONFIG_FILE} (and from the app's entry in your Shipyard profile) first.`);
  }
  if (recordedRef && !config.shared) {
    throw new ProvisionError(`This app already uses the Supabase project ${recordedRef} as its own project (its tables are in the public schema). Shared mode would start a second, empty copy of the app's database. Nothing was changed. To move the app, make a new app instead.`, { reason: 'already-provisioned' });
  }
  if (config.schema && config.schema !== schema) {
    throw new ProvisionError(`This app already uses the schema "${config.schema}" in this project. Run this again with --schema ${config.schema}, or leave --schema out.`, { reason: 'schema-mismatch' });
  }
  if (!(await envLocalIsIgnored(run, appDir))) {
    throw new ProvisionError('Git would save the file .env.local (it will hold your keys). Add the line ".env.local" to .gitignore first, then run this again.');
  }

  // The app's database files, rewritten for the schema. A file that touches anything shared stops everything here,
  // before Supabase has been asked anything.
  const migrations = await readMigrations(appDir);
  const planned = migrations.map(({ file, sql }) => ({ file, ...transformMigration(sql, { schema, file }) }));

  // The app's own code must use the schema too. Otherwise the deployed app would talk to `public`, which in a shared
  // project belongs to the other apps.
  await assertSchemaAware(appDir);

  // ---- 1. The project --------------------------------------------------------------------------------------
  log.step(1, total, `Checking the Supabase project ${ref}`);
  const auth = await connect(deps);
  let project;
  try {
    project = await api.getProject(auth, ref);
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      throw new ProvisionError(`The Supabase project ${ref} was not found in your account. Check the id (it is in the project's address in the dashboard).`);
    }
    throw err;
  }
  if (project?.status === 'INACTIVE') {
    throw new ProvisionError(`The Supabase project "${project.name ?? ref}" is paused. Open it in the Supabase dashboard, press Restore project, wait a minute, then run this again.`);
  }
  await api.waitHealthy(auth, ref, { timeoutMs: 3 * 60_000 });
  log.ok(`Using the project "${project?.name ?? ref}" (${refOf(project) || ref}). Other apps there are not touched.`);

  const exec = (sql) => withRetry(async () => asRows(await api.runSql(auth, ref, sql)), { sleep });
  const restFetch = deps.restFetch ?? deps.fetch;
  const url = projectUrl(ref);

  // ---- 2. Look before ---------------------------------------------------------------------------------------
  log.step(2, total, 'Looking at the project before changing anything (read-only)');
  const exists = asRows(await exec(schemaExistsSql(schema))).length > 0;
  const applied = new Set();
  if (exists) {
    const hasMarker = isTrue(asRows(await exec(appTableExistsSql(schema)))[0]?.found);
    const owners = hasMarker ? asRows(await exec(readAppSlugsSql(schema))).map((r) => r.slug) : [];
    if (!hasMarker || !owners.includes(slug)) {
      throw new ProvisionError(`The schema "${schema}" already exists in this project and does not belong to this app: another app already uses this name. Nothing was changed. Pick another name with --schema (for example --schema ${schema}_2).`, { reason: 'schema-taken' });
    }
    if (isTrue(asRows(await exec(migrationsTableExistsSql(schema)))[0]?.found)) {
      for (const r of asRows(await exec(readAppliedSql(schema)))) applied.add(String(r.name));
    }
  }
  const pre = await takeSnapshot({ auth, ref, exec, api, now, schema });
  const stamp = utcStamp(now());
  const snapshotName = `shared-snapshot-${stamp}.json`;
  const snapshotRel = `${SNAPSHOT_DIR}/${snapshotName}`;
  const snapshotBase = { version: 1, slug, ref, schema, dryRun };
  await saveSnapshotFile(appDir, snapshotName, { ...snapshotBase, phase: 'before', pre });
  log.ok(`Saved how the project looks now: ${snapshotRel}`);

  // Only the public key is needed to ask the API which schemas it serves. The secret server key is not even requested
  // here (and not at all in a dry run).
  const { publicKey } = await api.getPublicKey(auth, ref);
  const probe = (schemas, settle = 0) => probeSchemas({ fetch: restFetch, url, anonKey: publicKey, schemas, sleep, settle });

  const setting = pre.apiRole.dbSchemas;
  let baseList = splitSchemaList(setting.raw);
  let baseRaw = setting.raw;
  let inferred = false;
  if (baseList.length === 0) {
    // The database role does not say which schemas the API serves. Then the platform's own setting is what is served,
    // and the setting we are about to write replaces it: so start from that list, or the others would disappear.
    inferred = true;
    let platform = '';
    try {
      platform = (await api.getPostgrestConfig(auth, ref)).dbSchema;
    } catch (err) {
      if (!(err instanceof api.ApiError)) throw err;
    }
    baseList = splitSchemaList(platform);
    if (baseList.length === 0) {
      throw new ProvisionError('Shipyard could not find out which schemas this project\'s API serves (the project does not say, and Supabase did not tell). Nothing was changed. Add the app\'s schema by hand in the Supabase dashboard (Settings > API > Exposed schemas), or try again in a minute.', { reason: 'unknown-db-schemas' });
    }
    baseRaw = baseList.join(', ');
  }
  const preProbe = await probe(baseList);
  const merge = mergeDbSchemas(baseRaw, schema);

  const appUrl = config.url || app?.url || '';
  const additions = buildAllowList({ appUrl });
  const knownUrls = new Set(String(pre.auth.uriAllowList).split(',').map((s) => s.trim()));
  const allowAdds = additions.filter((a) => !knownUrls.has(a));
  const pending = planned.filter((m) => !applied.has(m.file));
  const skipped = planned.filter((m) => applied.has(m.file)).map((m) => m.file);

  log.warn(SHARED_WARNING);

  const plan = {
    createSchema: !exists,
    migrations: pending.map((m) => ({ file: m.file, leftOut: m.dropped, sql: m.sql })),
    alreadyDone: skipped,
    dbSchemas: { before: setting.raw, after: merge.merged, changed: merge.changed, inferred },
    redirectAddresses: { added: allowAdds },
    siteUrl: 'unchanged',
  };

  // ---- Dry run: show, change nothing -------------------------------------------------------------------------
  if (dryRun) {
    log.step(3, total, 'Dry run: this is what would happen (nothing was changed)');
    log.info(exists ? `The schema "${schema}" already exists and is this app's.` : `Create the schema "${schema}" (with usage for anon, authenticated and service_role).`);
    for (const m of pending) {
      log.info(`Run ${m.file}${m.dropped.length ? ` (left out: ${m.dropped.join(', ')})` : ''}:`);
      for (const line of m.sql.split('\n')) log.info(`    ${line}`);
    }
    if (skipped.length) log.info(`Already done: ${skipped.join(', ')}`);
    log.info(merge.changed ? `API schema list: "${setting.raw ?? '(not set)'}" becomes "${merge.merged}"` : `API schema list already includes "${schema}": no change.`);
    log.info(allowAdds.length ? `Redirect addresses added: ${allowAdds.join(', ')}` : 'Redirect addresses: no change.');
    log.info('Site URL, email settings, providers, the public schema and auth.users triggers: never touched.');
    return {
      ok: true, dryRun: true, shared: true, ref, schema, snapshotFile: snapshotRel, plan,
      probesBefore: preProbe, warnings: [SHARED_WARNING],
    };
  }

  // ---- 3. The few allowed changes ----------------------------------------------------------------------------
  // The secret server key is only needed to write .env.local. Fetch it now, so a problem stops us before any change.
  const keys = await api.getApiKeys(auth, ref);
  const done = [];
  let authResult;
  let listMaybeWritten = false;
  let listWritten = false;
  try {
    log.step(3, total, `Creating the app's own space "${schema}"`);
    await exec(createSchemaSql(schema, slug));
    done.push(exists ? 'checked the schema' : `created the schema "${schema}"`);

    log.step(4, total, 'Building the database inside it');
    for (const m of pending) {
      try {
        await exec(migrationSql(schema, m.file, m.sql));
      } catch (err) {
        throw new ProvisionError(`The database step "${m.file}" failed, so nothing after it was run (that step itself was undone). ${err.message}`);
      }
      done.push(`ran ${m.file}`);
    }
    // Postgres lets everybody run every new function; only the roles the files granted explicitly may.
    await exec(revokePublicFunctionsSql(schema));
    if (planned.length === 0) log.warn('No database files found in supabase/migrations.');
    else log.ok(`Database ready: ${pending.length} new step${pending.length === 1 ? '' : 's'} run, ${skipped.length} already done.`);

    if (merge.changed) {
      listMaybeWritten = true;
      // Written only if the list is still what we read before, so a schema another tool added meanwhile is never lost.
      await exec(setDbSchemasSql(merge.merged, setting.raw));
      listWritten = true;
      done.push('added the schema to the API list');
    }
    authResult = await updateAuthUrls(auth, ref, { appUrl, leaveSiteUrl: true });
    if (authResult.added.length) done.push('added redirect addresses');
  } catch (err) {
    const known = err instanceof ProvisionError || err instanceof api.ApiError;
    let detail = known ? err.message : `Something unexpected went wrong: ${err?.message ?? err}`;
    const raced = detail.includes(DB_SCHEMAS_CHANGED_MESSAGE);
    if (raced) detail = 'Another tool changed the project\'s list of exposed schemas while this was running, so Shipyard wrote nothing to it (the other change is kept).';
    // If the schema list may have been changed, say whether the API still serves every schema, and how to put it back.
    let extra = '';
    let restore = [];
    if (listMaybeWritten && !raced) {
      const after = await probe(baseList).catch(() => ({}));
      const lost = baseList.filter((s) => after[s] === 'not-exposed' && preProbe[s] !== 'not-exposed');
      if (lost.length > 0) extra += `\nThe API no longer serves: ${lost.join(', ')}. Other apps may be broken until the list is put back.`;
      if (listWritten || lost.length > 0) {
        restore = restoreCommands({ pre, schema, schemaCreated: !exists });
        extra += `\n${restore.join('\n')}`;
      }
    }
    throw new ProvisionError(
      `${detail}\nDone before it stopped: ${done.length ? done.join('; ') : 'nothing'}. Nothing else in the project was changed. Running the same command again continues where it stopped.${extra}`,
      { reason: raced ? 'db-schemas-changed' : 'stopped-midway', done, restore, snapshotFile: snapshotRel, ...(err instanceof ProvisionError ? err.data : {}) },
    );
  }

  // ---- 4. Look after, compare -------------------------------------------------------------------------------
  log.step(5, total, 'Checking that nothing else in the project changed');
  const post = await takeSnapshot({ auth, ref, exec, api, now, schema });
  const diff = diffSnapshots(pre, post, { schema, dbSchemasAfter: merge.list, allowListAdds: additions });
  const probeAfter = await probe([...new Set([...baseList, schema])], 4);
  const broken = [];
  const warnings = [SHARED_WARNING];
  for (const s of baseList) {
    if (probeAfter[s] === 'not-exposed') {
      if (preProbe[s] === 'not-exposed') warnings.push(`The API did not serve "${s}" before this run either, so that is not caused by this change.`);
      else broken.push(`The API stopped serving the schema "${s}" (HTTP 406 / PGRST106). Other apps may be broken.`);
    } else if (probeAfter[s] === 'unknown') {
      warnings.push(`Could not check that the API still serves "${s}" (no clear answer).`);
    }
  }
  if (probeAfter[schema] === 'not-exposed') {
    broken.push(`The API does not serve the new schema "${schema}" yet. It can take a minute: wait, then run this command again (it is safe to repeat).`);
  } else if (probeAfter[schema] === 'unknown') {
    warnings.push(`Could not check that the API serves "${schema}" (no clear answer). Verify will tell.`);
  }
  const problems = [...diff.unexpected, ...broken];
  await saveSnapshotFile(appDir, snapshotName, {
    ...snapshotBase, phase: 'after', pre, post, diff, probes: { before: preProbe, after: probeAfter },
  });
  if (problems.length > 0) {
    const restore = restoreCommands({ pre, schema, schemaCreated: !exists });
    throw new ProvisionError(
      `Stopped: after the change the project does not look the way it should.\n${problems.map((p) => `  - ${p}`).join('\n')}\n`
      + 'Nothing was put back automatically. If another person changed the project at the same time, the differences may not be from this run; the saved files below show both states.\n'
      + `${restore.join('\n')}\n`
      + `Before and after are saved in ${snapshotRel}.`,
      { reason: 'unexpected-change', unexpected: diff.unexpected, broken, restore, snapshotFile: snapshotRel, done },
    );
  }
  log.ok('Only the allowed changes happened. Other apps are exactly as before.');

  // ---- 5. Keys and records -----------------------------------------------------------------------------------
  log.step(6, total, 'Saving the project keys and the schema name to .env.local');
  await updateEnvFile(path.join(appDir, '.env.local'), {
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.publicKey,
    SUPABASE_SERVICE_ROLE_KEY: keys.serverKey,
    [SCHEMA_ENV_NAME]: schema,
  });
  log.ok('Keys saved in .env.local (this file never goes to GitHub).');
  const env = Array.isArray(config.env) && !config.env.includes(SCHEMA_ENV_NAME) ? { env: [...config.env, SCHEMA_ENV_NAME] } : {};
  await updateAppConfig(appDir, { supabaseRef: ref, schema, shared: true, ...env });
  const status = app?.status === 'live' ? 'live' : 'provisioned';
  await profileApi.upsertApp({ slug, supabaseRef: ref, schema, shared: true, status, step: 'supabase' });

  return {
    ok: true,
    shared: true,
    ref,
    url,
    schema,
    schemaCreated: !exists,
    snapshotFile: snapshotRel,
    keyKind: keys.kind,
    migrations: { applied: pending.map((m) => m.file), skipped },
    dbSchemas: { before: setting.raw, after: merge.merged, changed: merge.changed, inferred },
    auth: { siteUrl: authResult.siteUrl, changed: authResult.changed, added: authResult.added },
    probes: { before: preProbe, after: probeAfter },
    warnings,
    envFile: '.env.local',
  };
}
