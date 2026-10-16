import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeApp, makeModule, tempParent, NAV_TS } from './modules-helpers.mjs';

const tmp = await tempParent();
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'scripts', 'add-module.mjs');

const core = await import('../scripts/modules/core.mjs');
const { planAddModule, applyAddModule, publicPlan, validateManifest, listModules, loadModule } = core;
const { main } = await import('../scripts/add-module.mjs');

after(() => rm(tmp, { recursive: true, force: true }));

const read = (dir, rel) => readFile(path.join(dir, ...rel.split('/')), 'utf8');
const exists = (dir, rel) => stat(path.join(dir, ...rel.split('/'))).then(() => true, () => false);
const config = async (dir) => JSON.parse(await read(dir, '.shipyard-app.json'));

function fakeProfile() {
  const calls = [];
  return { calls, getApp: async () => null, upsertApp: async (a) => { calls.push(a); return a; } };
}

let counter = 0;
async function setup(moduleOpts = {}, appExtra = {}) {
  const parent = path.join(tmp, `case-${++counter}`);
  await mkdir(parent, { recursive: true });
  const modulesDir = path.join(parent, 'modules');
  await makeModule(modulesDir, 'demo', moduleOpts);
  const appDir = await makeApp(parent, appExtra);
  return { parent, modulesDir, appDir };
}

async function add(appDir, modulesDir, opts = {}) {
  const profile = fakeProfile();
  const plan = await planAddModule({ appDir, name: 'demo', ...opts }, { modulesDir });
  if (plan.blockers.length === 0 && !plan.alreadyAdded && !opts.dryRun) await applyAddModule(plan, { profile });
  return { plan, profile };
}

// ---------------------------------------------------------------------------------------------

test('validateManifest accepts a normal module and explains each kind of mistake', () => {
  const good = { name: 'demo', description: 'x', files: ['src/a.ts'] };
  assert.deepEqual(validateManifest(good, 'demo'), []);
  const bad = (patch) => validateManifest({ ...good, ...patch }, 'demo').join(' | ');
  assert.match(bad({ name: 'Other' }), /name/);
  assert.match(bad({ name: 'other' }), /does not match the folder/);
  assert.match(bad({ description: '' }), /description/);
  assert.match(bad({ files: [] }), /files/);
  assert.match(bad({ files: ['../etc/passwd'] }), /relative/);
  assert.match(bad({ files: ['/abs/path.ts'] }), /relative/);
  assert.match(bad({ files: ['a\\b.ts'] }), /relative/);
  assert.match(bad({ files: ['a.ts', 'a.ts'] }), /duplicates/);
  assert.match(bad({ migrations: ['0004_x.sql'] }), /migration/);
  assert.match(bad({ migrations: ['x.txt'] }), /migration/);
  assert.match(bad({ env: { required: ['lower-case'] } }), /env.required/);
  assert.match(bad({ proxyPublic: ['no-slash'] }), /proxyPublic/);
  assert.match(bad({ nav: [{ href: '/x', label: 'X', icon: 'rocket' }] }), /nav item/);
  assert.match(bad({ isolation: [{ table: 'Bad Name', ownerColumn: 'user_id' }] }), /isolation/);
  assert.match(bad({ isolation: [{ table: 'a', ownerColumn: 'user_id', seed: 'client' }] }), /seed/);
  assert.match(bad({ dependencies: { stripe: 5 } }), /dependencies/);
  assert.match(bad({ patches: [{ id: 'p', file: 'src/a.ts', kind: 'anchor', anchor: 'x', insert: 'y', already: 'y' }] }), /note/);
  assert.match(bad({ patches: [{ id: 'p', file: 'src/a.ts', note: 'n', kind: 'array' }] }), /entry/);
  assert.match(bad({ patches: [{ id: 'p', file: 'src/a.ts', note: 'n', kind: 'weird' }] }), /kind/);
  assert.match(validateManifest(null, 'demo')[0], /not an object/);
});

