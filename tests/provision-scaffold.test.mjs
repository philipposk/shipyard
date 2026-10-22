import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-scaffold-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const S = await import('../scripts/provision/scaffold-core.mjs');
const { loadProfile, saveProfile, defaultProfile } = await import('../scripts/lib/profile.mjs');
const { which } = await import('../scripts/lib/run.mjs');
const haveGit = (await which('git')) !== null;

let counter = 0;
const parentDir = () => path.join(tmp, `parent-${++counter}`);
const read = (...p) => readFile(path.join(...p), 'utf8');

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

before(async () => {
  await saveProfile(defaultProfile());
});
after(() => rm(tmp, { recursive: true, force: true }));

test('slugProblem accepts good slugs and explains bad ones', () => {
  for (const ok of ['ab', 'recipe-box', 'a1', 'todo-2', 'a'.repeat(39)]) assert.equal(S.slugProblem(ok), null, ok);
  for (const bad of ['', 'a', 'A', 'My App', '1abc', '-abc', 'abc-', 'a--b', 'a_b', 'a.b', 'a'.repeat(40), 'ünï', undefined, 7, '../x', 'a/b']) {
    assert.match(S.slugProblem(bad) ?? '', /\w/, `should reject ${String(bad)}`);
  }
});

test('shortNameOf, titleFromSlug and cleanText', () => {
  assert.equal(S.shortNameOf('Recipe Box'), 'Recipe Box');
  assert.equal(S.shortNameOf('Recipe Box Deluxe Edition'), 'Recipe');
  assert.equal(S.shortNameOf('Neighbourhood Garden Swap'), 'Neighbourhoo');
  assert.equal(S.shortNameOf('Supercalifragilistic Thing'), 'Supercalifra');
  assert.ok(S.shortNameOf('x'.repeat(30)).length <= 12);
  assert.equal(S.titleFromSlug('my-recipe-box'), 'My Recipe Box');
  assert.equal(S.cleanText('  a\n\tb c   d \u0000 '), 'a b c d');
});

test('fillPlaceholders escapes quotes and backslashes in code files only', () => {
  const values = { SLUG: 's', NAME: 'He said "hi" \\ bye', SHORT_NAME: 'x', DESCRIPTION: '$& and $1', TAGLINE: 't', LAYOUT: 'sidebar' };
  const code = S.fillPlaceholders('const n = "<APP_NAME>"; const d = "<APP_DESCRIPTION>";', '.ts', values);
  assert.equal(code, 'const n = "He said \\"hi\\" \\\\ bye"; const d = "$& and $1";');
  assert.equal(JSON.parse(S.fillPlaceholders('{"n":"<APP_NAME>"}', '.json', values)).n, values.NAME);
  assert.equal(S.fillPlaceholders('# <APP_NAME>', '.md', values), '# He said "hi" \\ bye');
  // A value that looks like a placeholder is not expanded again.
  assert.equal(S.fillPlaceholders('<APP_NAME>', '.md', { ...values, NAME: '<APP_SLUG>' }), '<APP_SLUG>');
  assert.throws(() => S.fillPlaceholders('<APP_BOGUS>', '.md', values), /unknown placeholder/);
});

