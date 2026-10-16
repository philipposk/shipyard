import { test } from 'node:test';
import { privateWordsRegex } from './private-words.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TEMPLATE, tempDir, removeDir, copyTemplateDir } from './verify-helpers.mjs';
import { check as proxyCheck } from '../scripts/verify/proxy.mjs';
import { findServerKeyMisuse } from '../scripts/verify/server-key.mjs';

// The launch additions to the template: signup modes, account deletion, legal pages, Health page, module hooks.
// Behaviour of the pure logic is tested by the template's own tests (template/tests, run at the end of this file);
// here: the wiring, the contract other Shipyard parts rely on, and an end-to-end patch by the real add-module patcher.

const read = (rel) => readFile(path.join(TEMPLATE, ...rel.split('/')), 'utf8');
const exists = (rel) => stat(path.join(TEMPLATE, ...rel.split('/'))).then(() => true, () => false);

async function filled(t) {
  const dir = await tempDir('shipyard-launch-template-');
  t.after(() => removeDir(dir));
  await copyTemplateDir(dir);
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(?:ts|tsx|mjs|json|md|css|webmanifest)$/.test(e.name)) {
        const text = await readFile(p, 'utf8');
        if (text.includes('<APP_')) {
          await writeFile(p, text.replaceAll('<APP_SLUG>', 'fake-planner').replaceAll('<APP_NAME>', 'Fake Planner').replaceAll('<APP_SHORT_NAME>', 'Planner')
            .replaceAll('<APP_DESCRIPTION>', 'A planner').replaceAll('<APP_TAGLINE>', 'A planner').replaceAll('<APP_LAYOUT>', 'bottom-nav'));
        }
      }
    }
  };
  await walk(dir);
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug: 'fake-planner', name: 'Fake Planner', layout: 'bottom-nav', modules: [] }));
  return dir;
}

test('every new file the launch skill and the modules rely on exists', async () => {
  for (const rel of [
    'src/lib/auth/signup-mode.mjs', 'src/lib/rate-limit.mjs', 'src/lib/same-origin.mjs',
    'src/app/api/auth/resend-confirmation/route.ts', 'src/app/api/account/delete/route.ts', 'src/lib/auth/delete-account.ts',
    'src/lib/account/pre-delete.ts', 'src/lib/account/run-hooks.mjs', 'src/components/DeleteAccountSection.tsx',
    'src/lib/legal-content.ts', 'src/lib/legal-types.ts', 'src/lib/legal-helpers.mjs', 'src/components/LegalDocument.tsx',
    'src/app/admin/health/page.tsx', 'src/lib/health/checks.ts', 'src/lib/health/run.mjs', 'src/lib/health/template-checks.mjs',
  ]) assert.ok(await exists(rel), rel);
});

