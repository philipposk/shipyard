import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check as routes, PAGES } from '../scripts/verify/routes.mjs';
import { check as protection } from '../scripts/verify/protection.mjs';
import { startFake, APP_NAME } from './verify-helpers.mjs';

async function withServer(t, opts) {
  const fake = await startFake(opts);
  t.after(() => fake.close());
  return fake;
}
const ctx = (fake, extra = {}) => ({ appDir: '/nonexistent', url: fake.url, app: { name: APP_NAME }, secrets: new Map(), ...extra });

test('routes: a healthy app passes', async (t) => {
  const fake = await withServer(t);
  const r = await routes(ctx(fake));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), new RegExp(`${PAGES.length} of ${PAGES.length} pages`));
  assert.match(r.details.join('\n'), /404 page shows the app name/);
  // The app name has an ampersand, which is written as &amp; in the HTML.
  assert.ok(APP_NAME.includes('&'));
});

test('routes: skipped without a web address', async () => {
  const r = await routes({ appDir: '/x', url: null, app: null, secrets: new Map() });
  assert.equal(r.skipped, true);
  assert.equal(r.ok, true);
  assert.match(r.reason, /no web address/);
});

test('routes: a page that answers 500 is reported', async (t) => {
  const fake = await withServer(t, { badPage: '/help' });
  const r = await routes(ctx(fake));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\/help: answered 500/);
});

test('routes: a plain 404 page without the app name fails', async (t) => {
  const fake = await withServer(t, { plain404: true });
  const r = await routes(ctx(fake));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /404 page: answered 404 but the page does not mention/);
});

test('routes: signed-out redirect for unknown pages is fine when the real 404 page exists', async (t) => {
  const fake = await withServer(t, { gate404: true });
  const r = await routes(ctx(fake));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.details.join('\n'), /send signed-out visitors to sign-in/);
});

test('routes: a redirect gate with no real 404 page behind it fails', async (t) => {
  const fake = await withServer(t, { gate404: true, plain404: true });
  const r = await routes(ctx(fake));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /404 page/);
});

test('routes: a public page that redirects is reported with the destination path only', async (t) => {
  const fake = await withServer(t, { redirectPage: '/terms' });
  const r = await routes(ctx(fake));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\/terms: sends visitors to \/sign-in instead of showing the page/);
  assert.doesNotMatch(r.problems.join('\n'), /next=/);
});

test('routes: OPTIONS 405 on sign-up is reported', async (t) => {
  const fake = await withServer(t, { signupOptions: 405 });
  const r = await routes(ctx(fake));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\/api\/auth\/signup: OPTIONS answered 405/);
});

test('routes: a leftover setup placeholder is reported', async (t) => {
  const fake = await withServer(t, { placeholderPage: '/about' });
  const r = await routes(ctx(fake));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /\/about: still contains a setup placeholder/);
});

test('routes: an unreachable app is reported in plain words', async () => {
  const r = await routes({ appDir: '/x', url: 'http://127.0.0.1:1', app: { name: 'X' }, secrets: new Map() });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /refused|failed|cut off/);
});

test('routes: app name is read from .shipyard-app.json when the profile has none', async (t) => {
  const fake = await withServer(t);
  const { tempDir, removeDir } = await import('./verify-helpers.mjs');
  const { writeFile } = await import('node:fs/promises');
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await writeFile(`${dir}/.shipyard-app.json`, JSON.stringify({ slug: 'x', name: APP_NAME }));
  const r = await routes({ appDir: dir, url: fake.url, app: null, secrets: new Map() });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('protection: open site passes', async (t) => {
  const fake = await withServer(t);
  const r = await protection(ctx(fake));
  assert.equal(r.ok, true);
});

test('protection: a Vercel login wall fails with the fix in plain words', async (t) => {
  const fake = await withServer(t, { vercelWall: true });
  const r = await protection(ctx(fake));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /Deployment Protection/);
});

test('protection: skipped without a web address; unreachable site fails', async () => {
  assert.equal((await protection({ url: null })).skipped, true);
  const r = await protection({ url: 'http://127.0.0.1:1' });
  assert.equal(r.ok, false);
});
