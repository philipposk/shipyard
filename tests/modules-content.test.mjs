import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempParent } from './modules-helpers.mjs';

const tmp = await tempParent();
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.join(root, 'modules');

const core = await import('../scripts/modules/core.mjs');
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { KNOWN_SECRETS } = await import('../scripts/lib/secrets.mjs');
const { findServerKeyMisuse } = await import('../scripts/verify/server-key.mjs');

after(() => rm(tmp, { recursive: true, force: true }));

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}
const posix = (base, file) => path.relative(base, file).split(path.sep).join('/');

const names = await core.listModules(MODULES);

test('the plugin ships the billing, errors and newsletter modules', () => {
  assert.deepEqual(names, ['billing', 'errors', 'newsletter']);
});

for (const name of names) {
  test(`${name}: module.json is valid and lists exactly the files and database files on disk`, async () => {
    const { manifest, dir } = await core.loadModule(name, MODULES);
    assert.deepEqual(core.validateManifest(manifest, name), []);
    const onDisk = (await walk(path.join(dir, 'files'))).map((f) => posix(path.join(dir, 'files'), f)).sort();
    assert.deepEqual(onDisk, [...manifest.files].sort(), 'files/ and "files" in module.json match');
    const migrations = (await walk(path.join(dir, 'migrations'))).map((f) => posix(path.join(dir, 'migrations'), f)).sort();
    assert.deepEqual(migrations, [...(manifest.migrations ?? [])].sort());
    // Every module patch points at a file the app has (checked against the template).
    for (const patch of manifest.patches ?? []) {
      assert.ok(patch.note.length > 20, `${patch.id} has a useful note`);
    }
  });

  test(`${name}: nothing personal, no keys, no em dashes in text people read`, async () => {
    const { dir } = await core.loadModule(name, MODULES);
    // Written in pieces so this test file does not contain the words it looks for.
    const forbidden = new RegExp([['6x', '7'], ['six', 'seven'], ['fili', 'ppos'], ['fmr', 'nq'], ['pap', 'aki'], ['phk', 'tistakis'], ['Devo', 'loper'], ['Chat', 'GPT']].map((p) => p.join('')).join('|'), 'i');
    const keyLike = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|\bre_[A-Za-z0-9]{20,}|\bwhsec_[A-Za-z0-9]{16,}|\bsbp_[A-Za-z0-9]{20,}|-----BEGIN/;
    for (const file of await walk(dir)) {
      const text = await readFile(file, 'utf8');
      assert.doesNotMatch(text, forbidden, `${posix(dir, file)} mentions something personal`);
      assert.doesNotMatch(text, keyLike, `${posix(dir, file)} looks like it holds a key`);
      assert.ok(!text.includes('—'), `${posix(dir, file)} has an em dash`);
    }
  });

  test(`${name}: keys named by the module are known Shipyard keys or app-made settings`, async () => {
    const { manifest } = await core.loadModule(name, MODULES);
    const known = new Set(KNOWN_SECRETS.map((k) => k.name));
    for (const secret of manifest.perAppSecrets ?? []) assert.ok(known.has(secret), `${secret} is in the Shipyard keys file`);
    const documented = new Set((manifest.envExample ?? []).map((e) => e.name));
    for (const n of [...(manifest.env?.required ?? []), ...(manifest.generatedEnv ?? [])]) {
      // RESEND_FROM and RESEND_API_KEY are already in the template's .env.example.
      assert.ok(documented.has(n) || /^RESEND_/.test(n), `${n} is documented in envExample`);
    }
    // No setting that must stay secret may be public to the browser.
    for (const n of [...(manifest.env?.required ?? []), ...(manifest.env?.optional ?? []), ...(manifest.perAppSecrets ?? []), ...(manifest.generatedEnv ?? [])]) {
      if (/SECRET|^STRIPE_SECRET|SERVICE_ROLE|API_KEY/.test(n)) assert.doesNotMatch(n, /^NEXT_PUBLIC_/, `${n} must not be public`);
    }
  });
}

test('billing: the Stripe events in module.json are exactly the ones the webhook handles', async () => {
  const { manifest } = await core.loadModule('billing', MODULES);
  const { HANDLED_EVENT_TYPES } = await import(pathToFileURL(path.join(MODULES, 'billing', 'files', 'src', 'lib', 'billing', 'webhook.mjs')).href);
  assert.deepEqual([...manifest.stripeEvents].sort(), [...HANDLED_EVENT_TYPES].sort());
});