test('listModules and loadModule: names, missing module, damaged module', async () => {
  const { modulesDir } = await setup();
  await makeModule(modulesDir, 'other');
  assert.deepEqual(await listModules(modulesDir), ['demo', 'other']);
  assert.deepEqual(await listModules(path.join(tmp, 'nowhere')), []);
  assert.equal((await loadModule('demo', modulesDir)).manifest.name, 'demo');
  await assert.rejects(() => loadModule('missing', modulesDir), /no module called "missing"/);
  await assert.rejects(() => loadModule('../x', modulesDir), /not a module name/);
  await writeFile(path.join(modulesDir, 'demo', 'module.json'), '{ nope');
  await assert.rejects(() => loadModule('demo', modulesDir), /damaged/);
  await writeFile(path.join(modulesDir, 'demo', 'module.json'), JSON.stringify({ name: 'demo' }));
  await assert.rejects(() => loadModule('demo', modulesDir), /damaged: .*description/);
});

test('adds the files, fills in the app name, records the module and updates the profile', async () => {
  const { appDir, modulesDir } = await setup();
  const { plan, profile } = await add(appDir, modulesDir);
  assert.deepEqual(plan.files.create, ['src/lib/demo/hello.ts']);
  assert.equal(await read(appDir, 'src/lib/demo/hello.ts'), 'export const hello = "hello from Demo App";\n');
  const cfg = await config(appDir);
  assert.deepEqual(cfg.modules, ['demo']);
  assert.equal(profile.calls.length, 1);
  assert.deepEqual(profile.calls[0].modules, ['demo']);
  assert.equal(profile.calls[0].slug, 'demo-app');
});

test('the app name is escaped when it goes into code', async () => {
  const { appDir, modulesDir } = await setup();
  const cfg = await config(appDir);
  await writeFile(path.join(appDir, '.shipyard-app.json'), JSON.stringify({ ...cfg, name: 'Say "hi" \\ now' }));
  await add(appDir, modulesDir);
  assert.equal(await read(appDir, 'src/lib/demo/hello.ts'), 'export const hello = "hello from Say \\"hi\\" \\\\ now";\n');
});

test('adding twice does nothing the second time', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { migrations: ['demo.sql'], isolation: [{ table: 'demo_rows', ownerColumn: 'user_id' }], proxyPublic: ['/demo'] }, migrations: { 'demo.sql': '-- demo\n' } });
  await add(appDir, modulesDir);
  const before = {
    proxy: await read(appDir, 'src/proxy.ts'),
    iso: await read(appDir, 'supabase/isolation.json'),
    cfg: await read(appDir, '.shipyard-app.json'),
    migrations: await readdir(path.join(appDir, 'supabase', 'migrations')),
  };
  const { plan } = await add(appDir, modulesDir);
  assert.equal(plan.alreadyAdded, true);
  assert.equal(await read(appDir, 'src/proxy.ts'), before.proxy);
  assert.equal(await read(appDir, 'supabase/isolation.json'), before.iso);
  assert.equal(await read(appDir, '.shipyard-app.json'), before.cfg);
  assert.deepEqual(await readdir(path.join(appDir, 'supabase', 'migrations')), before.migrations);
});

test('a half-finished earlier run is finished by running again (the module is recorded last)', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { migrations: ['demo.sql'] }, migrations: { 'demo.sql': '-- demo\n' } });
  await add(appDir, modulesDir);
  // Pretend the run stopped before the last step.
  const cfg = await config(appDir);
  await writeFile(path.join(appDir, '.shipyard-app.json'), JSON.stringify({ ...cfg, modules: [] }));
  const { plan } = await add(appDir, modulesDir);
  assert.equal(plan.alreadyAdded, false);
  assert.deepEqual(plan.files.same, ['src/lib/demo/hello.ts']);
  assert.equal(plan.migrations[0].status, 'present');
  assert.deepEqual((await config(appDir)).modules, ['demo']);
  assert.deepEqual((await readdir(path.join(appDir, 'supabase', 'migrations'))).filter((f) => f.includes('demo')), ['0003_demo.sql']);
});

test('--dry-run reports the plan and changes nothing', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { migrations: ['demo.sql'], proxyPublic: ['/demo'], generatedEnv: ['DEMO_SECRET'] }, migrations: { 'demo.sql': '-- demo\n' } });
  const proxyBefore = await read(appDir, 'src/proxy.ts');
  const result = await main({ _: [appDir, 'demo'], 'dry-run': true, 'force-file': [] }, { modulesDir });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, false);
  assert.equal(await exists(appDir, 'src/lib/demo/hello.ts'), false);
  assert.equal(await exists(appDir, 'supabase/migrations/0003_demo.sql'), false);
  assert.equal(await exists(appDir, '.env.local'), false);
  assert.equal(await read(appDir, 'src/proxy.ts'), proxyBefore);
  assert.deepEqual((await config(appDir)).modules, []);
  assert.deepEqual(result.env.generated, ['DEMO_SECRET']);
});