test('scaffold copies the template, fills placeholders and starts git', async () => {
  const parent = parentDir();
  const r = await S.scaffold({ slug: 'recipe-box', name: 'Recipe "Box"', description: 'Save \\ share recipes', parent });
  const dir = path.join(parent, 'recipe-box');
  assert.equal(r.ok, true);
  assert.equal(r.dir, dir);
  assert.equal(r.layout, 'bottom-nav');

  // No placeholder is left anywhere, and nothing from the maker's own projects leaked in.
  for (const file of await walk(dir)) {
    if (/\.(png|jpg|ico)$/.test(file)) continue;
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('<APP_'), `placeholder left in ${file}`);
  }

  const pkg = JSON.parse(await read(dir, 'package.json'));
  assert.equal(pkg.name, 'recipe-box');
  const constants = await read(dir, 'src/lib/constants.ts');
  assert.match(constants, /SITE_SLUG = "recipe-box"/);
  assert.match(constants, /SITE_NAME = "Recipe \\"Box\\""/);
  assert.match(constants, /SITE_DESCRIPTION = "Save \\\\ share recipes"/);
  assert.match(constants, /SITE_SHORT_NAME = "Recipe \\"Box\\""/);
  assert.match(constants, /"bottom-nav" as "bottom-nav" \| "sidebar"|LAYOUT = "bottom-nav"/);
  assert.match(await read(dir, 'src/lib/supabase/cookies.ts'), /sb-recipe-box-auth/);
  const manifest = JSON.parse(await read(dir, 'public/manifest.webmanifest'));
  assert.equal(manifest.name, 'Recipe "Box"');
  assert.equal(manifest.description, 'Save \\ share recipes');
  assert.match(await read(dir, 'public/sw.js'), /recipe-box-v1/);
  assert.match(await read(dir, 'public/llms.txt'), /# Recipe "Box"/);

  // Dotfiles and folders that start with a dot came along.
  for (const f of ['.gitignore', '.cursorignore', '.env.example', '.githooks/pre-push', '.github/workflows/test.yml']) {
    assert.ok(existsSync(path.join(dir, f)), f);
  }
  assert.ok(!existsSync(path.join(dir, 'node_modules')));
  // Binary files are byte-for-byte the same as the template's.
  const a = await readFile(path.join(dir, 'public/icon-512.png'));
  const b = await readFile(path.join(root, 'template/public/icon-512.png'));
  assert.ok(a.equals(b));

  if (process.platform !== 'win32') {
    const mode = (await stat(path.join(dir, '.githooks/pre-push'))).mode;
    assert.ok(mode & 0o100, 'pre-push hook must stay executable');
  }
});

test('scaffold accepts the top-nav layout and sets LAYOUT', async () => {
  const parent = parentDir();
  const r = await S.scaffold({ slug: 'top-app', name: 'Top', description: 'd', parent, layout: 'top-nav' });
  assert.equal(r.layout, 'top-nav');
  assert.match(await read(path.join(parent, 'top-app'), 'src/lib/constants.ts'), /LAYOUT[^=]*=\s*"top-nav"/);
});

test('scaffold writes .shipyard-app.json and a private .env.local', async () => {
  const parent = parentDir();
  await S.scaffold({ slug: 'cfg-app', name: 'Cfg', description: 'd', parent, layout: 'sidebar', pwa: false, isPrivate: true });
  const dir = path.join(parent, 'cfg-app');
  const cfg = JSON.parse(await read(dir, '.shipyard-app.json'));
  assert.equal(cfg.slug, 'cfg-app');
  assert.equal(cfg.name, 'Cfg');
  assert.equal(cfg.layout, 'sidebar');
  assert.deepEqual(cfg.modules, []);
  assert.equal(cfg.private, true);
  assert.equal(cfg.pwa, false);
  assert.ok(cfg.env.includes('NEXT_PUBLIC_SUPABASE_URL') && cfg.env.includes('NEXT_PUBLIC_SITE_PRIVATE'));
  assert.ok(!cfg.env.some((n) => /RESEND|OPENROUTER|STRIPE/.test(n)), 'optional secrets are not sent by default');
  assert.match(cfg.pluginVersion, /^\d+\.\d+\.\d+/);
  assert.ok(!Number.isNaN(Date.parse(cfg.createdAt)));
  assert.match(await read(dir, 'src/lib/constants.ts'), /LAYOUT = "sidebar"/);

  const env = await read(dir, '.env.local');
  assert.match(env, /^NEXT_PUBLIC_SITE_URL=http:\/\/localhost:3000$/m);
  assert.match(env, /^NEXT_PUBLIC_SITE_PRIVATE=true$/m);
  assert.match(env, /^NEXT_PUBLIC_ENABLE_PWA=false$/m);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, '.env.local'))).mode & 0o077, 0);
});

