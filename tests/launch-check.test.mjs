import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchCheck } from '../scripts/launch/check-core.mjs';
import { stripeSetup } from '../scripts/launch/stripe-core.mjs';
import { renderLegalFile, buildLegalContent } from '../scripts/launch/legal-core.mjs';
import { parseCountry } from '../scripts/launch/countries.mjs';
import { loadServices } from '../scripts/launch/common.mjs';
import { tempApp, fakeProfile, fakeStripe, fakeVercel, KEYS } from './launch-helpers.mjs';

const okVerify = async () => [{ name: 'routes', ok: true, summary: 'ok', details: [] }, { name: 'auth', ok: true, skipped: true, reason: 'x', summary: 'x', details: [] }];
const page = (status = 200, body = '') => ({ ok: status < 300, status, text: async () => body, headers: new Map() });
const siteFetch = (overrides = {}) => async (url) => {
  const p = new URL(url).pathname;
  if (p in overrides) return overrides[p];
  if (p === '/manifest.webmanifest') return page(200, JSON.stringify({ name: 'Tea Shop', icons: [{ src: '/i.png' }] }));
  return page(200, 'ok');
};

async function writeLegal(dir, { billing = true, phone = '+30 210 0', withdrawal = true } = {}) {
  const catalogue = await loadServices();
  const services = catalogue.services.filter((s) => ['supabase', 'vercel', 'resend', ...(billing ? ['stripe'] : [])].includes(s.id));
  const content = buildLegalContent({
    appName: 'Tea Shop', appDescription: '', controller: { name: 'Tea Ltd', address: '1 Tea St', email: 'hi@tea.example', phone },
    country: parseCountry('GR'), services, modules: billing && withdrawal ? ['billing'] : [],
    plans: billing && withdrawal ? [{ id: 'free', name: 'Free', priceCents: 0, currency: 'EUR', interval: 'month' }, { id: 'pro', name: 'Pro', priceCents: 900, currency: 'EUR', interval: 'month' }] : null,
    supabaseRegion: { code: 'eu-central-1' }, minAge: 16, today: '2027-01-01',
  });
  await mkdir(path.join(dir, 'src', 'lib'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'lib', 'legal-content.ts'), renderLegalFile(content));
}

async function readyApp(t, { live = false } = {}) {
  const app = await tempApp({
    siteUrl: 'https://tea.example', url: 'https://tea.example',
    launch: { domain: { name: 'tea.example', url: 'https://tea.example' }, signupMode: 'verified', email: { sendingDomain: 'send.tea.example', verified: true }, billing: { mode: live ? 'live' : 'test', testSetupAt: 'x' } },
  });
  t.after(app.cleanup);
  await writeLegal(app.dir);
  for (const [rel, text] of [['src/app/api/account/delete/route.ts', 'export {}'], ['src/app/api/billing/withdraw/route.ts', 'export {}'], ['src/app/api/billing/checkout/route.ts', '...termsConsent(SITE_URL)']]) {
    await mkdir(path.dirname(path.join(app.dir, rel)), { recursive: true });
    await writeFile(path.join(app.dir, rel), text);
  }
  const stripe = fakeStripe();
  const vercel = fakeVercel();
  const prof = fakeProfile();
  // Make the Stripe objects the way stripe-setup does.
  await stripeSetup({ appDir: app.dir, live }, { readSecrets: async () => new Map([[live ? 'STRIPE_LIVE_SECRET_KEY' : 'STRIPE_SECRET_KEY', live ? KEYS.live : KEYS.test]]), fetch: stripe.fetch, vercel, profile: prof, sleep: async () => {}, checkHealth: async () => ({ ok: true, failures: [] }) });
  const deps = (more = {}) => ({
    readSecrets: async () => new Map([[live ? 'STRIPE_LIVE_SECRET_KEY' : 'STRIPE_SECRET_KEY', live ? KEYS.live : KEYS.test]]),
    fetch: siteFetch(), stripe: undefined, vercel, profile: prof, runVerify: okVerify, sleep: async () => {}, ...more,
  });
  // The Stripe client in check-core is made from `fetch`; give it the fake Stripe for api.stripe.com and the fake site for the rest.
  const mixed = (siteOverrides = {}) => async (url, init) => (String(url).startsWith('https://api.stripe.com') ? stripe.fetch(url, init) : siteFetch(siteOverrides)(url, init));
  return { app, stripe, vercel, prof, deps, mixed };
}
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test('a fully set up app passes every check, in test and in live mode', async (t) => {
  for (const live of [false, true]) {
    const { app, deps, mixed } = await readyApp(t, { live });
    const r = await launchCheck({ appDir: app.dir, live }, deps({ fetch: mixed() }));
    const failed = r.checks.filter((c) => c.status === 'fail');
    assert.deepEqual(failed, [], JSON.stringify(failed));
    assert.equal(r.ok, true);
    assert.equal(byId(r).stripe.status, 'ok');
    assert.equal(byId(r)['legal-withdrawal'].status, 'ok');
  }
});