test('a file that exists and differs stops everything; nothing is written', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { migrations: ['demo.sql'], proxyPublic: ['/demo'] }, migrations: { 'demo.sql': '-- demo\n' } }, { 'src/lib/demo/hello.ts': 'my own version\n' });
  const proxyBefore = await read(appDir, 'src/proxy.ts');
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.files.conflict, ['src/lib/demo/hello.ts']);
  assert.match(plan.blockers[0], /src\/lib\/demo\/hello\.ts/);
  assert.match(plan.blockers[0], /--force-file/);
  assert.equal(await read(appDir, 'src/lib/demo/hello.ts'), 'my own version\n');
  assert.equal(await exists(appDir, 'supabase/migrations/0003_demo.sql'), false);
  assert.equal(await read(appDir, 'src/proxy.ts'), proxyBefore);
  assert.deepEqual((await config(appDir)).modules, []);
  await assert.rejects(() => applyAddModule(plan, { profile: fakeProfile() }), /already exist/);
});

test('--force-file replaces exactly the file named', async () => {
  const { appDir, modulesDir } = await setup(
    { files: { 'src/lib/demo/a.ts': 'module a\n', 'src/lib/demo/b.ts': 'module b\n' } },
    { 'src/lib/demo/a.ts': 'mine a\n', 'src/lib/demo/b.ts': 'mine b\n' },
  );
  const refused = await add(appDir, modulesDir, { forceFiles: ['src/lib/demo/a.ts'] });
  assert.deepEqual(refused.plan.files.conflict, ['src/lib/demo/b.ts']);
  assert.equal(await read(appDir, 'src/lib/demo/a.ts'), 'mine a\n');
  const done = await add(appDir, modulesDir, { forceFiles: ['src/lib/demo/a.ts', 'src/lib/demo/b.ts', 'src/not/in/module.ts'] });
  assert.deepEqual(done.plan.files.overwrite.sort(), ['src/lib/demo/a.ts', 'src/lib/demo/b.ts']);
  assert.equal(await read(appDir, 'src/lib/demo/a.ts'), 'module a\n');
  assert.ok(done.plan.warnings.some((w) => w.includes('src/not/in/module.ts')));
});

test('a file that is already identical is left alone', async () => {
  const { appDir, modulesDir } = await setup({}, { 'src/lib/demo/hello.ts': 'export const hello = "hello from Demo App";\n' });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.files.same, ['src/lib/demo/hello.ts']);
  assert.deepEqual(plan.files.create, []);
  assert.equal(plan.blockers.length, 0);
});

test('database files are numbered after the existing ones, in order, without gaps', async () => {
  const { appDir, modulesDir } = await setup(
    { manifest: { migrations: ['first.sql', 'second.sql'] }, migrations: { 'first.sql': '-- one\n', 'second.sql': '-- two\n' } },
    { 'supabase/migrations/0003_email_lookup.sql': '-- lookup\n', 'supabase/migrations/0004_other.sql': '-- other\n' },
  );
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.migrations.map((m) => m.to), ['supabase/migrations/0005_first.sql', 'supabase/migrations/0006_second.sql']);
  assert.equal(await read(appDir, 'supabase/migrations/0005_first.sql'), '-- one\n');
  assert.deepEqual(await readdir(path.join(appDir, 'supabase', 'migrations')), [
    '0001_profiles.sql', '0002_items.sql', '0003_email_lookup.sql', '0004_other.sql', '0005_first.sql', '0006_second.sql',
  ]);
});

test('with no migrations folder yet, numbering starts at 0001', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { migrations: ['demo.sql'] }, migrations: { 'demo.sql': '-- demo\n' } });
  await rm(path.join(appDir, 'supabase', 'migrations'), { recursive: true });
  const { plan } = await add(appDir, modulesDir);
  assert.equal(plan.migrations[0].to, 'supabase/migrations/0001_demo.sql');
});