test('signup modes: starter is the default, verified goes through Supabase signUp with the confirm address', async () => {
  const constants = await read('src/lib/constants.ts');
  assert.match(constants, /export const SIGNUP_MODE: "starter" \| "verified" = parseSignupMode\(process\.env\.NEXT_PUBLIC_SIGNUP_MODE\)/);
  assert.match(constants, /export const CONTACT_EMAIL = \(process\.env\.NEXT_PUBLIC_CONTACT_EMAIL/);
  const signup = await read('src/lib/auth/server-signup.ts');
  assert.match(signup, /auth\.signUp\(/);
  assert.match(signup, /emailRedirectTo: confirmRedirectUrl\(SITE_URL\)/);
  assert.match(signup, /isHiddenExistingUser/);
  assert.match(signup, /email_confirm: true/, 'starter mode keeps confirming on the server');
  // The refusals still come before any account is made, in both modes; Google only blocks starter mode.
  assert.ok(signup.indexOf('process.env.ADMIN_EMAIL') < signup.indexOf('Signup(trimmed'));
  assert.match(signup, /SIGNUP_MODE === "starter" && GOOGLE_SIGNIN_ENABLED/);
  assert.match(signup, /status: 409/);
  const route = await read('src/app/api/auth/signup/route.ts');
  assert.match(route, /needsConfirmation/);
});

test('verified sign-up: resend route is rate limited, same answer for every email, public in the proxy, never uses the server key', async () => {
  const route = await read('src/app/api/auth/resend-confirmation/route.ts');
  assert.match(route, /SIGNUP_MODE !== "verified"/);
  assert.match(route, /createLimiter/);
  assert.match(route, /cooldownMs: 60 \* 1000/);
  assert.match(route, /status: 429/);
  assert.match(route, /after\(\(\) => resend\(email\)\)/, 'the send happens after the answer, so timing does not leak');
  assert.match(route, /auth\.resend\(\{[\s\S]*type: "signup"/);
  assert.ok(!/createSupabaseAdmin|SERVICE_ROLE/.test(route));
  assert.match(await read('src/proxy.ts'), /"\/api\/auth\/resend-confirmation"/);
  const confirm = await read('src/app/auth/confirm/route.ts');
  assert.match(confirm, /exchangeCodeForSession/);
  assert.match(confirm, /confirm_failed/);
  const page = await read('src/app/sign-in/page.tsx');
  assert.match(page, /Check your email/);
  assert.match(page, /isEmailNotConfirmed/);
  assert.match(page, /\/api\/auth\/resend-confirmation/);
});

test('account deletion: login + same site + typed DELETE, hooks before the delete, last admin protected, cookies cleared', async () => {
  const route = await read('src/app/api/account/delete/route.ts');
  assert.ok(route.indexOf('isSameOrigin(') < route.indexOf('auth.getUser()'), 'origin checked first');
  assert.ok(route.indexOf('auth.getUser()') < route.indexOf('isDeleteConfirmation('));
  assert.ok(route.indexOf('isDeleteConfirmation(') < route.indexOf('deleteAccount('));
  assert.match(route, /status: 401/);
  assert.match(route, /status: 403/);
  assert.ok(!/body\??\.(?:userId|user_id|id)\b/.test(route), 'the person to delete is never taken from the request');
  assert.match(route, /deleteAccount\(user\)/);
  assert.match(route, /AUTH_COOKIE_NAME/);
  const lib = await read('src/lib/auth/delete-account.ts');
  assert.ok(lib.indexOf('runPreDeleteHooks(') < lib.indexOf('auth.admin.deleteUser('), 'hooks run before the user is deleted');
  assert.match(lib, /is_admin/);
  assert.match(lib, /if \(!hooks\.ok\)[\s\S]*?return/);
  const hooks = await read('src/lib/account/pre-delete.ts');
  assert.match(hooks, /export const PRE_DELETE_HOOKS: PreDeleteHook\[\] = \[/);
  const settings = await read('src/app/settings/page.tsx');
  assert.match(settings, /<DeleteAccountSection \/>/);
  assert.match(settings, /shipyard:settings-sections:start/);
  assert.match(settings, /shipyard:settings-sections:end/);
  const modal = await read('src/components/ConfirmModal.tsx');
  assert.match(modal, /requireText/);
  const section = await read('src/components/DeleteAccountSection.tsx');
  assert.match(section, /requireText="DELETE"/);
  assert.match(section, /\/api\/account\/delete/);
});

test('legal pages render legal-content.ts through LegalDocument; the content file has the agreed exports', async () => {
  for (const [page, key] of [['privacy', 'privacy'], ['terms', 'terms']]) {
    const src = await read(`src/app/${page}/page.tsx`);
    assert.match(src, /<LegalDocument/);
    assert.match(src, new RegExp(`import \\{ controller, ${key}, updatedAt \\} from "@/lib/legal-content"`));
  }
  const content = await read('src/lib/legal-content.ts');
  for (const name of ['updatedAt', 'controller', 'privacy', 'terms']) assert.match(content, new RegExp(`^export const ${name}\\b`, 'm'), name);
  const types = await read('src/lib/legal-types.ts');
  assert.match(types, /export interface LegalSection \{[\s\S]*id: string;[\s\S]*title: string;[\s\S]*paragraphs: string\[\];[\s\S]*table\?: \{ headers: string\[\]; rows: string\[\]\[\] \};/);
  assert.match(types, /export interface LegalController \{\s*name: string;\s*address: string;\s*email: string;\s*country: string;/);
  const doc = await read('src/components/LegalDocument.tsx');
  assert.match(doc, /legal-table/);
  assert.match(doc, /aria-label="On this page"/);
  assert.match(await read('src/app/globals.css'), /\.legal-table \{ overflow-x: auto;/);
});

test('Health page: admin only (404 otherwise), noindex, fresh on every visit, link only for admins, hidden from robots', async () => {
  const page = await read('src/app/admin/health/page.tsx');
  assert.match(page, /if \(!user \|\| !\(await getIsAdmin\(\)\)\) notFound\(\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /dynamic = "force-dynamic"/);
  assert.match(page, /timeoutMs: 5000/);
  assert.ok(page.indexOf('notFound()') < page.indexOf('runChecks('), 'nothing runs for non-admins');
  const session = await read('src/lib/session.ts');
  assert.match(session, /export const getIsAdmin/);
  assert.ok(!/@\/lib\/admin/.test(session), 'admin check uses the person\'s own client, not the server key');
  assert.match(await read('src/lib/nav.ts'), /ADMIN_LINKS[\s\S]*href: "\/admin\/health"/);
  for (const f of ['MobileMenu', 'SidebarShell', 'TopNavShell']) assert.match(await read(`src/components/${f}.tsx`), /isAdmin/, f);
  assert.match(await read('src/components/AppShell.tsx'), /isAdmin \?\? \(signedIn && nav \? await getIsAdmin\(\) : false\)/);
  assert.match(await read('src/app/design-preview/[id]/page.tsx'), /<AppShell signedIn isAdmin=\{false\}/, 'the preview needs no database');
  assert.match(await read('src/app/robots.ts'), /"\/admin"/);
  const checks = await read('src/lib/health/checks.ts');
  assert.match(checks, /export const HEALTH_CHECKS: HealthCheck\[\] = \[/);
  assert.ok(!/@\/lib\/admin|SERVICE_ROLE/.test(checks + (await read('src/lib/health/template-checks.mjs'))), 'checks never touch the server key');
});

test('.env.example and AGENTS.md carry the new settings and rules (and the old rules stay)', async () => {
  const env = await read('.env.example');
  assert.match(env, /^NEXT_PUBLIC_SIGNUP_MODE=starter$/m);
  assert.match(env, /^NEXT_PUBLIC_CONTACT_EMAIL=$/m);
  const agents = await read('AGENTS.md');
  for (const re of [/NEXT_PUBLIC_SIGNUP_MODE/, /`starter`/, /`verified`/, /Account deletion/, /PRE_DELETE_HOOKS/, /legal-generate/, /legal-content\.ts/, /\/admin\/health/, /HEALTH_CHECKS/, /NEXT_PUBLIC_CONTACT_EMAIL/, /on delete cascade/, /Starter-mode emails are not verified/]) {
    assert.match(agents, re, String(re));
  }
});

test('the whole template (placeholders filled in): sign-in gate covers every auth route, no file misuses the server key', async (t) => {
  const dir = await filled(t);
  const r = await proxyCheck({ appDir: dir, url: null, app: null, secrets: new Map() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /resend-confirmation/);
  const misuse = await findServerKeyMisuse(dir);
  assert.deepEqual(misuse.files, []);
});

test('the template passes its own design check', async (t) => {
  const dir = await filled(t);
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'design-check.mjs'), '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('add-module can patch the hook lists, the admin links and the settings page (real patcher, if present)', async (t) => {
  const patchFile = path.join(TEMPLATE, '..', 'scripts', 'modules', 'patch.mjs');
  if (!(await stat(patchFile).then(() => true, () => false))) return t.skip('modules owner has not shipped patch.mjs');
  const { addImports, addToArray, insertAtAnchor } = await import(pathToFileURL(patchFile).href);

  let hooks = addImports(await read('src/lib/account/pre-delete.ts'), ['import { billingPreDelete } from "@/lib/billing/hooks";']).text;
  const h = addToArray(hooks, { name: 'PRE_DELETE_HOOKS', entry: 'billingPreDelete' });
  assert.equal(h.ok, true);
  assert.match(h.text, /export const PRE_DELETE_HOOKS: PreDeleteHook\[\] = \[\n\s+billingPreDelete,\n\];/);
  assert.equal(addToArray(h.text, { name: 'PRE_DELETE_HOOKS', entry: 'billingPreDelete' }).already, true, 'adding twice is a no-op');

  const c = addToArray(addImports(await read('src/lib/health/checks.ts'), ['import { billingHealth } from "@/lib/billing/health";']).text, { name: 'HEALTH_CHECKS', entry: 'billingHealth' });
  assert.equal(c.ok, true);
  assert.match(c.text, /queryDatabase,\n\s+\}\),\n\s+billingHealth,\n\];/);

  const n = addToArray(await read('src/lib/nav.ts'), { name: 'ADMIN_LINKS', entry: '{ href: "/admin/newsletter", label: "Newsletter" }' });
  assert.equal(n.ok, true);
  assert.match(n.text, /href: "\/admin\/health", label: "Health" \},\n\s+\{ href: "\/admin\/newsletter"/);

  const s = insertAtAnchor(await read('src/app/settings/page.tsx'), { anchor: 'shipyard:settings-sections:end', position: 'before', insert: '<BillingSection />' });
  assert.equal(s.ok, true);
  assert.ok(s.text.indexOf('<BillingSection />') > s.text.indexOf('settings-sections:start'));
  assert.ok(s.text.indexOf('<BillingSection />') < s.text.indexOf('settings-sections:end'));
  assert.ok(s.text.indexOf('<BillingSection />') < s.text.indexOf('<DeleteAccountSection />'), 'module sections come before the delete card');
});

test('nothing private in the files this part ships', async (t) => {
  const bad = privateWordsRegex();
  if (!bad) return t.skip('no .private-words.txt here');
  const files = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') await walk(p); }
      else if (/\.(?:ts|tsx|mjs|md|css|json|example)$/.test(e.name) || e.name === '.env.example') files.push(p);
    }
  };
  await walk(TEMPLATE);
  for (const f of files) assert.ok(!bad.test(await readFile(f, 'utf8')), f);
});

test('the template\'s own tests for the launch logic pass', () => {
  const dir = path.join(TEMPLATE, 'tests');
  const names = ['signup-mode', 'rate-limit', 'same-origin', 'account-hooks', 'legal', 'health'].map((n) => path.join(dir, `${n}.test.mjs`));
  const r = spawnSync(process.execPath, ['--test', ...names], { encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => /✖|Error|fail/.test(l)).join('\n'));
});