test('an app that is not set up fails with the command that fixes each thing, and does not crash', async (t) => {
  const app = await tempApp({});
  t.after(app.cleanup);
  const r = await launchCheck({ appDir: app.dir, live: true }, {
    readSecrets: async () => new Map(), fetch: siteFetch(), vercel: fakeVercel(), profile: fakeProfile({ accounts: { vercel: { scope: 'team' }, stripe: {} } }), runVerify: okVerify,
  });
  assert.equal(r.ok, false);
  const c = byId(r);
  assert.equal(c['legal-controller'].status, 'fail');
  assert.match(c['legal-controller'].fix, /legal-generate/);
  assert.equal(c.domain.status, 'fail');
  assert.match(c.domain.fix, /launch-domain/);
  assert.equal(c['signup-mode'].status, 'fail');
  assert.match(c['signup-mode'].fix, /--switch-to-verified/);
  assert.equal(c['email-domain'].status, 'fail');
  assert.equal(c['vercel-plan'].status, 'fail');
  assert.equal(c.stripe.status, 'fail');
  assert.match(c.stripe.detail, /STRIPE_LIVE_SECRET_KEY is not in your keys file/);
  assert.equal(c['account-deletion'].status, 'fail');
  assert.ok(r.checks.every((x) => x.detail && ['ok', 'warn', 'fail', 'skip'].includes(x.status)));
});

test('the same gaps are only warnings while trying things out (not --live)', async (t) => {
  const app = await tempApp({});
  t.after(app.cleanup);
  const r = await launchCheck({ appDir: app.dir, live: false }, {
    readSecrets: async () => new Map(), fetch: siteFetch(), vercel: fakeVercel(), profile: fakeProfile({ accounts: { vercel: { scope: 'team' }, stripe: {} } }), runVerify: okVerify,
  });
  const c = byId(r);
  for (const id of ['domain', 'signup-mode', 'email-domain', 'vercel-plan']) assert.equal(c[id].status, 'warn', id);
});

test('a network that is down gives a failure for the live pages, not a crash', async (t) => {
  const { app, deps } = await readyApp(t);
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: down, stripe: undefined }));
  assert.equal(byId(r)['live-pages'].status, 'fail');
  assert.match(byId(r)['live-pages'].detail, /answered nothing/);
  assert.equal(byId(r).stripe.status, 'fail', 'Stripe could not be reached: a failure with a message');
});

test('missing Stripe objects are named', async (t) => {
  const { app, stripe, deps, mixed } = await readyApp(t);
  stripe.state.hooks.length = 0;
  stripe.state.portals.length = 0;
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  assert.equal(byId(r).stripe.status, 'fail');
  assert.match(byId(r).stripe.detail, /webhook address/);
  assert.match(byId(r).stripe.detail, /no customer portal/);
  assert.match(byId(r).stripe.fix, /stripe-setup/);
});

test('a test key in the live slot is a failure', async (t) => {
  const { app, deps, mixed } = await readyApp(t, { live: true });
  const r = await launchCheck({ appDir: app.dir, live: true }, deps({ fetch: mixed(), readSecrets: async () => new Map([['STRIPE_LIVE_SECRET_KEY', KEYS.test]]) }));
  assert.equal(byId(r).stripe.status, 'fail');
  assert.match(byId(r).stripe.detail, /is a test key/);
});

test('billing apps: the terms must have the withdrawal section, the phone number, the withdraw button and the checkout box', async (t) => {
  const { app, deps, mixed } = await readyApp(t);
  await writeLegal(app.dir, { billing: true, withdrawal: false, phone: '' });
  await writeFile(path.join(app.dir, 'src/app/api/billing/checkout/route.ts'), 'old checkout');
  const r = await launchCheck({ appDir: app.dir, live: true }, deps({ fetch: mixed() }));
  const c = byId(r);
  assert.equal(c['legal-withdrawal'].status, 'fail');
  assert.equal(c['legal-phone'].status, 'fail');
  assert.equal(c['withdraw-button'].status, 'fail');
  assert.match(c['withdraw-button'].detail, /checkout does not show/);
});

