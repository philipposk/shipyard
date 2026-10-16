// backup-export: copy the app's data out of Supabase into JSON files on the student's own computer.
// The files hold other people's personal data. They go in ~/.shipyard/backups/<app>/<time>/ (owner-only),
// never inside the app folder and never inside any git repository. Nothing here prints a row or a key.
import { open, mkdir, chmod, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR } from '../lib/paths.mjs';
import * as realApi from '../lib/supabase-api.mjs';
import { getSecret as realGetSecret } from '../lib/secrets.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { run as realRun } from '../lib/run.mjs';
import { ProvisionError, readAppConfig, atomicWrite } from '../provision/common.mjs';
import { loadModule } from '../modules/core.mjs';
import { backupStamp, recordOps } from './common.mjs';

export const TABLE_RE = /^[a-z_][a-z0-9_]*$/;
const INTERNAL_TABLES = new Set(['_shipyard_migrations']);
export const DEFAULT_PAGE = 1000;
const MIN_PAGE = 50;

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const isWindows = () => process.platform === 'win32';

/** The tables to export, from the app's own lists. Names that are not plain lowercase identifiers are dropped (and reported). */
export async function wantedTables(appDir, config, { modulesDir } = {}) {
  const names = [];
  const rejected = [];
  const add = (n) => {
    if (typeof n !== 'string') return;
    if (!TABLE_RE.test(n)) {
      if (!rejected.includes(n)) rejected.push(n);
      return;
    }
    if (!names.includes(n)) names.push(n);
  };
  try {
    const list = JSON.parse(await readFile(path.join(appDir, 'supabase', 'isolation.json'), 'utf8'));
    if (Array.isArray(list)) for (const e of list) add(e?.table);
  } catch {
    // no isolation list: profiles and module tables still count
  }
  add('profiles');
  for (const mod of Array.isArray(config.modules) ? config.modules : []) {
    try {
      const { manifest } = await loadModule(mod, modulesDir);
      for (const e of manifest.isolation ?? []) add(e.table);
    } catch {
      // a module this plugin version does not know: its tables are in isolation.json if it listed them
    }
  }
  return { names, rejected };
}

/**
 * Refuse a folder that is inside the app, or that has a git repository somewhere above it, where the files could
 * end up on GitHub. One exception: a repository at the student's own home folder (some people keep their dotfiles
 * there) is fine only when that repository ignores the backup folder. Otherwise a single "git add -A" in the home
 * folder would stage everyone's data.
 * deps: { run (to ask git), userHome }
 */