test('tables go into isolation.json once, one per line like the template, with the module\'s test hints', async () => {
  const entry = { table: 'demo_rows', ownerColumn: 'user_id', seed: 'server', insert: { title: 'x' } };
  const { appDir, modulesDir } = await setup({ manifest: { isolation: [entry, { table: 'items', ownerColumn: 'user_id' }] } });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.isolation.added, ['demo_rows']);
  assert.deepEqual(plan.isolation.present, ['items']);
  const text = await read(appDir, 'supabase/isolation.json');
  assert.deepEqual(JSON.parse(text).map((e) => e.table), ['items', 'profiles', 'demo_rows']);
  assert.deepEqual(JSON.parse(text)[2], entry);
  assert.equal(text.split('\n').length, 6, 'one table per line');
  assert.match(text, /\{ "table": "items", "ownerColumn": "user_id" \}/);
});

test('a damaged isolation.json is not guessed at', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { isolation: [{ table: 'a', ownerColumn: 'user_id' }] } }, { 'supabase/isolation.json': '{ broken' });
  const { plan } = await add(appDir, modulesDir);
  assert.match(plan.blockers.join(' '), /isolation\.json/);
  assert.equal(await read(appDir, 'supabase/isolation.json'), '{ broken');
});

test('menu items go in above Settings, once, and an unknown icon is left for the student', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { nav: [{ href: '/pricing', label: 'Pricing', icon: 'info' }] } });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.nav.added, ['/pricing']);
  const nav = await read(appDir, 'src/lib/nav.ts');
  assert.ok(nav.indexOf('/pricing') > nav.indexOf('/items') && nav.indexOf('/pricing') < nav.indexOf('/settings'));
  assert.equal(nav.split('/pricing').length - 1, 1);

  const second = await setup({ manifest: { nav: [{ href: '/x', label: 'X', icon: 'help' }] } }, { 'src/lib/nav.ts': NAV_TS.replace(' | "help"', '') });
  const r = await add(second.appDir, second.modulesDir);
  assert.equal(r.plan.nav.manual.length, 1);
  assert.match(r.plan.manual.join(' '), /nav\.ts/);
  assert.equal(await read(second.appDir, 'src/lib/nav.ts'), NAV_TS.replace(' | "help"', ''));
});

test('public pages are added to the proxy list (and kept to the list, not just the file)', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { proxyPublic: ['/pricing', '/privacy', '/api/demo/hook'] } });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.proxy.added, ['/pricing', '/api/demo/hook']);
  assert.deepEqual(plan.proxy.present, ['/privacy']);
  const text = await read(appDir, 'src/proxy.ts');
  assert.match(text, /"\/api\/health",\n  "\/pricing",\n  "\/api\/demo\/hook",\n\];/);
});

test('if the proxy list can not be found the module is not added at all (its page would be hidden)', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { proxyPublic: ['/pricing'] } }, { 'src/proxy.ts': 'export function proxy() {}\n' });
  const { plan } = await add(appDir, modulesDir);
  assert.match(plan.blockers.join(' '), /PUBLIC_PREFIXES/);
  assert.equal(await exists(appDir, 'src/lib/demo/hello.ts'), false);
  assert.deepEqual((await config(appDir)).modules, []);
  const missing = await setup({ manifest: { proxyPublic: ['/pricing'] } }, { 'src/proxy.ts': null });
  assert.match((await add(missing.appDir, missing.modulesDir)).plan.blockers.join(' '), /proxy\.ts is missing/);
});

const anchorPatch = (over = {}) => ({
  id: 'settings', file: 'src/app/settings/page.tsx', kind: 'anchor', anchor: 'shipyard:settings-sections:end', position: 'before',
  insert: '<DemoSection />', already: 'DemoSection', imports: ['import { DemoSection } from "@/components/DemoSection";'], note: 'Add <DemoSection /> to the settings page.', ...over,
});

test('an edit next to an anchor keeps the indentation and adds the import after the last import', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { patches: [anchorPatch()] } }, { 'src/app/settings/page.tsx': `import Link from "next/link";\nimport { AppShell } from "@/components/AppShell";\n\n${(await import('./modules-helpers.mjs')).SETTINGS_TSX}` });
  const { plan } = await add(appDir, modulesDir);
  assert.equal(plan.patches[0].status, 'apply');
  const text = await read(appDir, 'src/app/settings/page.tsx');
  assert.match(text, /import \{ AppShell \} from "@\/components\/AppShell";\nimport \{ DemoSection \} from "@\/components\/DemoSection";\n/);
  assert.match(text, /\n        <DemoSection \/>\n        \{\/\* shipyard:settings-sections:end \*\/\}/);
});