test('a missing live page is a failure, and the missing privacy mention of a service is named', async (t) => {
  const { app, deps, mixed } = await readyApp(t);
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed({ '/pricing': page(404) }) }));
  assert.match(byId(r)['live-pages'].detail, /\/pricing answered 404/);
  // A service the app uses but the policy does not list.
  const { writeFile: w } = await import('node:fs/promises');
  const cfg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.dir, '.shipyard-app.json'), 'utf8'));
  cfg.env = [...cfg.env, 'OPENAI_API_KEY'];
  await w(path.join(app.dir, '.shipyard-app.json'), JSON.stringify(cfg));
  const r2 = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  assert.equal(byId(r2)['legal-services'].status, 'fail');
  assert.match(byId(r2)['legal-services'].detail, /OpenAI/);
});

test('the app\'s own checks failing makes the whole check fail with the first problem', async (t) => {
  const { app, deps, mixed } = await readyApp(t);
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed(), runVerify: async () => [{ name: 'isolation', ok: false, summary: 'bad', problems: ['items: another signed-in user can read'], details: [] }] }));
  assert.equal(r.ok, false);
  assert.match(byId(r).verify.detail, /isolation \(items: another signed-in user can read\)/);
});

test('no key ever appears in the result', async (t) => {
  const { app, deps, mixed } = await readyApp(t);
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  const text = JSON.stringify(r);
  for (const v of Object.values(KEYS)) assert.ok(!text.includes(v));
  assert.ok(!/whsec_/.test(text));
});

test('a customer portal made for another app (or by hand) does not count as this app\'s portal', async (t) => {
  const { app, stripe, deps, mixed } = await readyApp(t);
  stripe.state.portals.length = 0;
  stripe.state.portals.push({ id: 'bpc_other', active: true, metadata: { shipyard_app: 'other-app' } }, { id: 'bpc_default', active: true, metadata: {} });
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  assert.equal(byId(r).stripe.status, 'fail');
  assert.match(byId(r).stripe.detail, /no customer portal for this app/);
  stripe.state.portals.push({ id: 'bpc_mine', active: true, metadata: { shipyard_app: 'tea-shop' } });
  const again = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  assert.equal(byId(again).stripe.status, 'ok');
});

test('an old webhook address for this app that is still active is reported', async (t) => {
  const { app, stripe, deps, mixed } = await readyApp(t);
  stripe.state.hooks.push({ id: 'we_old', url: 'https://tea-shop.vercel.app/api/billing/webhook', enabled_events: ['invoice.paid'], status: 'enabled', metadata: { shipyard_app: 'tea-shop' } });
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  assert.equal(byId(r).stripe.status, 'fail');
  assert.match(byId(r).stripe.detail, /old webhook address.*tea-shop\.vercel\.app/);
  assert.match(byId(r).stripe.fix, /stripe-setup/);
});

test('the Stripe Terms link reminder is a note, not a warning that can never clear', async (t) => {
  const { app, deps, mixed } = await readyApp(t);
  const r = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  assert.equal(byId(r)['stripe-terms-link'].status, 'skip');
  assert.match(byId(r)['stripe-terms-link'].detail, /\/terms/);
  assert.equal(r.counts.warn, 0, 'a fully set up app has nothing left to warn about');
});

test('the www address: skipped when there is none, a warning with the exact steps until it redirects, ok once it does', async (t) => {
  const { app, deps, mixed } = await readyApp(t);
  const skipped = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: mixed() }));
  assert.equal(byId(skipped)['www-redirect'].status, 'skip');
  const { readFile } = await import('node:fs/promises');
  const file = path.join(app.dir, '.shipyard-app.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.launch.domain.www = 'www.tea.example';
  await writeFile(file, JSON.stringify(config));
  const wwwReply = (status, location) => ({ ok: status < 300, status, text: async () => '', headers: { get: (k) => (k.toLowerCase() === 'location' ? location ?? null : null) } });
  const withWww = (res) => async (url, init) => (new URL(url).hostname === 'www.tea.example' ? res : mixed()(url, init));
  const open = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: withWww(wwwReply(200)) }));
  assert.equal(byId(open)['www-redirect'].status, 'warn');
  assert.match(byId(open)['www-redirect'].fix, /Redirect to Another Domain/);
  assert.equal(open.ok, true, 'a warning does not block going live');
  const done = await launchCheck({ appDir: app.dir, live: false }, deps({ fetch: withWww(wwwReply(308, 'https://tea.example/')) }));
  assert.equal(byId(done)['www-redirect'].status, 'ok');
});
