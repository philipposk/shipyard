// backup-export against a fake Supabase: which tables, paging, where the files go, who can read them, and what never appears.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tempHome } from './ops-helpers.mjs';

const sandbox = await tempHome();
process.env.SHIPYARD_HOME = sandbox.home;

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { readAppConfig, updateAppConfig } = await import('../scripts/provision/common.mjs');
const { loadProfile } = await import('../scripts/lib/profile.mjs');
const { ApiError } = await import('../scripts/lib/supabase-api.mjs');
const { MissingSecretError } = await import('../scripts/lib/secrets.mjs');
const B = await import('../scripts/ops/backup-core.mjs');
const { latestBackup, backupStamp } = await import('../scripts/ops/common.mjs');
const { withDiskFacts, describeOps } = await import('../scripts/settings-page.mjs');

after(() => sandbox.cleanup());

const TOKEN = `sbp_${'a1b2c3d4e5'.repeat(4)}`;
const REF = 'abcdefghijklmnopqrst';
const posix = process.platform !== 'win32';

let n = 0;
async function makeApp({ modules = [], ref = REF, isolation } = {}) {
  const slug = `bk-app-${++n}`;
  const parent = path.join(sandbox.dir, `app${n}`);
  await scaffold({ slug, name: 'Backup App', description: 'x', parent });
  const dir = path.join(parent, slug);
  await updateAppConfig(dir, { ...(ref ? { supabaseRef: ref } : {}), modules });
  if (isolation) await writeFile(path.join(dir, 'supabase', 'isolation.json'), JSON.stringify(isolation));
  return { dir, slug };
}

/** A fake Supabase database: tables of rows, answering the few SQL shapes the backup uses. */
function fakeDb(tables, { pkOf = {}, failOn, migrations = ['0001_profiles.sql', '0002_items.sql'] } = {}) {
  const queries = [];
  const api = {
    async runSql(auth, ref, query) {
      queries.push({ query, token: auth.token, ref });
      if (failOn) {
        const err = failOn(query, queries.length);
        if (err) throw err;
      }
      if (query.includes('information_schema.tables')) return Object.keys(tables).map((table_name) => ({ table_name }));
      if (query.includes('_shipyard_migrations')) return migrations.map((name) => ({ name }));
      let m = /count\(\*\)::int as n from (?:public\."([^"]+)"|auth\.users)/.exec(query);
      if (m) return [{ n: (m[1] ? tables[m[1]] : tables.__auth).length }];
      m = /i\.indrelid = 'public\."([^"]+)"'::regclass/.exec(query);
      if (m) return (pkOf[m[1]] ?? []).map((col) => ({ col }));
      m = /from (public\."([^"]+)"|auth\.users)(?: order by (.+?))? limit (\d+) offset (\d+)\) t/.exec(query);
      if (m) {
        const rows = m[2] ? tables[m[2]] : tables.__auth;
        return [{ rows: rows.slice(Number(m[5]), Number(m[5]) + Number(m[4])) }];
      }
      throw new Error(`unexpected SQL: ${query}`);
    },
  };
  return { api, queries };
}
const rowsOf = (count, extra = {}) => Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, title: `Row ${i}`, ...extra }));
const exportIt = (app, db, opts = {}, deps = {}) => B.exportBackup({ appDir: app.dir, ...opts }, { api: db.api, getSecret: async () => TOKEN, homeDir: sandbox.home, ...deps });
const readJson = async (folder, file) => JSON.parse(await readFile(path.join(folder, file), 'utf8'));

test('exports every table on the privacy list, plus profiles: files, manifest, row counts', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(3), items: rowsOf(2), _shipyard_migrations: [] });
  const r = await exportIt(app, db);
  assert.equal(r.ok, true);
  assert.deepEqual((await readdir(r.folder)).sort(), ['items.json', 'manifest.json', 'profiles.json']);
  assert.deepEqual(await readJson(r.folder, 'profiles.json'), rowsOf(3));
  assert.deepEqual(await readJson(r.folder, 'items.json'), rowsOf(2));
  const manifest = await readJson(r.folder, 'manifest.json');
  assert.equal(manifest.app, app.slug);
  assert.equal(manifest.projectRef, REF);
  assert.deepEqual(manifest.tables.map((t) => [t.name, t.rows]).sort(), [['items', 2], ['profiles', 3]]);
  assert.deepEqual(manifest.schemaVersion, ['0001_profiles.sql', '0002_items.sql']);
  assert.equal(manifest.includesSignInList, false);
  assert.equal(r.rows, 5);
});