test('an edit that was already made is not made twice', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { patches: [anchorPatch()] } });
  await add(appDir, modulesDir);
  const once = await read(appDir, 'src/app/settings/page.tsx');
  // Add again after pretending the module was never recorded.
  const cfg = await config(appDir);
  await writeFile(path.join(appDir, '.shipyard-app.json'), JSON.stringify({ ...cfg, modules: [] }));
  const { plan } = await add(appDir, modulesDir);
  assert.equal(plan.patches[0].status, 'already');
  assert.equal(await read(appDir, 'src/app/settings/page.tsx'), once);
  assert.equal(once.split('DemoSection').length - 1, 3, 'import, import name use and one tag only');
});

test('an anchor that is not there becomes a plain-English to-do, and the module is still added', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { patches: [anchorPatch({ anchor: 'not in the file' })] } });
  const { plan } = await add(appDir, modulesDir);
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.patches[0].status, 'not-found');
  assert.match(plan.manual.join(' '), /Add <DemoSection \/> to the settings page\./);
  assert.deepEqual((await config(appDir)).modules, ['demo']);
});

test('a required edit that can not be placed stops the whole thing', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { patches: [anchorPatch({ anchor: 'not in the file', required: true })] } });
  const { plan } = await add(appDir, modulesDir);
  assert.match(plan.blockers.join(' '), /Nothing was changed/);
  assert.equal(await exists(appDir, 'src/lib/demo/hello.ts'), false);
});

test('list edits: an entry is added to a named list once, and a missing file can be skipped', async () => {
  const patches = [
    { id: 'health', file: 'src/lib/health/checks.ts', kind: 'array', array: 'HEALTH_CHECKS', entry: '...demoChecks', already: 'demoChecks', imports: ['import { demoChecks } from "@/lib/demo/health";'], skipIfFileMissing: true, note: 'Add demoChecks.' },
    { id: 'hook', file: 'src/lib/account/pre-delete.ts', kind: 'array', array: 'PRE_DELETE_HOOKS', entry: '{ id: "demo", label: "tidy up", run: tidy }', already: 'tidy', imports: ['import { tidy } from "@/lib/demo/tidy";'], required: true, skipIfFileMissing: true, note: 'Add the hook.' },
    { id: 'nofile', file: 'src/lib/nowhere.ts', kind: 'array', entry: 'x', already: 'x', skipIfFileMissing: true, note: 'n' },
  ];
  const { appDir, modulesDir } = await setup({ manifest: { patches } });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.patches.map((p) => p.status), ['apply', 'apply', 'file-missing']);
  assert.match(await read(appDir, 'src/lib/health/checks.ts'), /\.\.\.createTemplateChecks\(\{ env: process\.env \}\),\n  \.\.\.demoChecks,\n\];/);
  assert.match(await read(appDir, 'src/lib/account/pre-delete.ts'), /PreDeleteHook\[\] = \[\n  \{ id: "demo", label: "tidy up", run: tidy \},\n\];/);
  assert.match(plan.warnings.join(' '), /nowhere\.ts/);
});

test('a required list edit stops the module when the list has gone missing from an existing file', async () => {
  const patches = [{ id: 'hook', file: 'src/lib/account/pre-delete.ts', kind: 'array', array: 'PRE_DELETE_HOOKS', entry: 'x', already: 'x', required: true, note: 'Add the hook.' }];
  const { appDir, modulesDir } = await setup({ manifest: { patches } }, { 'src/lib/account/pre-delete.ts': 'export const SOMETHING_ELSE = 1;\n' });
  const { plan } = await add(appDir, modulesDir);
  assert.match(plan.blockers.join(' '), /Add the hook/);
  assert.equal(await exists(appDir, 'src/lib/demo/hello.ts'), false);
  // And a required edit in a file that is not there at all stops it too, unless skipping was allowed.
  const missing = await setup({ manifest: { patches: [{ ...patches[0], file: 'src/lib/gone.ts' }] } });
  assert.match((await add(missing.appDir, missing.modulesDir)).plan.blockers.join(' '), /gone\.ts is missing/);
});