test('scaffold takes layout, pwa and admin email from the profile', async () => {
  const p = defaultProfile();
  p.defaults.layout = 'sidebar';
  p.defaults.pwa = false;
  p.owner.email = 'owner@example.com';
  await saveProfile(p);
  try {
    const parent = parentDir();
    const r = await S.scaffold({ slug: 'prof-app', name: 'P', description: 'd', parent });
    assert.equal(r.layout, 'sidebar');
    assert.equal(r.pwa, false);
    const env = await read(parent, 'prof-app/.env.local');
    assert.match(env, /^ADMIN_EMAIL=owner@example.com$/m);
    // An explicit choice beats the profile.
    const r2 = await S.scaffold({ slug: 'prof-app2', name: 'P', description: 'd', parent, layout: 'bottom-nav', pwa: true });
    assert.equal(r2.layout, 'bottom-nav');
    assert.equal(r2.pwa, true);
  } finally {
    await saveProfile(defaultProfile());
  }
});

test('scaffold records the app in the profile as scaffolded', async () => {
  const parent = parentDir();
  await S.scaffold({ slug: 'in-profile', name: 'In Profile', description: 'd', parent });
  const app = (await loadProfile()).apps.find((a) => a.slug === 'in-profile');
  assert.equal(app.status, 'scaffolded');
  assert.equal(app.name, 'In Profile');
  assert.equal(app.dir, path.join(parent, 'in-profile'));
  assert.equal(app.layout, 'bottom-nav');
  assert.equal(app.supabaseRef, '');
});

test('scaffold sets up git: main branch, key check on every push', { skip: !haveGit }, async () => {
  const parent = parentDir();
  const r = await S.scaffold({ slug: 'git-app', name: 'Git', description: 'd', parent });
  const dir = path.join(parent, 'git-app');
  assert.equal(r.git.initialized, true);
  assert.equal(r.git.hooks, true);
  const sh = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(sh(['config', 'core.hooksPath']).stdout.trim(), '.githooks');
  assert.equal(sh(['symbolic-ref', 'HEAD']).stdout.trim(), 'refs/heads/main');
  assert.equal(sh(['rev-parse', '--verify', '--quiet', 'HEAD']).status, 1, 'nothing is committed');
  assert.equal(sh(['check-ignore', '-q', '.env.local']).status, 0, '.env.local is ignored');
});

test('scaffold still works when git is missing, with a warning', async () => {
  const fakeRun = async () => ({ code: 127, stdout: '', stderr: 'not found' });
  const parent = parentDir();
  const r = await S.scaffold({ slug: 'no-git', name: 'N', description: 'd', parent }, { run: fakeRun });
  assert.equal(r.ok, true);
  assert.equal(r.git.initialized, false);
  assert.match(r.notes.join(' '), /Git/);
});

test('scaffold refuses a non-empty target and leaves it untouched', async () => {
  const parent = parentDir();
  const target = path.join(parent, 'taken');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'mine.txt'), 'keep me');
  await assert.rejects(() => S.scaffold({ slug: 'taken', name: 'T', description: 'd', parent }), /not empty/);
  assert.equal(await read(target, 'mine.txt'), 'keep me');
  assert.deepEqual(await readdir(target), ['mine.txt']);
});

test('scaffold refuses when the target is a file', async () => {
  const parent = parentDir();
  await mkdir(parent, { recursive: true });
  await writeFile(path.join(parent, 'afile'), 'x');
  await assert.rejects(() => S.scaffold({ slug: 'afile', name: 'T', description: 'd', parent }), /file/);
});

test('scaffold accepts an existing empty folder', async () => {
  const parent = parentDir();
  await mkdir(path.join(parent, 'empty-one'), { recursive: true });
  const r = await S.scaffold({ slug: 'empty-one', name: 'E', description: 'd', parent });
  assert.equal(r.ok, true);
  assert.ok(existsSync(path.join(parent, 'empty-one', 'package.json')));
});