test('module tables come along (from the modules in .shipyard-app.json)', async () => {
  const app = await makeApp({ modules: ['billing'] });
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1), billing_customers: rowsOf(2), subscriptions: rowsOf(1), stripe_events: rowsOf(4) });
  const r = await exportIt(app, db);
  assert.deepEqual(r.tables.map((t) => t.name).sort(), ['billing_customers', 'items', 'profiles', 'stripe_events', 'subscriptions']);
});

test('a listed table that is not in the database yet is reported, not an error', async () => {
  const app = await makeApp({ modules: ['billing'] });
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1) });
  const r = await exportIt(app, db);
  assert.ok(r.missingTables.includes('billing_customers'));
  assert.equal(r.ok, true);
});

test('tables not on the privacy list are mentioned, and exported with --all-tables', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1), notes: rowsOf(2), _shipyard_migrations: rowsOf(1) });
  const r = await exportIt(app, db);
  assert.deepEqual(r.notIncluded, ['notes']);
  assert.ok(!r.tables.some((t) => t.name === 'notes' || t.name === '_shipyard_migrations'));
  const all = await exportIt(app, db, { allTables: true });
  assert.ok(all.tables.some((t) => t.name === 'notes'));
  assert.ok(!all.tables.some((t) => t.name === '_shipyard_migrations'), 'the bookkeeping table is never exported');
});

test('table names are checked: a name that is not plain lowercase is never put into SQL', async () => {
  const evil = 'items"; drop table profiles; --';
  const app = await makeApp({ isolation: [{ table: 'items', ownerColumn: 'user_id' }, { table: evil, ownerColumn: 'x' }, { table: 'Items', ownerColumn: 'x' }, { table: 'a b', ownerColumn: 'x' }, { table: '1abc', ownerColumn: 'x' }] });
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1), [evil]: rowsOf(1) });
  const r = await exportIt(app, db);
  assert.deepEqual(r.tables.map((t) => t.name).sort(), ['items', 'profiles']);
  assert.ok(!db.queries.some((q) => q.query.includes('drop table')));
  assert.ok(!db.queries.some((q) => /Items|a b|1abc/.test(q.query)));
});

test('big tables are read page by page in primary-key order, and nothing is lost or repeated', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(2500) }, { pkOf: { items: ['id'] } });
  const r = await exportIt(app, db);
  const pages = db.queries.filter((q) => q.query.includes('json_agg') && q.query.includes('public."items"'));
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => /limit (\d+) offset (\d+)/.exec(p.query).slice(1).map(Number)), [[1000, 0], [1000, 1000], [1000, 2500 - 500]]);
  assert.ok(pages.every((p) => p.query.includes('order by "id"')));
  const rows = await readJson(r.folder, 'items.json');
  assert.equal(rows.length, 2500);
  assert.equal(new Set(rows.map((x) => x.id)).size, 2500);
  assert.equal(rows[0].id, 'id-0');
  assert.equal(rows[2499].id, 'id-2499');
});

test('a big table without a primary key is ordered by ctid; a small table is read in one go', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(3), items: rowsOf(1200) });
  await exportIt(app, db);
  const items = db.queries.filter((q) => q.query.includes('json_agg') && q.query.includes('public."items"'));
  assert.ok(items.every((q) => q.query.includes('order by ctid')));
  const profiles = db.queries.filter((q) => q.query.includes('json_agg') && q.query.includes('public."profiles"'));
  assert.equal(profiles.length, 1);
  assert.ok(!profiles[0].query.includes('order by'));
});

test('--page-size is honoured', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(120) }, { pkOf: { items: ['id'] } });
  const r = await exportIt(app, db, { pageSize: 50 });
  assert.equal(db.queries.filter((q) => q.query.includes('json_agg') && q.query.includes('"items"')).length, 3);
  assert.equal((await readJson(r.folder, 'items.json')).length, 120);
});

test('if Supabase chokes on a big page it tries smaller pages', async () => {
  const app = await makeApp();
  let failures = 0;
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(300) }, {
    pkOf: { items: ['id'] },
    failOn: (query) => {
      if (query.includes('limit 1000') && failures++ < 1) return new ApiError(500, 'Supabase is having trouble right now.');
      return null;
    },
  });
  const r = await exportIt(app, db);
  assert.equal((await readJson(r.folder, 'items.json')).length, 300);
  assert.ok(db.queries.some((q) => q.query.includes('limit 500')));
});