test('several edits to one file build on each other', async () => {
  const patches = [anchorPatch(), anchorPatch({ id: 'second', insert: '<Other />', already: 'Other', imports: ['import { Other } from "@/components/Other";'] })];
  const { appDir, modulesDir } = await setup({ manifest: { patches } });
  await add(appDir, modulesDir);
  const text = await read(appDir, 'src/app/settings/page.tsx');
  assert.ok(text.includes('<DemoSection />') && text.includes('<Other />'));
  assert.ok(text.indexOf('<DemoSection />') < text.indexOf('<Other />'));
});

test('packages are added to package.json in order; versions the app already has are kept', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { dependencies: { stripe: '^23.0.0', next: '^15.0.0', alpha: '^1.0.0' }, devDependencies: { typescript: '^4', zeta: '^2' } } });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.packages.added.sort(), ['alpha ^1.0.0', 'stripe ^23.0.0', 'zeta ^2']);
  assert.deepEqual(plan.packages.kept.sort(), ['next ^16.2.9', 'typescript ^5']);
  const pkg = JSON.parse(await read(appDir, 'package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['alpha', 'next', 'server-only', 'stripe']);
  assert.equal(pkg.dependencies.next, '^16.2.9');
  assert.equal(pkg.devDependencies.zeta, '^2');
  assert.ok(plan.next[0].includes('npm install'));
});

test('.env.example gets a commented block with empty values, only for names it does not have', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { envExample: [{ name: 'DEMO_KEY', comment: 'Line one.\nLine two.' }, { name: 'NEXT_PUBLIC_SUPABASE_URL', comment: 'already there' }] } });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.env.exampleAdded, ['DEMO_KEY']);
  assert.equal(await read(appDir, '.env.example'), '# example\nNEXT_PUBLIC_SUPABASE_URL=\n\n# --- demo module ---\n# Line one.\n# Line two.\nDEMO_KEY=\n');
});

test('generated settings go into .env.local (private file, other lines kept) and are never printed', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { generatedEnv: ['DEMO_SECRET', 'KEPT_SECRET'] } }, { '.env.local': 'NEXT_PUBLIC_SITE_URL=http://localhost:3000\nKEPT_SECRET=already-here-1234567890\n' });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.env.generated, ['DEMO_SECRET']);
  const local = await read(appDir, '.env.local');
  assert.match(local, /^NEXT_PUBLIC_SITE_URL=http:\/\/localhost:3000\n/);
  assert.match(local, /\nKEPT_SECRET=already-here-1234567890\n/);
  const value = /DEMO_SECRET=([0-9a-f]{64})\n/.exec(local)?.[1];
  assert.ok(value, 'a 64 character random value was made');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(appDir, '.env.local'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(publicPlan(plan)).includes(value));
  const cli = await main({ _: [appDir, 'demo'], 'force-file': [] }, { modulesDir });
  assert.ok(!JSON.stringify(cli).includes(value));
});

test('env names are written into .shipyard-app.json without duplicates', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { env: { required: ['DEMO_KEY', 'SUPABASE_SERVICE_ROLE_KEY'], optional: ['DEMO_OPT'] }, perAppSecrets: ['DEMO_KEY'], generatedEnv: ['DEMO_SECRET'] } });
  const { plan } = await add(appDir, modulesDir);
  assert.deepEqual(plan.env.recorded, ['DEMO_KEY', 'DEMO_OPT', 'DEMO_SECRET']);
  assert.deepEqual((await config(appDir)).env, ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DEMO_KEY', 'DEMO_OPT', 'DEMO_SECRET']);
});

test('a module can need another module or a file the app must already have', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { dependsOn: ['base'], requiresFiles: ['src/lib/new-thing.mjs'] } });
  const { plan } = await add(appDir, modulesDir);
  assert.match(plan.blockers.join(' '), /Add the "base" module first/);
  assert.match(plan.blockers.join(' '), /src\/lib\/new-thing\.mjs/);
  assert.match(plan.blockers.join(' '), /older Shipyard/);
});

test('a folder that is not an app is refused, and so is one without Shipyard\'s config', async () => {
  const { parent, modulesDir } = await setup();
  const noSrc = await makeApp(parent, { 'src/lib/nav.ts': null, 'src/proxy.ts': null, 'src/app/settings/page.tsx': null, 'src/lib/health/checks.ts': null, 'src/lib/account/pre-delete.ts': null, 'src/lib/same-origin.mjs': null });
  await rm(path.join(noSrc, 'src'), { recursive: true, force: true });
  assert.match((await add(noSrc, modulesDir)).plan.blockers[0], /no src\/ folder/);
  const bare = path.join(parent, 'bare');
  await mkdir(bare);
  await assert.rejects(() => planAddModule({ appDir: bare, name: 'demo' }, { modulesDir }), /not made by Shipyard/);
});