export async function assertSafeBackupFolder(folder, appDir, { run = realRun, userHome = os.homedir() } = {}) {
  const rel = path.relative(path.resolve(appDir), path.resolve(folder));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new ProvisionError('The backup folder would be inside your app. Backups hold your users\' personal data and must stay out of the app. Nothing was exported.');
  }
  const home = path.resolve(userHome);
  let dir = path.resolve(folder);
  for (;;) {
    if (dir === home) {
      const homeHasGit = await stat(path.join(home, '.git')).then(() => true, () => false);
      if (homeHasGit) await assertIgnoredByHomeRepo(folder, home, run);
      break;
    }
    const hasGit = await stat(path.join(dir, '.git')).then(() => true, () => false);
    if (hasGit) {
      throw new ProvisionError(`The backup folder (${folder}) is inside a git repository (${dir}), where it could end up on GitHub. Nothing was exported. Use the default folder under ~/.shipyard.`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** The home folder is a git repository: the backup folder must be ignored by it (exit 0 = ignored, 1 = not, 127 = no git program). */
async function assertIgnoredByHomeRepo(folder, home, run) {
  const result = await run('git', ['-C', home, 'check-ignore', '-q', path.resolve(folder)], { timeoutMs: 15_000 });
  if (result.code === 0 || result.code === 127) return; // ignored, or git is not even installed
  const shipyardFolder = path.relative(home, path.dirname(path.dirname(path.dirname(path.resolve(folder))))).split(path.sep).join('/');
  const line = shipyardFolder && !shipyardFolder.startsWith('..') ? `${shipyardFolder}/` : '.shipyard/';
  throw new ProvisionError(
    `Your home folder is a git repository and it does not ignore the backup folder, so one "git add -A" there could put your users' personal data on GitHub. Nothing was exported. `
    + `Add this one line to the file ${path.join(home, '.gitignore')} (create it if needed), then run the backup again: ${line}`,
  );
}

async function ownerOnly(dir) {
  if (isWindows()) return;
  try {
    await chmod(dir, 0o700);
  } catch {
    // not ours to change
  }
}

async function makeBackupDir(base, slug, stamp) {
  await mkdir(path.join(base, 'backups', slug), { recursive: true, mode: 0o700 });
  await ownerOnly(path.join(base, 'backups'));
  await ownerOnly(path.join(base, 'backups', slug));
  for (let n = 0; n < 50; n++) {
    const dir = path.join(base, 'backups', slug, n === 0 ? stamp : `${stamp}-${n + 1}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      await ownerOnly(dir);
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new ProvisionError('Could not make a new backup folder.');
}

const rowsOf = (result) => {
  const first = Array.isArray(result) ? result[0] : null;
  return first ?? {};
};

/**
 * opts: { appDir, pageSize, allTables, includeAuth }
 * deps: { api, getSecret, profile, fetch, sleep, homeDir, now, modulesDir, run, userHome }
 */
export async function exportBackup(opts, deps = {}) {
  const { appDir } = opts;
  const api = deps.api ?? realApi;
  const getSecret = deps.getSecret ?? realGetSecret;
  const profileApi = deps.profile ?? realProfile;
  const homeDir = deps.homeDir ?? HOME_DIR;
  const pageSize = Math.max(MIN_PAGE, Math.min(5000, Number(opts.pageSize) || DEFAULT_PAGE));

  const config = await readAppConfig(appDir);
  const slug = config.slug;
  const profileApp = await profileApi.getApp(slug).catch(() => null);
  const ref = config.supabaseRef || profileApp?.supabaseRef;
  if (!ref) throw new ProvisionError('This app has no Supabase project yet, so there is nothing to back up. Run provision-supabase.mjs first.');

  const stamp = backupStamp(deps.now ? deps.now() : new Date());
  await assertSafeBackupFolder(path.join(homeDir, 'backups', slug, stamp), appDir, { run: deps.run ?? realRun, userHome: deps.userHome });

  const token = await getSecret('SUPABASE_ACCESS_TOKEN');
  const auth = { token, fetch: deps.fetch, sleep: deps.sleep };
  const sql = async (query) => api.runSql(auth, ref, query);

  log.step(1, 3, 'Reading the list of tables');
  const wanted = await wantedTables(appDir, config, { modulesDir: deps.modulesDir });
  const listed = await sql("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name");
  const actual = (Array.isArray(listed) ? listed : []).map((r) => r.table_name).filter((n) => typeof n === 'string');
  const exportNames = wanted.names.filter((n) => actual.includes(n));
  const missing = wanted.names.filter((n) => !actual.includes(n));
  const others = actual.filter((n) => !wanted.names.includes(n) && !INTERNAL_TABLES.has(n) && TABLE_RE.test(n));
  if (opts.allTables) exportNames.push(...others);
  const notIncluded = opts.allTables ? [] : others;
  for (const n of missing) log.warn(`The table "${n}" is not in your database (yet), so it is not in the backup.`);
  for (const n of wanted.rejected) log.warn(`Skipped "${String(n).slice(0, 40)}": table names must be lowercase letters, numbers and underscores.`);
  if (notIncluded.length > 0) log.warn(`Not in the backup (not in your privacy list): ${notIncluded.join(', ')}. Add --all-tables to include them.`);
  if (exportNames.length === 0 && !opts.includeAuth) throw new ProvisionError('There are no tables to back up yet.');

  let migrations = [];
  try {
    const m = await sql('select name from public._shipyard_migrations order by name');
    migrations = (Array.isArray(m) ? m : []).map((r) => r.name).filter((n) => typeof n === 'string');
  } catch {
    // the app was set up some other way: the manifest just has no schema version
  }

  const dir = await makeBackupDir(homeDir, slug, stamp);
  const written = [];
  try {
    log.step(2, 3, `Copying ${exportNames.length} table${exportNames.length === 1 ? '' : 's'}${opts.includeAuth ? ' and the sign-in list' : ''}`);
    const jobs = exportNames.map((name) => ({ name, file: `${name}.json`, from: `public.${q(name)}`, pk: null, schema: 'public' }));
    if (opts.includeAuth) {
      jobs.push({
        name: 'auth_users', file: 'auth_users.json', schema: 'auth',
        from: 'auth.users', // Only what is needed to link the saved rows back to people: no phone numbers, names or profile data.
        columns: 'id, email, created_at, email_confirmed_at', order: 'id',
      });
    }
    for (const job of jobs) {
      const r = await copyTable({ sql, dir, job, pageSize });
      written.push({ name: job.name, file: job.file, rows: r.rows, expected: r.expected });
      if (r.rows === r.expected) log.ok(`${job.name}: ${r.rows} row${r.rows === 1 ? '' : 's'}`);
      else log.warn(`${job.name}: ${r.rows} rows copied, but the table had ${r.expected} when the copy started (it changed while copying).`);
    }

    log.step(3, 3, 'Writing the summary');
    const manifest = {
      app: slug,
      projectRef: ref,
      createdAt: new Date().toISOString(),
      tool: 'Shipyard backup-export',
      pageSize,
      tables: written,
      schemaVersion: migrations,
      notIncluded,
      missingTables: missing,
      includesSignInList: Boolean(opts.includeAuth),
      note: 'Rows are copied table by table, not as one single instant, so a busy app can differ a little between tables. Passwords are never included.',
    };
    await atomicWrite(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    if (!isWindows()) await chmod(path.join(dir, 'manifest.json'), 0o600).catch(() => {});
  } catch (err) {
    await rm(dir, { recursive: true, force: true }); // our own half-finished copy: not a backup
    throw err;
  }

  const backupAt = new Date().toISOString();
  try {
    await recordOps(appDir, { backupAt }, { profile: profileApi });
  } catch {
    // the backup itself is fine
  }
  const total = written.reduce((n, t) => n + t.rows, 0);
  return {
    ok: true, app: slug, folder: dir, tables: written, rows: total, notIncluded, missingTables: missing, includesSignInList: Boolean(opts.includeAuth),
    schemaVersion: migrations, backupAt,
    restore: restoreSteps(dir, Boolean(opts.includeAuth)),
  };
}

export function restoreSteps(dir, includesAuth) {
  return [
    'To restore: make sure the tables exist (run provision-supabase.mjs on the app), then ask Claude: "restore my backup of this app from this folder". Claude does not open the files (they hold your users\' personal data and stay out of the chat). It writes a small script on your computer that reads them and loads them table by table, the tables other tables point to first (for example profiles before items), without printing any row.',
    includesAuth
      ? 'The sign-in list (auth_users.json) has ids, emails, sign-up dates and whether the email was confirmed, but no passwords, phone numbers or names: people reset their password after a restore.'
      : 'People\'s sign-in accounts (emails and passwords) are not in this copy. Supabase Pro has automatic daily backups that include everything; the free plan does not. Add --include-auth to also save the sign-in list (ids, emails and sign-up dates; no passwords).',
    `Keep this folder private: ${dir}. It holds your users' personal data. Delete old backups you no longer need, and never put them on GitHub or in a chat.`,
  ];
}

async function copyTable({ sql, dir, job, pageSize }) {
  const countRow = rowsOf(await sql(`select count(*)::int as n from ${job.from}`));
  const expected = Number(countRow.n ?? 0);
  let order = job.order ? q(job.order) : null;
  if (!order && expected > pageSize) {
    const pk = await sql(
      `select a.attname as col from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) `
      + `where i.indrelid = 'public.${q(job.name)}'::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`,
    ).catch(() => []);
    const cols = (Array.isArray(pk) ? pk : []).map((r) => r.col).filter(Boolean);
    order = cols.length > 0 ? cols.map(q).join(', ') : 'ctid';
  }
  const columns = job.columns ?? '*';

  const file = path.join(dir, job.file);
  const handle = await open(file, 'wx', 0o600);
  let rows = 0;
  try {
    await handle.write('[');
    let first = true;
    let offset = 0;
    let size = pageSize;
    let halvings = 0;
    while (expected > 0 && offset < expected) {
      const query = `select coalesce(json_agg(t), '[]'::json) as rows from (select ${columns} from ${job.from}${order ? ` order by ${order}` : ''} limit ${size} offset ${offset}) t`;
      let page;
      try {
        page = rowsOf(await sql(query)).rows;
      } catch (err) {
        const retryable = err?.name === 'ApiError' && ![401, 403, 404, 429].includes(err.status);
        if (retryable && size > MIN_PAGE && halvings < 5) {
          size = Math.max(MIN_PAGE, Math.floor(size / 2));
          halvings++;
          continue;
        }
        throw err;
      }
      if (typeof page === 'string') page = JSON.parse(page);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const row of page) {
        await handle.write(`${first ? '\n' : ',\n'}${JSON.stringify(row)}`);
        first = false;
      }
      rows += page.length;
      offset += page.length;
    }
    await handle.write(first ? ']\n' : '\n]\n');
  } finally {
    await handle.close();
  }
  if (!isWindows()) await chmod(file, 0o600).catch(() => {});
  return { rows, expected };
}