test('a refused token stops at once (no retry) and leaves no half-finished backup behind', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(2) }, {
    failOn: (query) => (query.includes('json_agg') ? new ApiError(401, 'Supabase did not accept your access token.') : null),
  });
  await assert.rejects(exportIt(app, db), /did not accept your access token/);
  const left = await readdir(path.join(sandbox.home, 'backups', app.slug)).catch(() => []);
  assert.deepEqual(left, []);
});

test('files are private: the folder is owner-only (700) and every file is 600', { skip: !posix }, async () => {
  const app = await makeApp();
  const r = await exportIt(app, fakeDb({ profiles: rowsOf(1), items: rowsOf(1) }));
  const mode = async (p) => (await stat(p)).mode & 0o777;
  assert.equal(await mode(r.folder), 0o700);
  assert.equal(await mode(path.dirname(r.folder)), 0o700);
  assert.equal(await mode(path.join(sandbox.home, 'backups')), 0o700);
  for (const f of await readdir(r.folder)) assert.equal(await mode(path.join(r.folder, f)), 0o600, f);
});

test('the backup lives under ~/.shipyard/backups/<app>/<time>, never inside the app', async () => {
  const app = await makeApp();
  const r = await exportIt(app, fakeDb({ profiles: rowsOf(1), items: rowsOf(1) }));
  assert.ok(r.folder.startsWith(path.join(sandbox.home, 'backups', app.slug) + path.sep));
  assert.match(path.basename(r.folder), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  assert.ok(path.relative(app.dir, r.folder).startsWith('..'));
  const appFiles = (await readdir(app.dir, { recursive: true })).filter((f) => f.endsWith('manifest.json') || /backups?/.test(f));
  assert.deepEqual(appFiles.filter((f) => !f.includes('node_modules')), []);
});

test('refuses a folder inside the app or inside a git repository', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1) });
  await assert.rejects(exportIt(app, db, {}, { homeDir: path.join(app.dir, '.shipyard-home') }), /inside your app/);
  const repo = path.join(sandbox.dir, 'some-repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await assert.rejects(exportIt(app, db, {}, { homeDir: path.join(repo, 'home') }), /inside a git repository/);
  assert.equal(db.queries.length, 0, 'nothing was read from the database');
  await assert.rejects(readdir(path.join(repo, 'home')), /ENOENT/);
});

test('a git repository at the home folder is fine only when it ignores the backup folder', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1) });
  const userHome = path.join(sandbox.dir, 'dotfiles-home');
  const homeDir = path.join(userHome, '.shipyard');
  await mkdir(path.join(userHome, '.git'), { recursive: true });
  const asked = [];
  const notIgnored = async (cmd, args) => { asked.push([cmd, ...args]); return { code: 1, stdout: '', stderr: '' }; };
  await assert.rejects(exportIt(app, db, {}, { homeDir, userHome, run: notIgnored }), (e) => {
    assert.match(e.message, /git repository/);
    assert.match(e.message, /Nothing was exported/);
    assert.match(e.message, /\.gitignore/);
    assert.match(e.message, /: \.shipyard\/$/, 'tells the student the one line to add');
    return true;
  });
  assert.equal(db.queries.length, 0, 'nothing was read from the database');
  assert.deepEqual(asked[0].slice(0, 5), ['git', '-C', userHome, 'check-ignore', '-q']);
  assert.ok(asked[0][5].startsWith(path.join(homeDir, 'backups', app.slug)));
  await assert.rejects(readdir(homeDir), /ENOENT/);
  // ignored (exit 0) or no git program on this computer (127): fine
  for (const code of [0, 127]) {
    const r = await exportIt(app, db, {}, { homeDir, userHome, run: async () => ({ code, stdout: '', stderr: '' }) });
    assert.ok(r.folder.startsWith(homeDir));
  }
  // git could not tell (a broken repository): refuse rather than guess
  await assert.rejects(exportIt(app, db, {}, { homeDir, userHome, run: async () => ({ code: 128, stdout: '', stderr: 'fatal' }) }), /git repository/);
});

test('with the real git program: refused until ~/.gitignore lists the folder, then it works', async () => {
  const { run } = await import('../scripts/lib/run.mjs');
  if ((await run('git', ['--version'])).code !== 0) return;
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1) });
  const userHome = path.join(sandbox.dir, 'real-git-home');
  await mkdir(userHome, { recursive: true });
  assert.equal((await run('git', ['init', '-q', userHome])).code, 0);
  const homeDir = path.join(userHome, '.shipyard');
  await assert.rejects(exportIt(app, db, {}, { homeDir, userHome }), /does not ignore the backup folder/);
  await writeFile(path.join(userHome, '.gitignore'), '.shipyard/\n');
  const r = await exportIt(app, db, {}, { homeDir, userHome });
  assert.ok(r.folder.startsWith(homeDir));
  const status = await run('git', ['-C', userHome, 'status', '--porcelain', '--untracked-files=all']);
  assert.ok(!status.stdout.includes('backups'), 'git does not see the backup files');
});