test('billing: plans.ts carries a JSON block between the markers that Shipyard\'s Stripe setup can read', async () => {
  const text = await readFile(path.join(MODULES, 'billing', 'files', 'src', 'lib', 'billing', 'plans.ts'), 'utf8');
  assert.equal(text.split('// shipyard:plans:start').length, 2);
  assert.equal(text.split('// shipyard:plans:end').length, 2);
  const m = /\/\/ shipyard:plans:start\r?\n([\s\S]*?)\r?\n\/\/ shipyard:plans:end/.exec(text);
  const plans = JSON.parse(m[1].replaceAll('<APP_SLUG>', 'demo-app'));
  assert.ok(Array.isArray(plans) && plans.length >= 2);
  assert.equal(plans.filter((p) => p.priceCents === 0).length, 1, 'one free plan');
  for (const p of plans.filter((x) => x.priceCents > 0)) {
    assert.match(p.lookupKey, /^demo-app_/, 'lookup keys start with the app name, so two apps never share one');
    assert.ok(Number.isInteger(p.priceCents) && ['month', 'year'].includes(p.interval) && /^[A-Z]{3}$/.test(p.currency));
  }
});

test('billing: the pre-delete hook is required and the module says which folder the server key lives in', async () => {
  const { manifest } = await core.loadModule('billing', MODULES);
  const hook = manifest.patches.find((p) => p.file === 'src/lib/account/pre-delete.ts');
  assert.equal(hook.required, true);
  assert.equal(hook.array, 'PRE_DELETE_HOOKS');
  assert.deepEqual(manifest.isolation.map((i) => i.table).sort(), ['billing_customers', 'stripe_events', 'subscriptions']);
  for (const entry of manifest.isolation) assert.equal(entry.seed, 'server', `${entry.table} is written by the server only`);
});

// ---------------------------------------------------------------------------------------------
// Both modules in a real copy of the template

const fakeRun = async () => ({ code: 0, stdout: '', stderr: '' });
const fakeProfile = {
  loadProfile: async () => ({ defaults: { layout: 'bottom-nav', pwa: true }, owner: {}, apps: [] }),
  upsertApp: async (a) => a,
  getApp: async () => null,
};

async function makeShopApp(slug, layout = 'bottom-nav') {
  const parent = path.join(tmp, `parent-${slug}`);
  await mkdir(parent, { recursive: true });
  await scaffold({ slug, name: 'Shop Front', description: 'A shop for handmade things.', parent, layout }, { run: fakeRun, profile: fakeProfile });
  return path.join(parent, slug);
}

const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'sh-home') } });

