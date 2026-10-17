// make-owner: makes the owner account, switches on the admin flag, opens a one-time sign-in link.
// Uses a tiny fake Supabase on a local port. No network, no real keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-owner-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = await import('../scripts/lib/log.mjs');
log.setQuiet(true);
const { makeOwner } = await import('../scripts/provision/owner-core.mjs');
const { scaffold } = await import('../scripts/provision/scaffold-core.mjs');
const { updateEnvFile } = await import('../scripts/provision/envfile.mjs');

const SERVER = 'test-server-key-bbbbbbbbbbbb';
const ANON = 'test-anon-key-aaaaaaaaaaaa';
const OWNER = 'owner@example.com';

async function fakeSupabase({ users = [], noProfile = false, failCreate = false } = {}) {
  const state = { users: new Map(users.map((u) => [u.id, u])), profiles: new Map(), requests: [], passwords: [] };
  for (const u of state.users.values()) if (!noProfile) state.profiles.set(u.id, { id: u.id, is_admin: false });
  const body = (req) => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : null); } catch { resolve(null); } });
  });
  const send = (res, status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    state.requests.push(`${req.method} ${u.pathname}`);
    if (req.headers.apikey !== SERVER) return send(res, 401, { msg: 'invalid key' });
    const b = await body(req);
    if (u.pathname === '/rest/v1/rpc/auth_user_id_by_email') {
      const found = [...state.users.values()].find((x) => x.email === String(b.email).toLowerCase());
      return send(res, 200, found ? found.id : null);
    }
    if (u.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
      if (failCreate) return send(res, 422, { msg: 'nope' });
      const id = randomUUID();
      state.users.set(id, { id, email: b.email, password: b.password });
      state.passwords.push(b.password);
      if (!noProfile) state.profiles.set(id, { id, is_admin: false });
      return send(res, 200, { id, email: b.email });
    }
    const put = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(u.pathname);
    if (put && req.method === 'PUT') {
      state.users.get(put[1]).password = b.password;
      state.passwords.push(b.password);
      return send(res, 200, {});
    }
    if (u.pathname === '/auth/v1/admin/generate_link') return send(res, 200, { hashed_token: 'hashed-token-abc123', properties: {} });
    if (u.pathname === '/rest/v1/profiles') {
      const id = /^eq\.(.+)$/.exec(u.searchParams.get('id') ?? '')?.[1];
      if (req.method === 'PATCH') {
        const row = state.profiles.get(id);
        if (!row) return send(res, 200, []);
        Object.assign(row, b);
        return send(res, 200, [row]);
      }
      if (req.method === 'POST') {
        state.profiles.set(b.id, { ...b });
        return send(res, 201, [b]);
      }
    }
    return send(res, 404, { msg: 'no route' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

let n = 0;
async function makeApp(fake, { admin = OWNER } = {}) {
  const slug = `own-app-${++n}`;
  const parent = path.join(tmp, `p${n}`);
  await scaffold({ slug, name: slug, description: 'd', parent });
  const dir = path.join(parent, slug);
  await updateEnvFile(path.join(dir, '.env.local'), {
    NEXT_PUBLIC_SUPABASE_URL: fake.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON,
    SUPABASE_SERVICE_ROLE_KEY: SERVER,
    ...(admin ? { ADMIN_EMAIL: admin } : {}),
  });
  return dir;
}
const opener = () => {
  const opened = [];
  return { opened, fn: async (url) => { opened.push(url); return true; } };
};

after(() => rm(tmp, { recursive: true, force: true }));

test('makes the owner account, switches on admin, and opens a one-time sign-in link without ever returning it', async () => {
  const fake = await fakeSupabase();
  try {
    const dir = await makeApp(fake);
    const o = opener();
    const result = await makeOwner({ appDir: dir, opener: o.fn });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.admin, true);
    assert.equal(result.email, OWNER);
    assert.equal(result.signInLink, 'opened');
    assert.equal(fake.state.users.size, 1);
    assert.equal(fake.state.profiles.get(result.userId).is_admin, true);
    // The account has a random password nobody sees.
    assert.equal(fake.state.passwords.length, 1);
    assert.ok(fake.state.passwords[0].length >= 20);
    // The link goes to the app's confirm route on the local address, and is only handed to the browser opener.
    assert.equal(o.opened.length, 1);
    assert.equal(o.opened[0], 'http://localhost:3000/auth/confirm?token_hash=hashed-token-abc123&type=magiclink&next=%2F');
    const printed = JSON.stringify(result);
    for (const secret of ['hashed-token-abc123', SERVER, ANON, fake.state.passwords[0]]) assert.ok(!printed.includes(secret), 'a secret is in the result');
  } finally {
    await fake.close();
  }
});

test('an existing account is reused, not duplicated, and its password is left alone unless asked', async () => {
  const id = randomUUID();
  const fake = await fakeSupabase({ users: [{ id, email: OWNER, password: 'their-own-password' }] });
  try {
    const dir = await makeApp(fake);
    const result = await makeOwner({ appDir: dir, opener: opener().fn });
    assert.equal(result.created, false);
    assert.equal(result.userId, id);
    assert.equal(fake.state.users.size, 1);
    assert.equal(fake.state.users.get(id).password, 'their-own-password');
    assert.equal(fake.state.profiles.get(id).is_admin, true);

    const reset = await makeOwner({ appDir: dir, resetPassword: true, opener: opener().fn });
    assert.equal(reset.passwordReset, true);
    assert.notEqual(fake.state.users.get(id).password, 'their-own-password');
  } finally {
    await fake.close();
  }
});

test('--email overrides ADMIN_EMAIL, case does not matter, and a missing profile row is created', async () => {
  const fake = await fakeSupabase({ noProfile: true });
  try {
    const dir = await makeApp(fake, { admin: '' });
    await assert.rejects(() => makeOwner({ appDir: dir, opener: opener().fn }), /no owner email/i);
    const result = await makeOwner({ appDir: dir, email: 'Me@Example.COM', opener: opener().fn });
    assert.equal(result.email, 'me@example.com');
    assert.equal(fake.state.profiles.get(result.userId).is_admin, true);
  } finally {
    await fake.close();
  }
});

test('--no-open makes the account and admin flag but no sign-in link', async () => {
  const fake = await fakeSupabase();
  try {
    const dir = await makeApp(fake);
    const o = opener();
    const result = await makeOwner({ appDir: dir, open: false, opener: o.fn });
    assert.equal(result.signInLink, 'skipped');
    assert.equal(o.opened.length, 0);
    assert.ok(!fake.state.requests.some((r) => r.includes('generate_link')));
  } finally {
    await fake.close();
  }
});

test('--url decides where the sign-in link points', async () => {
  const fake = await fakeSupabase();
  try {
    const dir = await makeApp(fake);
    const o = opener();
    await makeOwner({ appDir: dir, url: 'https://my-app.vercel.app/some/path', opener: o.fn });
    assert.ok(o.opened[0].startsWith('https://my-app.vercel.app/auth/confirm?token_hash='));
  } finally {
    await fake.close();
  }
});

test('problems are explained in plain words and never include a key', async () => {
  const fake = await fakeSupabase({ failCreate: true });
  try {
    const dir = await makeApp(fake);
    await assert.rejects(() => makeOwner({ appDir: dir, opener: opener().fn }), (e) => /Could not create the owner account/.test(e.message) && !e.message.includes(SERVER));
    await assert.rejects(() => makeOwner({ appDir: dir, email: 'not-an-email', opener: opener().fn }), /does not look like an email/);
    const bare = await makeApp(fake);
    await writeFile(path.join(bare, '.env.local'), 'ADMIN_EMAIL=owner@example.com\n');
    await assert.rejects(() => makeOwner({ appDir: bare, opener: opener().fn }), /Cannot reach this app's database/);
  } finally {
    await fake.close();
  }
});

test('make-owner.mjs: --help exits 0, a missing folder exits 2', () => {
  const script = path.join(root, 'scripts', 'make-owner.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'h2') } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /owner account/);
  const none = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, SHIPYARD_HOME: path.join(tmp, 'h2') } });
  assert.equal(none.status, 2);
});

// ---- the template side: no admin by email, no sign-up with the owner's email --------------------

const template = async (rel) => readFile(path.join(root, 'template', rel), 'utf8');

test('template: isAdminUser never looks at an email address', async () => {
  const admin = await template('src/lib/admin.ts');
  const fn = admin.slice(admin.indexOf('export async function isAdminUser'), admin.indexOf('export async function requireAdmin'));
  assert.match(fn, /is_admin/);
  assert.ok(!/ADMIN_EMAIL|user\.email|\.email\b/.test(fn), 'isAdminUser must not trust an email address');
});

test('template: sign-up refuses the owner email, and all email sign-ups while Google sign-in is on', async () => {
  const signup = await template('src/lib/auth/server-signup.ts');
  assert.match(signup, /process\.env\.ADMIN_EMAIL/);
  assert.match(signup, /status: 403/);
  assert.match(signup, /Sign in with the account Shipyard created/);
  assert.match(signup, /GOOGLE_SIGNIN_ENABLED/);
  // The refusals come before any account is created.
  assert.ok(signup.indexOf('ADMIN_EMAIL') < signup.indexOf('createUser'));
  assert.ok(signup.indexOf('if (GOOGLE_SIGNIN_ENABLED)') < signup.indexOf('createUser'));
  const route = await template('src/app/api/auth/signup/route.ts');
  assert.match(route, /result\.status/);
});

test('template: the rules about unverified emails are written down for the coding agent', async () => {
  const agents = await template('AGENTS.md');
  assert.match(agents, /Admin is `profiles\.is_admin` and nothing else/);
  assert.match(agents, /Starter-mode emails are not verified/);
  assert.match(agents, /NEXT_PUBLIC_GOOGLE_SIGNIN_ENABLED=true/);
});

test('--reset-password is refused in a shared Supabase project (it would change the password for the other apps)', async () => {
  const fake = await fakeSupabase({ users: [{ id: randomUUID(), email: OWNER, password: 'theirs' }] });
  try {
    const dir = await makeApp(fake);
    const { updateAppConfig } = await import('../scripts/provision/common.mjs');
    await updateAppConfig(dir, { shared: true, schema: 'app_notes' });
    await assert.rejects(() => makeOwner({ appDir: dir, resetPassword: true, open: false }), /shares its Supabase project/);
    assert.equal(fake.state.requests.length, 0, 'nothing was asked of Supabase');
    // Without the reset the existing account is simply reused (the schema setting is in place).
    await updateEnvFile(path.join(dir, '.env.local'), { NEXT_PUBLIC_SUPABASE_SCHEMA: 'app_notes' });
    const result = await makeOwner({ appDir: dir, open: false });
    assert.equal(result.created, false);
    assert.equal(result.passwordReset, false);
  } finally {
    await fake.close();
  }
});

test('a shared app without its schema in .env.local is refused before any call (it would make the owner an admin in another app\'s public table)', async () => {
  const fake = await fakeSupabase({ users: [{ id: randomUUID(), email: OWNER, password: 'theirs' }] });
  try {
    const dir = await makeApp(fake);
    const { updateAppConfig } = await import('../scripts/provision/common.mjs');
    await updateAppConfig(dir, { shared: true, schema: 'app_notes' });
    // 1. The setting is missing (it would default to public).
    await assert.rejects(() => makeOwner({ appDir: dir, open: false }), (e) => /NEXT_PUBLIC_SUPABASE_SCHEMA in \.env\.local must be app_notes/.test(e.message) && /Run provision-supabase\.mjs again/.test(e.message));
    // 2. The setting names another schema.
    await updateEnvFile(path.join(dir, '.env.local'), { NEXT_PUBLIC_SUPABASE_SCHEMA: 'app_other' });
    await assert.rejects(() => makeOwner({ appDir: dir, open: false }), /must be app_notes/);
    // 3. The setting says public.
    await updateEnvFile(path.join(dir, '.env.local'), { NEXT_PUBLIC_SUPABASE_SCHEMA: 'public' });
    await assert.rejects(() => makeOwner({ appDir: dir, open: false }), /must be app_notes/);
    assert.equal(fake.state.requests.length, 0, 'nothing was asked of Supabase, in particular nothing was written to profiles');
    // An app of its own (not shared) is not affected.
    const own = await makeApp(fake);
    await makeOwner({ appDir: own, open: false });
  } finally {
    await fake.close();
  }
});