test('apply refuses when the plan has blockers, and the profile gets a new app entry when the app is unknown', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { dependsOn: ['base'] } });
  const plan = await planAddModule({ appDir, name: 'demo' }, { modulesDir });
  await assert.rejects(() => applyAddModule(plan, { profile: fakeProfile() }), /Add the "base" module first/);
  const ok = await setup();
  const profile = fakeProfile();
  const goodPlan = await planAddModule({ appDir: ok.appDir, name: 'demo' }, { modulesDir: ok.modulesDir });
  await applyAddModule(goodPlan, { profile });
  assert.equal(profile.calls[0].dir, ok.appDir);
  assert.equal(profile.calls[0].status, 'scaffolded');
  // A profile that fails must not undo the work.
  const broken = { getApp: async () => { throw new Error('disk full'); }, upsertApp: async () => {} };
  const again = await setup();
  const p = await planAddModule({ appDir: again.appDir, name: 'demo' }, { modulesDir: again.modulesDir });
  await applyAddModule(p, { profile: broken });
  assert.ok(p.warnings.some((w) => w.includes('app list')));
  assert.deepEqual((await config(again.appDir)).modules, ['demo']);
});

test('the profile is updated for real (modules list on the app entry)', async () => {
  const { appDir, modulesDir } = await setup();
  const profileLib = await import('../scripts/lib/profile.mjs');
  const plan = await planAddModule({ appDir, name: 'demo' }, { modulesDir });
  await applyAddModule(plan);
  const app = await profileLib.getApp('demo-app');
  assert.deepEqual(app.modules, ['demo']);
  assert.equal(app.dir, appDir);
  // And again with an entry that exists: only the module list changes.
  await profileLib.upsertApp({ slug: 'demo-app', url: 'https://demo.example.com' });
  assert.equal((await profileLib.getApp('demo-app')).url, 'https://demo.example.com');
});

// ---------------------------------------------------------------------------------------------
// The command line

const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'cli-home'), ...env } });

test('CLI: --help, --list and wrong options', async () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /billing/);
  assert.match(help.stdout, /newsletter/);
  const list = run(['--list', '--json']);
  assert.equal(list.status, 0);
  assert.deepEqual(JSON.parse(list.stdout).modules.map((m) => m.name), ['billing', 'errors', 'newsletter']);
  // --help names every module that ships
  for (const name of JSON.parse(list.stdout).modules.map((m) => m.name)) assert.match(help.stdout, new RegExp(`^  ${name}\\s`, 'm'), `--help should list ${name}`);
  for (const bad of [[], ['only-one-arg'], ['--nope']]) {
    const r = run(bad);
    assert.equal(r.status, 2, bad.join(' '));
  }
  const json = run([], {});
  assert.equal(json.status, 2);
  assert.match(json.stdout, /Give the app folder and the module/);
  const missing = run(['--json', path.join(tmp, 'nowhere'), 'billing']);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
});

test('CLI: adds a fixture module to a fake app with --json and then reports it is already there', async () => {
  const { appDir, modulesDir } = await setup({ manifest: { proxyPublic: ['/demo'] } });
  const first = run([appDir, 'demo', '--modules-dir', modulesDir, '--json']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.deepEqual(out.proxy.added, ['/demo']);
  assert.ok(!('_writes' in out) && !('_config' in out));
  const second = run([appDir, 'demo', '--modules-dir', modulesDir, '--json']);
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).alreadyAdded, true);
});

