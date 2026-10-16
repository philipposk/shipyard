import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { check } from '../scripts/verify/secrets.mjs';
import { tempDir, removeDir, makeAppFromTemplate } from './verify-helpers.mjs';

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

/** A git repo holding the template's secret-scan script and .gitignore, with everything committed-ready (added, not committed). */
async function repo(t) {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await makeAppFromTemplate(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.hooksPath', '.githooks');
  git(dir, 'add', '-A');
  return dir;
}
const run = (dir) => check({ appDir: dir, url: null, app: null, secrets: new Map() });

test('a clean repo passes', async (t) => {
  const dir = await repo(t);
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /\.env\.local is ignored by git/);
  assert.deepEqual(r.warnings, []);
});

test('a key in a tracked file fails and the key itself is never printed', async (t) => {
  const dir = await repo(t);
  const fakeKey = `${'sk_live_'}${'Ab1'.repeat(10)}`;
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'pay.ts'), `const k = "${fakeKey}";\n`);
  git(dir, 'add', '-A');
  const r = await run(dir);
  assert.equal(r.ok, false);
  const text = JSON.stringify(r);
  assert.match(r.problems.join('\n'), /src\/pay\.ts:1 looks like a Stripe secret key/);
  assert.ok(!text.includes(fakeKey));
});

test('a tracked .env.local fails with the fix', async (t) => {
  const dir = await repo(t);
  await writeFile(path.join(dir, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\n');
  git(dir, 'add', '-f', '.env.local');
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\.env\.local is tracked by git.*git rm --cached \.env\.local/);
  // reported once, not twice (the scanner also notices it)
  assert.equal(r.problems.filter((p) => p.includes('.env.local is tracked')).length, 1);
});

test('.env.example is allowed to be tracked', async (t) => {
  const dir = await repo(t);
  await writeFile(path.join(dir, '.env.example'), 'NEXT_PUBLIC_SUPABASE_URL=\n');
  git(dir, 'add', '-A');
  assert.equal((await run(dir)).ok, true);
});

test('a missing .gitignore entry for .env.local fails', async (t) => {
  const dir = await repo(t);
  await writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  git(dir, 'add', '-A');
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\.env\.local is not in \.gitignore/);
});

test('a missing scan script fails', async (t) => {
  const dir = await repo(t);
  await writeFile(path.join(dir, 'scripts', 'secret-scan.mjs'), '');
  const { rm } = await import('node:fs/promises');
  await rm(path.join(dir, 'scripts', 'secret-scan.mjs'));
  git(dir, 'add', '-A');
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /secret-scan\.mjs is missing/);
});

test('not a git repository fails with a plain message', async (t) => {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  // tmp dirs are not inside a repo; if the machine's tmp is, this test cannot apply
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' });
    return;
  } catch {
    // not a repo, good
  }
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /not a git repository/);
});

test('hooks not switched on is a warning, not a failure', async (t) => {
  const dir = await repo(t);
  git(dir, 'config', '--unset', 'core.hooksPath');
  const r = await run(dir);
  assert.equal(r.ok, true);
  assert.match(r.warnings.join('\n'), /core\.hooksPath \.githooks/);
});

// ---------- the secret server key may only be used in a few files ----------

test('server key: the template as shipped passes', async (t) => {
  const dir = await repo(t);
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /secret server key is used only in the files allowed/);
});

for (const [label, file, code] of [
  ['an API route that imports the admin client', 'src/app/api/notes/route.ts', 'import { createSupabaseAdmin } from "@/lib/admin";\nexport async function GET() { return Response.json((await createSupabaseAdmin().from("notes").select("*")).data); }\n'],
  ['a server action that reads the key directly', 'src/app/actions.ts', '"use server";\nconst key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n'],
  ['a page that imports it with a relative path', 'src/app/items/page.tsx', 'import { createSupabaseAdmin } from "../../lib/admin";\nexport default function P() { return null; }\n'],
]) {
  test(`server key: fails for ${label}`, async (t) => {
    const dir = await repo(t);
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), code);
    git(dir, 'add', '-A');
    const r = await run(dir);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), new RegExp(`${file.replace(/[/.]/g, '\\$&')} uses the secret server key`));
    assert.match(r.problems.join('\n'), /createSupabaseServer/);
  });
}

test('server key: the allowed files, comments and look-alike names are fine', async (t) => {
  const dir = await repo(t);
  await mkdir(path.join(dir, 'src', 'lib', 'auth'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'app', 'api', 'auth', 'signup'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'lib', 'admin.ts'), 'export const x = process.env.SUPABASE_SERVICE_ROLE_KEY;\n');
  await writeFile(path.join(dir, 'src', 'lib', 'auth', 'server-signup.ts'), 'import { createSupabaseAdmin } from "@/lib/admin";\n');
  await writeFile(path.join(dir, 'src', 'app', 'api', 'auth', 'signup', 'route.ts'), 'import { createSupabaseAdmin } from "@/lib/admin";\n');
  await writeFile(path.join(dir, 'src', 'app', 'page.tsx'), '// never use SUPABASE_SERVICE_ROLE_KEY here\nexport default function P() { return null; }\n');
  await writeFile(path.join(dir, 'src', 'lib', 'admin-panel.ts'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
});
