// Shared-project mode, app side: every Supabase client in the template and in the modules must use the app's
// schema (NEXT_PUBLIC_SUPABASE_SCHEMA), and a missing profile row must be created by the app (ensureProfile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOTS = [path.join(ROOT, 'template', 'src')];

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (/\.(?:ts|tsx|mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

async function sourceFiles() {
  const roots = [...SRC_ROOTS];
  for (const m of await readdir(path.join(ROOT, 'modules'), { withFileTypes: true })) {
    if (m.isDirectory()) roots.push(path.join(ROOT, 'modules', m.name, 'files', 'src'));
  }
  const out = [];
  for (const r of roots) {
    try {
      await walk(r, out);
    } catch {
      /* module without src */
    }
  }
  return out;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

/** The text of each call to a Supabase client factory, from the name to the matching closing parenthesis. */
function clientCalls(code) {
  const calls = [];
  for (const m of code.matchAll(/\b(createClient|createServerClient|createBrowserClient)\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = m.index;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) break;
    }
    calls.push({ name: m[1], text: code.slice(start, i + 1) });
  }
  return calls;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

test('every createClient / createServerClient / createBrowserClient call passes db: { schema: SUPABASE_SCHEMA }', async () => {
  const seen = new Set();
  for (const file of await sourceFiles()) {
    const code = stripComments(await readFile(file, 'utf8'));
    const calls = clientCalls(code);
    if (calls.length === 0) continue;
    seen.add(rel(file));
    for (const call of calls) {
      assert.match(call.text, /\bdb\s*:\s*\{\s*schema\s*:\s*SUPABASE_SCHEMA\s*\}/, `${rel(file)}: ${call.name}(...) does not pass the schema`);
    }
    assert.match(code, /import\s*\{\s*SUPABASE_SCHEMA\s*\}\s*from\s*["'](?:@\/lib\/supabase\/schema\.mjs|\.\/schema\.mjs)["']/, `${rel(file)}: SUPABASE_SCHEMA is not imported from the shared helper`);
  }
  // Guards against the scan finding nothing: these are the places that create clients today.
  for (const must of [
    'template/src/lib/supabase/client.ts',
    'template/src/lib/supabase/server.ts',
    'template/src/lib/admin.ts',
    'template/src/proxy.ts',
    'template/src/app/api/profile/route.ts',
  ]) {
    assert.ok(seen.has(must), `${must} should create a Supabase client and be checked`);
  }
});

test('no code hard-codes the public schema for a client', async () => {
  for (const file of await sourceFiles()) {
    const code = stripComments(await readFile(file, 'utf8'));
    assert.doesNotMatch(code, /\bschema\s*:\s*["'`]/, `${rel(file)}: schema is written as a fixed string`);
    assert.doesNotMatch(code, /\.schema\(\s*["'`]/, `${rel(file)}: .schema("...") with a fixed name`);
  }
});

test('modules reach the database through the shared admin and server helpers only', async () => {
  const allowedImports = /@\/lib\/admin|@\/lib\/supabase\/server|@\/lib\/supabase\/client/;
  let moduleFiles = 0;
  for (const file of await sourceFiles()) {
    if (!rel(file).startsWith('modules/')) continue;
    moduleFiles++;
    const code = stripComments(await readFile(file, 'utf8'));
    assert.equal(clientCalls(code).length, 0, `${rel(file)}: a module creates its own Supabase client`);
    assert.doesNotMatch(code, /\/rest\/v1\b/, `${rel(file)}: a module calls the REST API directly`);
    if (/\.from\(\s*["']/.test(code)) assert.match(code, allowedImports, `${rel(file)}: queries tables without a shared helper`);
  }
  assert.ok(moduleFiles > 20);
});

test('.env.example documents NEXT_PUBLIC_SUPABASE_SCHEMA with the public default', async () => {
  const env = await readFile(path.join(ROOT, 'template', '.env.example'), 'utf8');
  assert.match(env, /^NEXT_PUBLIC_SUPABASE_SCHEMA=public$/m);
  const lines = env.split('\n');
  const at = lines.findIndex((l) => l.startsWith('NEXT_PUBLIC_SUPABASE_SCHEMA='));
  assert.ok(lines[at - 1].startsWith('#'), 'the setting has a comment above it');
});

// ---- the schema setting ------------------------------------------------------------------------------------

const schemaUrl = pathToFileURL(path.join(ROOT, 'template/src/lib/supabase/schema.mjs')).href;
const { resolveSchema } = await import(schemaUrl);

test('resolveSchema: empty, missing or "public" mean public', () => {
  for (const v of [undefined, null, '', '   ', 'public', ' public ']) assert.equal(resolveSchema(v), 'public');
});

test('resolveSchema: valid names pass through (trimmed)', () => {
  assert.equal(resolveSchema('app_test'), 'app_test');
  assert.equal(resolveSchema('  app_my_notes2 '), 'app_my_notes2');
});

test('resolveSchema: anything else stops with a plain message instead of falling back to public', () => {
  for (const bad of ['App_Test', 'app-test', 'a', '1abc', 'app test', 'app;drop', 'app"x', 'x'.repeat(42), 'päpp']) {
    assert.throws(() => resolveSchema(bad), /NEXT_PUBLIC_SUPABASE_SCHEMA is not a valid/, bad);
  }
});

test('SUPABASE_SCHEMA is read from the environment when the module loads', async () => {
  const keep = process.env.NEXT_PUBLIC_SUPABASE_SCHEMA;
  try {
    delete process.env.NEXT_PUBLIC_SUPABASE_SCHEMA;
    assert.equal((await import(`${schemaUrl}?unset`)).SUPABASE_SCHEMA, 'public');
    process.env.NEXT_PUBLIC_SUPABASE_SCHEMA = 'app_test';
    assert.equal((await import(`${schemaUrl}?set`)).SUPABASE_SCHEMA, 'app_test');
    process.env.NEXT_PUBLIC_SUPABASE_SCHEMA = 'Bad-Name';
    await assert.rejects(() => import(`${schemaUrl}?bad`), /not a valid database schema name/);
  } finally {
    if (keep === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_SCHEMA;
    else process.env.NEXT_PUBLIC_SUPABASE_SCHEMA = keep;
  }
});

// ---- ensureProfile -----------------------------------------------------------------------------------------

const { ensureProfileWith, defaultDisplayName } = await import(pathToFileURL(path.join(ROOT, 'template/src/lib/auth/ensure-profile.mjs')).href);

/** A fake server-key client with an in-memory `profiles` table that behaves like insert ... on conflict do nothing. */
function fakeAdmin({ rows = new Map(), error = null, throws = false } = {}) {
  const calls = [];
  return {
    rows,
    calls,
    from(table) {
      return {
        async upsert(row, options) {
          calls.push({ table, row, options });
          if (throws) throw new Error('network down');
          if (error) return { error };
          if (!rows.has(row.id)) rows.set(row.id, { ...row, onboarding_complete: false, is_admin: false });
          else if (options.ignoreDuplicates !== true) rows.set(row.id, { ...rows.get(row.id), ...row });
          return { error: null };
        },
      };
    },
  };
}

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const ID2 = '4c352212-f3cc-4366-9dbf-5247d677b073';

test('ensureProfile: creates the row with an on-conflict-do-nothing upsert on profiles.id', async () => {
  const admin = fakeAdmin();
  assert.equal(await ensureProfileWith(admin, ID, { email: 'Sam.Lee@example.com' }), true);
  assert.equal(admin.calls.length, 1);
  assert.equal(admin.calls[0].table, 'profiles');
  assert.deepEqual(admin.calls[0].options, { onConflict: 'id', ignoreDuplicates: true });
  assert.deepEqual(admin.calls[0].row, { id: ID, display_name: 'Sam.Lee' });
  assert.equal(admin.rows.get(ID).is_admin, false);
  assert.equal(admin.rows.get(ID).onboarding_complete, false);
});

test('ensureProfile: idempotent, and never overwrites an existing row (name, bio, admin flag)', async () => {
  const existing = { id: ID, display_name: 'Chosen name', bio: 'hello', onboarding_complete: true, is_admin: true };
  const admin = fakeAdmin({ rows: new Map([[ID, existing]]) });
  assert.equal(await ensureProfileWith(admin, ID, { email: 'other@example.com' }), true);
  assert.equal(await ensureProfileWith(admin, ID, { email: 'other@example.com' }), true);
  assert.deepEqual(admin.rows.get(ID), existing);
  assert.equal(admin.rows.size, 1);

  const fresh = fakeAdmin();
  await ensureProfileWith(fresh, ID2, {});
  await ensureProfileWith(fresh, ID2, { email: 'changed@example.com' });
  assert.equal(fresh.rows.size, 1);
  assert.equal(fresh.rows.get(ID2).display_name, 'User');
});

test('ensureProfile: never throws, returns false on a database error or a bad id and writes nothing for a bad id', async () => {
  assert.equal(await ensureProfileWith(fakeAdmin({ error: { message: 'boom' } }), ID), false);
  assert.equal(await ensureProfileWith(fakeAdmin({ throws: true }), ID), false);
  const admin = fakeAdmin();
  for (const bad of ['', 'not-a-uuid', undefined, null, 42, `${ID}; drop table profiles`]) {
    assert.equal(await ensureProfileWith(admin, bad), false);
  }
  assert.equal(admin.calls.length, 0);
});

test('defaultDisplayName follows the sign-up trigger: full name, else email name, else User', () => {
  assert.equal(defaultDisplayName({ fullName: ' Ada Lovelace ', email: 'ada@example.com' }), 'Ada Lovelace');
  assert.equal(defaultDisplayName({ email: 'ada@example.com' }), 'ada');
  assert.equal(defaultDisplayName({ email: '@example.com' }), 'User');
  assert.equal(defaultDisplayName({}), 'User');
  assert.equal(defaultDisplayName(), 'User');
  assert.equal(defaultDisplayName({ email: 'x'.repeat(300) + '@a.b' }).length, 100);
});

test('ensureProfile is wired in where the app first needs the profile, and is allowed to use the server key', async () => {
  const read = (p) => readFile(path.join(ROOT, 'template/src', p), 'utf8');
  const wrapper = await read('lib/auth/ensure-profile.ts');
  assert.match(wrapper, /^import "server-only";/);
  assert.match(wrapper, /createSupabaseAdmin\(\)/);
  for (const p of ['app/api/profile/route.ts', 'app/profile/edit/page.tsx', 'lib/auth/server-signup.ts']) {
    assert.match(await read(p), /ensureProfile\(/, `${p} should call ensureProfile`);
  }
  const { isAllowedForServerKey } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/server-key.mjs')).href);
  assert.equal(isAllowedForServerKey('lib/auth/ensure-profile.ts'), true);
  // the files that call it must not need the server key themselves
  for (const p of ['app/api/profile/route.ts', 'app/profile/edit/page.tsx']) {
    assert.doesNotMatch(await read(p), /@\/lib\/admin\b|SUPABASE_SERVICE_ROLE_KEY|createSupabaseAdmin/, `${p} must not use the server key directly`);
  }
});

test('the template tells the coding agent about schemas and the auth trigger rule', async () => {
  const agents = await readFile(path.join(ROOT, 'template/AGENTS.md'), 'utf8');
  assert.match(agents, /NEXT_PUBLIC_SUPABASE_SCHEMA/);
  assert.match(agents, /shipyard:auth-trigger/);
  assert.match(agents, /schema in front/);
});