test('CLI: a conflict exits 1 and says which file', async () => {
  const { appDir, modulesDir } = await setup({}, { 'src/lib/demo/hello.ts': 'mine\n' });
  const r = run([appDir, 'demo', '--modules-dir', modulesDir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /src\/lib\/demo\/hello\.ts/);
  const forced = run([appDir, 'demo', '--modules-dir', modulesDir, '--force-file', 'src/lib/demo/hello.ts', '--json']);
  assert.equal(forced.status, 0, forced.stdout);
  assert.equal(JSON.parse(forced.stdout).files.overwrite[0], 'src/lib/demo/hello.ts');
});

// ---------------------------------------------------------------------------------------------
// patch.mjs

const P = await import('../scripts/modules/patch.mjs');

test('patch: imports go after the last import, also multi-line ones, and after a "use client" line when there are none', () => {
  const multi = 'import {\n  a,\n  b,\n} from "x";\nimport c from "y";\n\nexport const z = 1;\n';
  assert.equal(P.addImports(multi, ['import d from "d";']).text, 'import {\n  a,\n  b,\n} from "x";\nimport c from "y";\nimport d from "d";\n\nexport const z = 1;\n');
  assert.equal(P.addImports('"use client";\n\nexport const z = 1;\n', ['import d from "d";']).text, '"use client";\nimport d from "d";\n\nexport const z = 1;\n');
  assert.equal(P.addImports('export const z = 1;\n', ['import d from "d";']).text, 'import d from "d";\nexport const z = 1;\n');
  assert.deepEqual(P.addImports(multi, ['import c from "y";']).added, []);
});

test('patch: list edits handle empty, one-line, trailing-comma and typed lists, strings and comments', () => {
  const add = (text, name, entry) => P.addToArray(text, { name, entry });
  assert.equal(add('export const A = [];', 'A', 'x').text, 'export const A = [\n  x,\n];');
  assert.equal(add('export const A = [1, 2];', 'A', 'x').text, 'export const A = [1, 2, x];');
  assert.equal(add('export const A: Array<() => void> = [\n  one,\n  two\n];\n', 'A', 'three').text, 'export const A: Array<() => void> = [\n  one,\n  two,\n  three,\n];\n');
  assert.equal(add('const B = ["]", /* ] */ "x"];\n', 'B', '"y"').text, 'const B = ["]", /* ] */ "x", "y"];\n');
  assert.equal(add('export const A = [\n  { a: [1, 2] },\n];', 'A', '{ b: 1 }').text, 'export const A = [\n  { a: [1, 2] },\n  { b: 1 },\n];');
  assert.equal(add('export const A = [\r\n  one,\r\n];', 'A', 'two').text, 'export const A = [\r\n  one,\r\n  two,\r\n];');
  assert.equal(add('export const A = [\n  x,\n];', 'A', 'x').already, true);
  assert.equal(add('export const A = 5;', 'A', 'x').ok, false);
  assert.equal(add('export const A = [1];', 'MISSING', 'x').ok, false);
  // No name: the first exported list.
  assert.equal(P.addToArray('const hidden = [1];\nexport const N = 4;\nexport const LIST = [a];\n', { entry: 'b' }).text, 'const hidden = [1];\nexport const N = 4;\nexport const LIST = [a, b];\n');
});

test('patch: anchors work on the first or last match and keep Windows line endings', () => {
  const text = 'a\r\n  <X />\r\n  <X />\r\nz\r\n';
  assert.equal(P.insertAtAnchor(text, { anchor: '<X />', insert: '<Y />', position: 'after' }).text, 'a\r\n  <X />\r\n  <Y />\r\n  <X />\r\nz\r\n');
  assert.equal(P.insertAtAnchor(text, { anchor: '<X />', insert: '<Y />', position: 'before', occurrence: 'last' }).text, 'a\r\n  <X />\r\n  <Y />\r\n  <X />\r\nz\r\n');
  assert.equal(P.insertAtAnchor(text, { anchor: 'nope', insert: 'y' }).ok, false);
});

test('patch: nav icons are read from the type, and Settings stays last', () => {
  assert.deepEqual(P.navIconNames(NAV_TS), ['home', 'items', 'settings', 'info', 'help']);
  assert.equal(P.navIconNames('const x = 1;'), null);
  const r = P.addNavItem(NAV_TS, { href: '/a', label: 'A', icon: 'help' });
  assert.ok(r.text.indexOf('"/a"') < r.text.indexOf('"/settings"'));
  assert.equal(P.addNavItem(r.text, { href: '/a', label: 'A', icon: 'help' }).already, true);
  assert.equal(P.addNavItem(NAV_TS, { href: '/b', label: 'B', icon: 'rocket' }).ok, false);
  // No Settings entry: it goes at the end.
  const noSettings = NAV_TS.replace(/  \{ href: "\/settings".*\n/, '');
  assert.match(P.addNavItem(noSettings, { href: '/b', label: 'B', icon: 'info' }).text, /icon: "items" \},\n  \{ href: "\/b", label: "B", icon: "info" \},\n\];/);
});