test('the access token is used but never written to a file, a query or the result', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1) });
  const r = await exportIt(app, db);
  assert.ok(db.queries.every((q) => q.token === TOKEN && !q.query.includes(TOKEN)));
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  for (const f of await readdir(r.folder)) assert.ok(!(await readFile(path.join(r.folder, f), 'utf8')).includes(TOKEN), f);
  assert.ok((await readFile(path.join(app.dir, '.shipyard-app.json'), 'utf8')).indexOf(TOKEN) === -1);
});

test('no Supabase project yet, or no access token: plain messages, nothing written', async () => {
  const noRef = await makeApp({ ref: null });
  await assert.rejects(exportIt(noRef, fakeDb({})), /no Supabase project yet/);
  const app = await makeApp();
  await assert.rejects(
    B.exportBackup({ appDir: app.dir }, { api: fakeDb({}).api, getSecret: async () => { throw new MissingSecretError('SUPABASE_ACCESS_TOKEN', 'supabase'); }, homeDir: sandbox.home }),
    /SUPABASE_ACCESS_TOKEN is missing/,
  );
});

test('--include-auth also saves the sign-in list (ids and emails, never passwords)', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: rowsOf(1), items: rowsOf(1), __auth: [{ id: 'u1', email: 'a@example.com' }] });
  const without = await exportIt(app, db);
  assert.ok(!(await readdir(without.folder)).includes('auth_users.json'));
  const r = await exportIt(app, db, { includeAuth: true });
  assert.deepEqual(await readJson(r.folder, 'auth_users.json'), [{ id: 'u1', email: 'a@example.com' }]);
  const q = db.queries.find((x) => x.query.includes('json_agg') && x.query.includes('auth.users'));
  assert.ok(q);
  assert.ok(!/password|encrypted/i.test(q.query), 'password columns are not selected');
  assert.ok(!/phone|raw_user_meta_data|last_sign_in/.test(q.query), 'no phone numbers, names or profile data');
  assert.match(q.query, /select id, email, created_at, email_confirmed_at from auth\.users/);
  assert.equal((await readJson(r.folder, 'manifest.json')).includesSignInList, true);
});

test('an empty table is an empty list; two backups in the same second get different folders', async () => {
  const app = await makeApp();
  const db = fakeDb({ profiles: [], items: rowsOf(1) });
  const now = () => new Date('2026-10-16T14:03:09.500Z');
  const a = await exportIt(app, db, {}, { now });
  const b = await exportIt(app, db, {}, { now });
  assert.equal(path.basename(a.folder), '2026-10-16T14-03-09Z');
  assert.equal(path.basename(b.folder), '2026-10-16T14-03-09Z-2');
  assert.deepEqual(await readJson(a.folder, 'profiles.json'), []);
  assert.equal(backupStamp(new Date('2026-01-02T03:04:05.678Z')), '2026-01-02T03-04-05Z');
});

