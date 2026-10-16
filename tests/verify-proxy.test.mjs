import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { check } from '../scripts/verify/proxy.mjs';
import { tempDir, removeDir, makeAppFromTemplate } from './verify-helpers.mjs';

async function app(t, opts) {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await makeAppFromTemplate(dir, opts);
  return dir;
}
const edit = async (dir, rel, fn) => {
  const p = path.join(dir, rel);
  await writeFile(p, fn(await readFile(p, 'utf8')));
};
const run = (dir) => check({ appDir: dir, url: null, app: null, secrets: new Map() });

test('the real template (placeholders filled in) passes', async (t) => {
  const dir = await app(t);
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /sign-up|signup/);
  assert.match(r.details.join('\n'), /sb-fake-planner-auth/);
});

test('fails when proxy.ts is missing', async (t) => {
  const dir = await app(t);
  await rm(path.join(dir, 'src/proxy.ts'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /proxy\.ts is missing/);
});

test('fails when the old middleware.ts exists too', async (t) => {
  const dir = await app(t);
  await writeFile(path.join(dir, 'src/middleware.ts'), 'export function middleware() {}\n');
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /middleware\.ts still exists/);
});

test('fails when proxy is not exported', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/proxy.ts', (s) => s.replace('export async function proxy', 'async function proxy'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /does not export a function called proxy/);
});

test('accepts export const proxy', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/proxy.ts', (s) => s.replace('export async function proxy(req: NextRequest) {', 'export const proxy = async (req: NextRequest) => {').replace(/\n}\n\nexport const config/, '\n};\n\nexport const config'));
  assert.equal((await run(dir)).ok, true);
});

test('a public auth route missing from PUBLIC_PREFIXES is reported by name', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/proxy.ts', (s) => s.replace('  "/api/auth/forgot-password",\n', ''));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\/api\/auth\/forgot-password is not in PUBLIC_PREFIXES/);
  assert.doesNotMatch(r.problems.join('\n'), /\/api\/auth\/signup is not/);
});

test('a new auth route folder must be public too, including nested ones and (groups)', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, 'src/app/api/auth/(group)/magic/link'), { recursive: true });
  await writeFile(path.join(dir, 'src/app/api/auth/(group)/magic/link/route.ts'), 'export {};\n');
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\/api\/auth\/magic\/link is not in PUBLIC_PREFIXES/);
  await edit(dir, 'src/proxy.ts', (s) => s.replace('  "/api/auth/signup",', '  "/api/auth/signup",\n  "/api/auth/magic",'));
  assert.equal((await run(dir)).ok, true);
});

test('a prefix covering the whole api/auth folder is enough', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/proxy.ts', (s) => s.replace('  "/api/auth/signup",\n  "/api/auth/forgot-password",\n', '  "/api/auth",\n'));
  assert.equal((await run(dir)).ok, true);
});

test('comments in proxy.ts do not count as prefixes', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/proxy.ts', (s) => s.replace('  "/api/auth/forgot-password",\n', '  // "/api/auth/forgot-password",\n'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /forgot-password is not in PUBLIC_PREFIXES/);
});

test('a missing PUBLIC_PREFIXES list fails', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/proxy.ts', (s) => s.replaceAll('PUBLIC_PREFIXES', 'OPEN_PAGES'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /no PUBLIC_PREFIXES list/);
});

test('cookie name must match the app slug', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/lib/supabase/cookies.ts', (s) => s.replace('sb-fake-planner-auth', 'sb-other-app-auth'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /should be "sb-fake-planner-auth"/);
});

test('an unreplaced placeholder in the cookie name fails', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/lib/supabase/cookies.ts', (s) => s.replace('sb-fake-planner-auth', 'sb-<APP_SLUG>-auth'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /placeholder/);
});

test('a cookie domain fails (it would share logins across apps)', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/lib/supabase/cookies.ts', (s) => s.replace('  path: "/",', '  path: "/",\n  domain: ".example.com",'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /cookie domain/);
});

test('a Supabase client without authCookieOptions fails', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/lib/supabase/server.ts', (s) => s.replaceAll('authCookieOptions', 'somethingElse'));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /server\.ts creates a Supabase client without authCookieOptions/);
});

test('proxy.ts using its own different cookie name fails', async (t) => {
  const dir = await app(t);
  await edit(dir, 'src/proxy.ts', (s) => `${s}\nconst ALT = "sb-different-auth";\n`);
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /its own cookie name "sb-different-auth"/);
});

test('works for apps without a src folder', async (t) => {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await mkdir(path.join(dir, 'lib/supabase'), { recursive: true });
  await writeFile(path.join(dir, 'proxy.ts'), 'const PUBLIC_PREFIXES = ["/api/auth"];\nexport function proxy() {}\n');
  await writeFile(path.join(dir, 'lib/supabase/cookies.ts'), 'export const AUTH_COOKIE_NAME = "sb-x-auth";\n');
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
});