for (const order of [['billing', 'newsletter'], ['newsletter', 'billing']]) {
  test(`adding ${order.join(' then ')} to a fresh app: files, database, menu, public pages, settings page`, async () => {
    const appDir = await makeShopApp(`shop-${order[0]}`, order[0] === 'billing' ? 'sidebar' : 'top-nav');
    for (const name of order) {
      const plan = await core.planAddModule({ appDir, name }, { modulesDir: MODULES });
      assert.deepEqual(plan.blockers, [], `${name} has no blockers on the real template`);
      assert.deepEqual(plan.manual, [], `${name} needs nothing done by hand on the real template`);
      assert.ok(plan.patches.every((p) => p.status === 'apply'), `${name}: every edit found its place: ${JSON.stringify(plan.patches)}`);
      await core.applyAddModule(plan, { profile: fakeProfile });
    }
    const read = (rel) => readFile(path.join(appDir, ...rel.split('/')), 'utf8');

    assert.deepEqual(JSON.parse(await read('.shipyard-app.json')).modules, order);
    const migrations = (await readdir(path.join(appDir, 'supabase', 'migrations'))).sort();
    assert.deepEqual(migrations.slice(-2), order.map((n, i) => `${String(4 + i).padStart(4, '0')}_${n}.sql`));

    const proxy = await read('src/proxy.ts');
    for (const route of ['/pricing', '/api/billing/webhook', '/unsubscribe', '/api/newsletter/unsubscribe']) assert.ok(proxy.includes(`"${route}"`), route);
    const settings = await read('src/app/settings/page.tsx');
    assert.ok(settings.includes('<BillingSection />') && settings.includes('<NewsletterSettings />'));
    assert.match(await read('src/lib/health/checks.ts'), /\.\.\.billingHealthChecks[\s\S]*\.\.\.newsletterHealthChecks|\.\.\.newsletterHealthChecks[\s\S]*\.\.\.billingHealthChecks/);
    assert.match(await read('src/lib/account/pre-delete.ts'), /run: cancelBillingOnDelete/);
    assert.match(await read('src/app/sign-in/page.tsx'), /mode === "signup" && <SignupNewsletterOptIn email=\{email\} \/>/);
    assert.match(await read('src/app/layout.tsx'), /<NewsletterIntentApplier \/>/);
    assert.match(await read('src/lib/nav.ts'), /href: "\/pricing"/);
    assert.match(await read('src/lib/billing/plans.ts'), /"lookupKey": "shop-(?:billing|newsletter)_pro_monthly"/);
    assert.ok(!(await read('src/lib/billing/plans.ts')).includes('<APP_'), 'no placeholder is left');
    assert.match(await read('.env.local'), /^NEWSLETTER_SECRET=[0-9a-f]{64}$/m);
    assert.ok(!(await read('.env.example')).match(/(?:sk_|whsec_|re_)[A-Za-z0-9]{10}/), 'the example file holds no key');
    assert.equal(JSON.parse(await read('package.json')).dependencies.stripe, '^23.0.0');
  });

  test(`the app's own tests and design rules pass with ${order.join(' then ')} (privacy rules for the new tables included)`, async () => {
    const appDir = path.join(tmp, `parent-shop-${order[0]}`, `shop-${order[0]}`);
    const tests = sh(process.execPath, ['scripts/run-tests.mjs'], appDir);
    const summary = (tests.stdout.match(/^ℹ (?:tests|pass|fail) \d+/gm) ?? []).join(' | ');
    assert.equal(tests.status, 0, `${summary}\n${tests.stdout.split('\n').filter((l) => l.includes('✖')).join('\n')}`);
    // The module tests really ran in the app.
    for (const file of ['billing-webhook', 'billing-plans', 'newsletter-core', 'newsletter-send']) {
      assert.ok(await stat(path.join(appDir, 'tests', `${file}.test.mjs`)).then(() => true, () => false), file);
    }
    const design = sh(process.execPath, ['scripts/design-check.mjs'], appDir);
    assert.equal(design.status, 0, design.stdout + design.stderr);
  });
}

test('the app\'s key-leak scan finds nothing in the files the modules add (test keys are put together at run time)', async (t) => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) return t.skip('git is not installed');
  const appDir = path.join(tmp, 'parent-shop-billing', 'shop-billing');
  assert.equal(sh('git', ['init', '-q'], appDir).status, 0);
  assert.equal(sh('git', ['add', '-A'], appDir).status, 0);
  const tracked = sh('git', ['ls-files'], appDir).stdout.split('\n');
  assert.ok(tracked.includes('src/lib/billing/store.ts') && tracked.includes('tests/billing-health.test.mjs'));
  assert.ok(!tracked.includes('.env.local'), 'the private settings file is never tracked');
  const scan = sh(process.execPath, ['scripts/secret-scan.mjs'], appDir);
  assert.equal(scan.status, 0, scan.stdout + scan.stderr);
});

test('the two store files are allowed to use the secret server key and nothing else in the modules is flagged', async () => {
  const appDir = path.join(tmp, 'parent-shop-billing', 'shop-billing');
  const found = await findServerKeyMisuse(appDir);
  assert.equal(found.checked, true);
  assert.deepEqual(found.files, [], 'verify must not fail an app just because it added billing or the email list');
  const text = await readFile(path.join(appDir, 'src/lib/billing/store.ts'), 'utf8');
  assert.match(text, /createSupabaseAdmin|lib\/admin/, 'the store really does use the server key (so the allow-list entry is needed)');
});

test('every database file starts with a comment and turns on privacy rules for each table it makes', async () => {
  for (const name of names) {
    const { manifest, dir } = await core.loadModule(name, MODULES);
    for (const file of manifest.migrations) {
      const sql = await readFile(path.join(dir, 'migrations', file), 'utf8');
      assert.ok(sql.trimStart().startsWith('--'), `${file} starts with a comment`);
      const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
      assert.ok(tables.length > 0);
      for (const t of tables) {
        assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`), `${t} has RLS`);
        assert.ok(manifest.isolation.some((i) => i.table === t), `${t} is in the isolation list`);
      }
      assert.doesNotMatch(sql, /to (?:anon|public)\b/i);
      assert.doesNotMatch(sql, /grant (?:insert|update|delete|all)[^;]*to authenticated/i, `${file} gives signed-in people no write access`);
    }
  }
});