test('the last backup time reaches the app record, the profile and the settings page', async () => {
  const app = await makeApp();
  const r = await exportIt(app, fakeDb({ profiles: rowsOf(1), items: rowsOf(1) }));
  assert.equal((await readAppConfig(app.dir)).ops.backupAt, r.backupAt);
  const entry = (await loadProfile()).apps.find((a) => a.slug === app.slug);
  assert.equal(entry.ops.backupAt, r.backupAt);
  const last = await latestBackup(sandbox.home, app.slug);
  assert.equal(last.name, path.basename(r.folder));
  const facts = await withDiskFacts({ slug: app.slug, dir: app.dir }, { homeDir: sandbox.home });
  assert.match(facts.ops.backupAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  assert.match(describeOps(facts), /Last backup/);
});

test('the result tells how to restore, that the files are private, and about Supabase Pro backups', async () => {
  const app = await makeApp();
  const r = await exportIt(app, fakeDb({ profiles: rowsOf(1), items: rowsOf(1) }));
  const text = r.restore.join('\n');
  assert.match(text, /restore/i);
  assert.match(text, /personal data/);
  assert.match(text, /Supabase Pro has automatic daily backups/);
  assert.match(text, /include-auth/);
});

test('rows with odd content (quotes, newlines, unicode) survive the trip', async () => {
  const app = await makeApp();
  const odd = [{ id: '1', title: 'He said "hi"\nthen left ☃ \u{1F375}', n: 1.5, flag: null, nested: { a: [1, 2] } }];
  const r = await exportIt(app, fakeDb({ profiles: odd, items: [] }));
  assert.deepEqual(await readJson(r.folder, 'profiles.json'), odd);
});

test('nothing to back up yet is a plain message', async () => {
  const app = await makeApp({ isolation: [] });
  await assert.rejects(exportIt(app, fakeDb({})), /no tables to back up/);
});

test('cleanup of the temp folders', async () => {
  await rm(path.join(sandbox.dir, 'some-repo'), { recursive: true, force: true });
});

test('the restore steps say Claude does not open the files, and the sign-in list wording matches what is saved', () => {
  const plain = B.restoreSteps('/home/me/.shipyard/backups/app/t', false).join('\n');
  assert.match(plain, /does not open the files/);
  assert.match(plain, /without printing any row/);
  assert.ok(!/write the inserts|from the JSON file/i.test(plain));
  const withAuth = B.restoreSteps('/home/me/.shipyard/backups/app/t', true).join('\n');
  assert.match(withAuth, /ids, emails, sign-up dates/);
  assert.match(withAuth, /no passwords, phone numbers or names/);
});

// ---------------------------------------------------------------- an app in a shared Supabase project

test('shared project: the backup reads the app\'s own schema and never the public one (another app\'s tables)', async () => {
  const app = await makeApp();
  await updateAppConfig(app.dir, { shared: true, schema: 'app_bk' });
  const queries = [];
  const tables = { profiles: rowsOf(2), items: rowsOf(3) };
  const api = {
    async runSql(auth, ref, query) {
      queries.push(query);
      if (query.includes('information_schema.tables')) {
        assert.match(query, /table_schema = 'app_bk'/);
        return Object.keys(tables).map((table_name) => ({ table_name }));
      }
      if (query.includes('_shipyard_migrations')) return [{ name: '0001_profiles.sql' }];
      let m = /count\(\*\)::int as n from "app_bk"\."([^"]+)"/.exec(query);
      if (m) return [{ n: tables[m[1]].length }];
      m = /count\(\*\)::int as n from \(select u\.\* from auth\.users u where exists \(select 1 from "app_bk"\.profiles p where p\.id = u\.id\)\) as users/.exec(query);
      if (m) return [{ n: 2 }];
      m = /from "app_bk"\."([^"]+)"(?: order by (.+?))? limit (\d+) offset (\d+)\) t/.exec(query);
      if (m) return [{ rows: tables[m[1]].slice(Number(m[4]), Number(m[4]) + Number(m[3])) }];
      m = /from \(select u\.\* from auth\.users u .* as users order by "id" limit (\d+) offset (\d+)\) t/.exec(query);
      if (m) return [{ rows: [{ id: 'a', email: 'a@example.com' }, { id: 'b', email: 'b@example.com' }] }];
      throw new Error(`unexpected SQL: ${query}`);
    },
  };
  const r = await B.exportBackup({ appDir: app.dir, includeAuth: true }, { api, getSecret: async () => TOKEN, homeDir: sandbox.home });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tables.map((t) => [t.name, t.rows]).sort(), [['auth_users', 2], ['items', 3], ['profiles', 2]]);
  assert.deepEqual(await readJson(r.folder, 'profiles.json'), rowsOf(2));
  for (const q of queries) {
    assert.ok(!/\bpublic\b/i.test(q), `a query names public: ${q.slice(0, 100)}`);
    assert.ok(q.includes('app_bk') || q.includes('auth.users'), q.slice(0, 100));
  }
  // The login list holds every app's people: only those with a profile here are saved.
  assert.ok(queries.some((q) => /exists \(select 1 from "app_bk"\.profiles p where p\.id = u\.id\)/.test(q)));
  assert.equal((await readJson(r.folder, 'manifest.json')).schema, 'app_bk');
});

test('shared project: a schema name that is missing or not valid stops the backup before any query', async () => {
  const app = await makeApp();
  await updateAppConfig(app.dir, { shared: true });
  const queries = [];
  const api = { runSql: async (a, r, q) => { queries.push(q); return []; } };
  await assert.rejects(() => B.exportBackup({ appDir: app.dir }, { api, getSecret: async () => TOKEN, homeDir: sandbox.home }), /schema name is not recorded/);
  await updateAppConfig(app.dir, { schema: 'public' });
  await assert.rejects(() => B.exportBackup({ appDir: app.dir }, { api, getSecret: async () => TOKEN, homeDir: sandbox.home }), { name: 'ProvisionError' });
  assert.deepEqual(queries, []);
});
