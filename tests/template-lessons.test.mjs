import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { TEMPLATE } from './verify-helpers.mjs';

// Static checks for lessons from real launches (Ballpark, Dailies) that the template and the written rules must keep.

const read = (rel) => readFile(path.join(TEMPLATE, ...rel.split('/')), 'utf8');
const ROOT = path.join(TEMPLATE, '..');
const readRoot = (rel) => readFile(path.join(ROOT, ...rel.split('/')), 'utf8');

test('/auth/confirm: a token link never signs anyone in on GET; the button POSTs behind a same-site check', async () => {
  const route = await read('src/app/auth/confirm/route.ts');
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
  assert.doesNotMatch(get, /verifyOtp/, 'GET must not use a one-time token');
  assert.match(get, /continuePath/);
  const post = route.slice(route.indexOf('export async function POST'));
  assert.ok(post.indexOf('isSameOrigin(') >= 0 && post.indexOf('isSameOrigin(') < post.indexOf('verifyOtp('), 'origin checked before the token is used');
  assert.match(post, /303/);
  const page = await read('src/app/auth/confirm/continue/page.tsx');
  assert.match(page, /method="post"/);
  assert.match(page, /action="\/auth\/confirm"/);
  assert.match(page, /robots: \{ index: false/);
  assert.match(await read('src/proxy.ts'), /"\/auth\/confirm"/, 'the continue page sits under a public prefix');
});

test('sign-out and other changes are POST only', async () => {
  const signOut = await read('src/app/auth/sign-out/route.ts');
  assert.doesNotMatch(signOut, /export async function GET/);
  assert.match(signOut, /303/);
});

test('globals.css: overflow-x is clipped, not hidden, on html and body (sticky bars keep working)', async () => {
  const css = await read('src/app/globals.css');
  assert.match(css, /html, body \{[^}]*overflow-x: clip/);
  assert.doesNotMatch(css, /html, body \{[^}]*overflow-x: hidden/);
});

test('service worker: caches built files and icons only, and answers pages and data from the network', async () => {
  const sw = await read('public/sw.js');
  assert.match(sw, /startsWith\("\/_next\/static\/"\)/);
  assert.match(sw, /if \(!cacheable\(url\.pathname\)\) return;/);
  assert.doesNotMatch(sw, /_rsc/);
  assert.doesNotMatch(sw, /\/api\//);
});

test('layout has no global canonical tag, and no root loading.tsx', async () => {
  const layout = await read('src/app/layout.tsx');
  assert.doesNotMatch(layout, /canonical/);
  assert.equal(existsSync(path.join(TEMPLATE, 'src', 'app', 'loading.tsx')), false);
});

test('the example list reads every row with fetchAll and a stable order', async () => {
  const items = await read('src/app/items/items-client.tsx');
  assert.match(items, /fetchAll/);
  assert.match(items, /\.order\("id"/);
  assert.match(items, /\.range\(from, to\)/);
});

test('the written rules carry the lessons, in the app and in the skill', async () => {
  const agents = await read('AGENTS.md');
  for (const re of [/Nothing changes on a GET/, /never used on a GET/, /1000 rows/, /fetchAll/, /alternates\.canonical/, /overflow-x: clip/, /createPortal/, /on the server/, /never the sign-in of someone who already has an account/]) {
    assert.match(agents, re, String(re));
  }
  const lessons = await readRoot('skills/new-app/references/lessons.md');
  assert.match(lessons, /never used on a GET/);
  assert.match(lessons, /1000 rows/);
  assert.match(await readRoot('skills/new-app/references/verify.md'), /re-run the review on the fixed code/);
  assert.match(await readRoot('skills/new-app/SKILL.md'), /run verify again and read the fixes once more/);
});

test('the new text has no em dashes', async () => {
  const files = [
    ['AGENTS.md', read], ['src/app/auth/confirm/route.ts', read], ['src/app/auth/confirm/continue/page.tsx', read],
    ['src/lib/paginate.mjs', read], ['src/lib/auth/confirm-link.mjs', read],
    ['skills/new-app/references/lessons.md', readRoot], ['skills/new-app/references/build-rules.md', readRoot],
    ['skills/new-app/references/verify.md', readRoot], ['skills/new-app/SKILL.md', readRoot],
  ];
  for (const [rel, rd] of files) assert.ok(!(await rd(rel)).includes('—'), `${rel} has an em dash`);
});

test('onboarding: the skip cookie is signed and bound to the user, and API routes are gated too (CommitR)', async () => {
  const proxy = await read('src/proxy.ts');
  assert.match(proxy, /from "@\/lib\/auth\/onboarded-cookie\.mjs"/);
  assert.match(proxy, /verifyOnboarded\(req\.cookies\.get\(ONBOARDED_COOKIE\)\?\.value, user\.id, secret\)/, 'the cookie is checked against this user');
  assert.match(proxy, /res\.cookies\.set\(ONBOARDED_COOKIE, signed,/, 'only a signed value is stored');
  assert.doesNotMatch(proxy, /cookies\.set\(ONBOARDED_COOKIE, (user\.id|"1")/, 'never a plain value');
  assert.doesNotMatch(proxy, /if \(pathname\.startsWith\("\/api\/"\)\) return res;/, 'API routes must not skip the onboarding gate');
  assert.match(proxy, /"onboarding_required"[^\n]*status: 403/);
  for (const allowed of ['"/profile/edit"', '"/api/profile"', '"/api/account"', '"/settings"']) {
    assert.ok(proxy.slice(proxy.indexOf('const ONBOARDING_ALLOWED'), proxy.indexOf('const ONBOARDED_COOKIE')).includes(allowed), `${allowed} stays reachable before setup`);
  }
  const lib = await read('src/lib/auth/onboarded-cookie.mjs');
  assert.doesNotMatch(lib, /NEXT_PUBLIC_/, 'the secret is never a public variable');
  assert.doesNotMatch(lib, /from "node:/, 'Web Crypto only, so it runs in the proxy');
});