test('scaffold refuses a name already used by another app folder, but not a deleted one', async () => {
  const p1 = parentDir();
  await S.scaffold({ slug: 'dup-app', name: 'D', description: 'd', parent: p1 });
  await assert.rejects(() => S.scaffold({ slug: 'dup-app', name: 'D', description: 'd', parent: parentDir() }), /already have an app called/);
  await rm(path.join(p1, 'dup-app'), { recursive: true, force: true });
  const again = await S.scaffold({ slug: 'dup-app', name: 'D', description: 'd', parent: parentDir() });
  assert.equal(again.ok, true);
});

test('scaffold rejects bad input before touching the disk', async () => {
  const parent = parentDir();
  await assert.rejects(() => S.scaffold({ slug: 'Bad Name', parent }), (e) => e.data?.usage === true);
  await assert.rejects(() => S.scaffold({ slug: 'okay', layout: 'wide', parent }), (e) => /layout/.test(e.message) && e.data?.usage);
  await assert.rejects(() => S.scaffold({ slug: 'okay', name: 'x'.repeat(61), parent }), /60 characters/);
  await assert.rejects(() => S.scaffold({ slug: 'okay', description: 'x'.repeat(301), parent }), /300 characters/);
  assert.ok(!existsSync(path.join(parent, 'okay')));
});

test('scaffold refuses to build inside the template folder', async () => {
  await assert.rejects(() => S.scaffold({ slug: 'inside', name: 'I', description: 'd', parent: path.join(root, 'template') }), /outside the Shipyard plugin/);
  assert.ok(!existsSync(path.join(root, 'template', 'inside')));
});

test('scaffold cleans up when the template has an unknown placeholder', async () => {
  const fake = path.join(tmp, 'bad-template');
  await mkdir(fake, { recursive: true });
  await writeFile(path.join(fake, 'a.txt'), 'hello <APP_NAME>');
  await writeFile(path.join(fake, 'b.txt'), 'oops <APP_BOGUS>');
  const parent = parentDir();
  await assert.rejects(() => S.scaffold({ slug: 'broken', name: 'B', description: 'd', parent }, { templateDir: fake }), /unknown placeholder/);
  assert.ok(!existsSync(path.join(parent, 'broken')));
});

test('scaffold uses a made-up name and description when none are given', async () => {
  const parent = parentDir();
  const r = await S.scaffold({ slug: 'my-recipe-box', parent });
  assert.equal(r.name, 'My Recipe Box');
  assert.match(await read(parent, 'my-recipe-box/src/lib/constants.ts'), /SITE_NAME = "My Recipe Box"/);
});

function cli(args, options = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'scaffold.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'home'), NO_COLOR: '1' },
    ...options,
  });
}

test('scaffold.mjs --help prints usage and exits 0', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--layout/);
});

test('scaffold.mjs exits 2 for missing or wrong options', () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['Bad Slug']).status, 2);
  assert.equal(cli(['fine', '--bogus']).status, 2);
  assert.equal(cli(['fine', '--layout', 'wide', '--dir', parentDir()]).status, 2);
  const json = cli(['Bad Slug', '--json']);
  assert.equal(json.status, 2);
  assert.equal(JSON.parse(json.stdout).ok, false);
});

test('scaffold.mjs --json creates the app, and exits 1 when run again on the same folder', () => {
  const parent = parentDir();
  const first = cli(['cli-app', '--name', 'Cli App', '--description', 'From the command line', '--dir', parent, '--json']);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const out = JSON.parse(first.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.slug, 'cli-app');
  assert.equal(out.dir, path.join(parent, 'cli-app'));
  assert.ok(existsSync(path.join(parent, 'cli-app', '.shipyard-app.json')));

  const second = cli(['cli-app', '--dir', parent, '--json']);
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stdout).ok, false);
  assert.match(JSON.parse(second.stdout).error, /not empty|already have/);
});
