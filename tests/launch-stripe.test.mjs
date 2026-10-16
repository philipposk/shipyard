import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stripeSetup, livePreflight, pickKey, targetsFor, loadStripeEvents } from '../scripts/launch/stripe-core.mjs';
import { renderLegalFile, buildLegalContent } from '../scripts/launch/legal-core.mjs';
import { parseCountry } from '../scripts/launch/countries.mjs';
import { tempApp, readConfig, fakeProfile, fakeStripe, fakeVercel, KEYS, SECRET_VALUES } from './launch-helpers.mjs';

const secretsMap = (extra = {}) => async () => new Map(Object.entries({ STRIPE_SECRET_KEY: KEYS.test, STRIPE_PUBLISHABLE_KEY: KEYS.testPk, ...extra }));
const noLeak = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const v of SECRET_VALUES) assert.ok(!text.includes(v), 'a key leaked');
  assert.ok(!/whsec_/.test(text), 'a webhook secret leaked');
};

async function setup(t, config = {}, profile = {}) {
  const app = await tempApp(config);
  t.after(app.cleanup);
  const stripe = fakeStripe();
  const vercel = fakeVercel();
  const prof = fakeProfile(profile);
  const deps = (more = {}) => ({ readSecrets: secretsMap(more.secrets), fetch: stripe.fetch, vercel, profile: prof, sleep: async () => {}, ...more.deps });
  return { app, stripe, vercel, prof, deps };
}

test('test mode: makes the product, price, portal and webhook, and puts the webhook secret straight into Vercel', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t);
  const r = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'test');
  assert.equal(stripe.state.products.length, 1);
  assert.deepEqual(stripe.state.prices.map((p) => [p.lookup_key, p.unit_amount, p.currency, p.recurring.interval]), [['tea-shop_pro_monthly', 900, 'eur', 'month']]);
  assert.equal(stripe.state.portals.length, 1);
  assert.equal(stripe.state.hooks[0].url, 'https://tea-shop.vercel.app/api/billing/webhook');
  const events = await loadStripeEvents();
  assert.deepEqual([...stripe.state.hooks[0].enabled_events].sort(), [...events].sort());
  // Every Stripe call used the test key.
  assert.ok(stripe.state.calls.every((c) => c.auth === `Bearer ${KEYS.test}`));
  // The secret went to Vercel, once, and nowhere else.
  const hook = vercel.set.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET');
  assert.equal(hook.length, 1);
  assert.equal(hook[0].value, stripe.state.secretsMade[0]);
  assert.deepEqual(hook[0].target, ['production', 'development']);
  noLeak(r);
  const config = await readConfig(app.dir);
  assert.equal(config.launch.billing.mode, 'test');
  assert.ok(config.launch.billing.testSetupAt);
  for (const n of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PORTAL_CONFIGURATION']) assert.ok(config.env.includes(n), n);
  assert.match(await readFile(path.join(app.dir, '.env.local'), 'utf8'), /STRIPE_PORTAL_CONFIGURATION=bpc_/);
  assert.ok(r.manual.some((m) => /Terms link/.test(m) && /\/terms/.test(m)));
});

test('test mode: running it again changes nothing in Stripe and does not touch the webhook secret', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t);
  await stripeSetup({ appDir: app.dir }, deps());
  const before = { products: stripe.state.products.length, prices: stripe.state.prices.length, hooks: stripe.state.hooks.map((h) => h.id), secrets: vercel.set.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET').length };
  const second = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(stripe.state.products.length, before.products);
  assert.equal(stripe.state.prices.length, before.prices);
  assert.deepEqual(stripe.state.hooks.map((h) => h.id), before.hooks);
  assert.equal(vercel.set.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET').length, before.secrets, 'the secret is only sent when the webhook is made');
  assert.equal(second.webhook.action, 'unchanged');
  assert.equal(second.products[0].priceAction, 'unchanged');
});

test('a changed price makes a new price and moves the lookup key to it', async (t) => {
  const { app, stripe, deps } = await setup(t);
  await stripeSetup({ appDir: app.dir }, deps());
  const file = path.join(app.dir, 'src/lib/billing/plans.ts');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"priceCents": 900', '"priceCents": 1200'));
  const r = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(r.products[0].priceAction, 'new-price');
  const create = stripe.state.calls.filter((c) => c.method === 'POST' && c.route === '/prices').at(-1);
  assert.equal(create.params.transfer_lookup_key, 'true');
  assert.deepEqual(stripe.state.prices.filter((p) => p.lookup_key).map((p) => p.unit_amount), [1200]);
  assert.equal(stripe.state.products.length, 1, 'the same product is reused');
});

test('a wrong kind of key is refused before anything is sent to Stripe', async (t) => {
  const { app, stripe, deps } = await setup(t);
  await assert.rejects(() => stripeSetup({ appDir: app.dir }, deps({ secrets: { STRIPE_SECRET_KEY: KEYS.live } })), (e) => /live key/.test(e.message) && e.data.reason === 'wrong-key-mode' && !e.message.includes(KEYS.live));
  await assert.rejects(() => stripeSetup({ appDir: app.dir, live: true }, deps({ secrets: { STRIPE_LIVE_SECRET_KEY: KEYS.test } })), (e) => /test key/.test(e.message) && !e.message.includes(KEYS.test));
  await assert.rejects(() => stripeSetup({ appDir: app.dir, live: true }, deps()), /STRIPE_LIVE_SECRET_KEY is not in your Shipyard keys file/);
  assert.equal(stripe.state.calls.length, 0);
});

test('pickKey: test mode never reads the live slot and live mode never reads the test slot', () => {
  const both = new Map([['STRIPE_SECRET_KEY', KEYS.test], ['STRIPE_LIVE_SECRET_KEY', KEYS.live]]);
  assert.equal(pickKey({ live: false, secrets: both }).key, KEYS.test);
  assert.equal(pickKey({ live: true, secrets: both }).key, KEYS.live);
  assert.throws(() => pickKey({ live: true, secrets: new Map([['STRIPE_SECRET_KEY', KEYS.live]]) }), /STRIPE_LIVE_SECRET_KEY is not in/);
  assert.throws(() => pickKey({ live: false, secrets: new Map([['STRIPE_SECRET_KEY', 'not-a-stripe-key-at-all']]) }), /does not look like a Stripe secret key/);
});

test('the payments module is required, and so is a paid plan and a public https address', async (t) => {
  const { app, deps } = await setup(t, { modules: [] });
  await assert.rejects(() => stripeSetup({ appDir: app.dir }, deps()), /does not have the payments module/);
  const b = await setup(t, { siteUrl: 'http://localhost:3000', url: 'http://localhost:3000' });
  await assert.rejects(() => stripeSetup({ appDir: b.app.dir }, b.deps()), /no public https address/);
});

// ---------------------------------------------------------------- go live

async function legalFile(dir, { withdrawal = true, controller = {} } = {}) {
  const country = parseCountry('GR');
  const content = buildLegalContent({
    appName: 'Tea Shop', appDescription: '', controller: { name: 'Tea Ltd', address: '1 Tea St, Athens', email: 'hi@tea.example', phone: '+30 210 0000000', ...controller },
    country, services: [], modules: withdrawal ? ['billing'] : [], plans: withdrawal ? [{ id: 'free', name: 'Free', priceCents: 0, currency: 'EUR', interval: 'month' }, { id: 'pro', name: 'Pro', priceCents: 900, currency: 'EUR', interval: 'month' }] : null,
    supabaseRegion: { code: 'eu-central-1' }, minAge: 16, today: '2027-01-01',
  });
  await mkdir(path.join(dir, 'src', 'lib'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'lib', 'legal-content.ts'), renderLegalFile(content));
}

const readyConfig = {
  siteUrl: 'https://tea.example', url: 'https://tea.example',
  launch: { domain: { name: 'tea.example', url: 'https://tea.example' }, signupMode: 'verified', billing: { mode: 'test', testSetupAt: '2027-01-01T00:00:00Z' } },
};
const healthy = async () => ({ ok: true, failures: [] });

test('live: refuses with a plain list, and does not call Stripe at all, until everything on the go-live list is true', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t, { siteUrl: 'https://tea-shop.vercel.app' }, { accounts: { vercel: { scope: 'team' }, stripe: {} } });
  const run = () => stripeSetup({ appDir: app.dir, live: true }, deps({ secrets: { STRIPE_LIVE_SECRET_KEY: KEYS.live }, deps: { checkHealth: async () => ({ ok: false, failures: ['Stripe (test)'] }) } }));
  await assert.rejects(run, (e) => {
    assert.equal(e.data.reason, 'preflight');
    const text = e.data.problems.join('\n');
    assert.match(text, /own domain/);
    assert.match(text, /legal pages have not been made/);
    assert.match(text, /confirmed email/);
    assert.match(text, /Vercel Pro/);
    assert.match(text, /test mode/);
    assert.match(text, /go-live check is not passing/);
    assert.match(e.message, /Nothing was made in your live Stripe account/);
    return true;
  });
  assert.equal(stripe.state.calls.length, 0, 'no call to Stripe');
  assert.equal(vercel.set.length, 0, 'nothing set on Vercel');
});

test('livePreflight: each rule on its own', () => {
  const good = { appUrl: 'https://tea.example', legal: { controller: { name: 'a', address: 'b', email: 'c', country: 'd' }, terms: [{ id: 'right-to-withdraw' }] }, signupMode: 'verified', vercelPlan: 'pro', testSetupAt: 'x', health: { ok: true, failures: [] } };
  assert.deepEqual(livePreflight(good), []);
  assert.match(livePreflight({ ...good, appUrl: 'https://x.vercel.app' }).join(), /own domain/);
  assert.match(livePreflight({ ...good, appUrl: null }).join(), /own domain/);
  assert.match(livePreflight({ ...good, legal: { ...good.legal, controller: { name: 'a', address: '', email: 'c', country: 'd' } } }).join(), /missing who runs the app \(address\)/);
  assert.match(livePreflight({ ...good, legal: { ...good.legal, terms: [] } }).join(), /withdrawal/);
  assert.match(livePreflight({ ...good, signupMode: 'starter' }).join(), /confirmed email/);
  assert.match(livePreflight({ ...good, vercelPlan: 'hobby' }).join(), /Vercel Pro/);
  assert.match(livePreflight({ ...good, vercelPlan: undefined }).join(), /accounts\.vercel\.plan pro/);
  assert.match(livePreflight({ ...good, testSetupAt: undefined }).join(), /test mode/);
  assert.match(livePreflight({ ...good, health: null }).join(), /has not been run/);
  assert.match(livePreflight({ ...good, health: { ok: false, failures: ['one', 'two'] } }).join(), /one; two/);
});

test('live: with everything ready it uses the live key, and live values go to production only', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t, readyConfig);
  await legalFile(app.dir);
  const r = await stripeSetup({ appDir: app.dir, live: true }, deps({ secrets: { STRIPE_LIVE_SECRET_KEY: KEYS.live, STRIPE_LIVE_PUBLISHABLE_KEY: KEYS.livePk }, deps: { checkHealth: healthy } }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'live');
  assert.ok(stripe.state.calls.length > 0 && stripe.state.calls.every((c) => c.auth === `Bearer ${KEYS.live}`), 'only the live key was used');
  assert.equal(stripe.state.hooks[0].url, 'https://tea.example/api/billing/webhook');
  assert.ok(vercel.set.length >= 4);
  assert.ok(vercel.set.every((e) => e.target.length === 1 && e.target[0] === 'production'), 'live values never land in development');
  const byName = Object.fromEntries(vercel.set.map((e) => [e.name, e.value]));
  assert.equal(byName.STRIPE_SECRET_KEY, KEYS.live);
  assert.equal(byName.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, KEYS.livePk);
  assert.equal(byName.STRIPE_WEBHOOK_SECRET, stripe.state.secretsMade[0]);
  noLeak(r);
  const config = await readConfig(app.dir);
  assert.equal(config.launch.billing.mode, 'live');
  assert.ok(config.launch.billing.liveSetupAt);
  assert.equal(config.launch.billing.testSetupAt, '2027-01-01T00:00:00Z', 'the test record is kept');
});

test('after go-live, running test mode again only touches the development environment', async (t) => {
  const { app, vercel, deps } = await setup(t, readyConfig);
  await legalFile(app.dir);
  await stripeSetup({ appDir: app.dir, live: true }, deps({ secrets: { STRIPE_LIVE_SECRET_KEY: KEYS.live }, deps: { checkHealth: healthy } }));
  const liveCount = vercel.set.length;
  const second = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(second.mode, 'test');
  const added = vercel.set.slice(liveCount);
  assert.ok(added.length > 0);
  assert.ok(added.every((e) => e.target.length === 1 && e.target[0] === 'development'), JSON.stringify(added.map((e) => [e.name, e.target])));
  assert.ok(!added.some((e) => e.name === 'STRIPE_WEBHOOK_SECRET'), 'no test webhook secret is put on the live app');
  assert.equal((await readConfig(app.dir)).launch.billing.mode, 'live', 'the app stays live');
  assert.deepEqual(targetsFor({ live: false, paymentsLive: true }), ['development']);
  assert.deepEqual(targetsFor({ live: true, paymentsLive: false }), ['production']);
  assert.deepEqual(targetsFor({ live: false, paymentsLive: false }), ['production', 'development']);
});

test('a webhook that exists but whose secret the app does not have is made again, so the app gets a working secret', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t);
  await stripeSetup({ appDir: app.dir }, deps());
  vercel.set.length = 0; // a fresh Vercel project: the secret is gone
  const r = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(r.webhook.action, 'recreated');
  assert.equal(stripe.state.hooks.length, 1);
  assert.equal(vercel.set.find((e) => e.name === 'STRIPE_WEBHOOK_SECRET').value, stripe.state.secretsMade[1]);
});

test('if Vercel refuses the webhook secret, the new webhook is removed (the secret could never be read again) and nothing leaks', async (t) => {
  const { app, stripe, deps } = await setup(t);
  const bad = fakeVercel({ failOn: ['STRIPE_WEBHOOK_SECRET'] });
  await assert.rejects(
    () => stripeSetup({ appDir: app.dir }, deps({ deps: { vercel: bad } })),
    (e) => { noLeak(e.message); assert.equal(e.data.reason, 'vercel'); assert.match(e.message, /webhook was removed/); return true; },
  );
  assert.equal(stripe.state.hooks.length, 0);
});

test('Stripe errors never show the key', async (t) => {
  const { app, deps } = await setup(t);
  const fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: `Invalid API Key provided: ${KEYS.test}` } }), headers: new Map() });
  await assert.rejects(() => stripeSetup({ appDir: app.dir }, deps({ deps: { fetch } })), (e) => { noLeak(e.message); assert.match(e.message, /did not accept the key/); return true; });
});

// ---------------------------------------------------------------- re-runs, moving the address, pages

test('test mode: Vercel lists one row per environment, and a re-run still keeps the same webhook and secret', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t);
  await stripeSetup({ appDir: app.dir }, deps());
  const rows = (await vercel.envLs()).envs.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET');
  assert.deepEqual(rows.map((r) => r.targets), [['production'], ['development']], 'one row per environment, like the real CLI');
  const id = stripe.state.hooks[0].id;
  // Run it twice more, with the rows in both orders.
  for (let i = 0; i < 2; i++) {
    if (i === 1) vercel.set.reverse();
    const r = await stripeSetup({ appDir: app.dir }, deps());
    assert.equal(r.webhook.action, 'unchanged');
  }
  assert.equal(stripe.state.hooks.length, 1);
  assert.equal(stripe.state.hooks[0].id, id, 'the webhook was never remade');
  assert.equal(stripe.state.secretsMade.length, 1, 'no new signing secret');
});

test('a secret on only one environment still counts as missing, so the webhook is made again', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t);
  await stripeSetup({ appDir: app.dir }, deps());
  for (let i = vercel.set.length - 1; i >= 0; i--) if (vercel.set[i].name === 'STRIPE_WEBHOOK_SECRET') vercel.set[i].target = ['production'];
  const r = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(r.webhook.action, 'recreated');
  assert.equal(stripe.state.hooks.length, 1);
});

test('a new address moves the same webhook (the secret stays), and old copies for this app are removed', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t);
  await stripeSetup({ appDir: app.dir }, deps());
  const id = stripe.state.hooks[0].id;
  // An old leftover for this app at another address, and one that belongs to a different app.
  stripe.state.hooks.push({ id: 'we_old', url: 'https://old.example/api/billing/webhook', enabled_events: ['invoice.paid'], status: 'enabled', metadata: { shipyard_app: 'tea-shop' } });
  stripe.state.hooks.push({ id: 'we_other', url: 'https://other.example/api/billing/webhook', enabled_events: ['invoice.paid'], status: 'enabled', metadata: { shipyard_app: 'other-app' } });
  // The student launches a domain, then runs stripe-setup again.
  const file = path.join(app.dir, '.shipyard-app.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.launch = { ...(config.launch ?? {}), domain: { name: 'tea.example', url: 'https://tea.example' } };
  await writeFile(file, JSON.stringify(config));
  const secretsBefore = vercel.set.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET').length;
  const r = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(r.webhook.action, 'moved');
  assert.equal(r.webhook.removed, 1);
  assert.deepEqual(stripe.state.hooks.map((h) => h.id).sort(), ['we_other', id].sort());
  assert.equal(stripe.state.hooks.find((h) => h.id === id).url, 'https://tea.example/api/billing/webhook');
  assert.equal(stripe.state.secretsMade.length, 1, 'no new signing secret, so the running app keeps working');
  assert.equal(vercel.set.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET').length, secretsBefore, 'nothing new was pushed for the secret');
});

test('an old endpoint without the app tag is still found by its address', async (t) => {
  const { app, stripe, deps } = await setup(t);
  stripe.state.hooks.push({ id: 'we_untagged', url: 'https://tea-shop.vercel.app/api/billing/webhook', enabled_events: [], status: 'enabled', metadata: {} });
  const r = await stripeSetup({ appDir: app.dir }, deps({ deps: { vercel: (() => { const v = fakeVercel(); v.set.push({ name: 'STRIPE_WEBHOOK_SECRET', value: 'x', target: ['production', 'development'] }); return v; })() } }));
  assert.equal(r.webhook.id, 'we_untagged');
  assert.equal(r.webhook.action, 'updated');
  assert.equal(stripe.state.hooks.length, 1);
  assert.equal(stripe.state.hooks[0].metadata.shipyard_app, 'tea-shop', 'it is tagged now, so the next move finds it by the tag');
});

test('long lists: an existing product, portal and webhook on a later page are found, and nothing is made twice', async (t) => {
  const { app, stripe, vercel, deps } = await setup(t);
  await stripeSetup({ appDir: app.dir }, deps());
  const before = { products: stripe.state.products.length, portals: stripe.state.portals.length, hooks: stripe.state.hooks.length, prices: stripe.state.prices.length };
  // Other apps' objects come first, so ours end up on the last page of 2.
  stripe.state.pageSize = 2;
  for (let i = 0; i < 5; i++) {
    stripe.state.products.unshift({ id: `prod_x${i}`, name: `Other ${i}`, active: true, metadata: { shipyard_app: `other-${i}` } });
    stripe.state.portals.unshift({ id: `bpc_x${i}`, active: true, metadata: { shipyard_app: `other-${i}` }, params: {} });
    stripe.state.hooks.unshift({ id: `we_x${i}`, url: `https://other${i}.example/api/billing/webhook`, enabled_events: ['invoice.paid'], status: 'enabled', metadata: { shipyard_app: `other-${i}` } });
  }
  const hookId = stripe.state.hooks.find((h) => h.url === 'https://tea-shop.vercel.app/api/billing/webhook').id;
  const r = await stripeSetup({ appDir: app.dir }, deps());
  assert.equal(stripe.state.products.length, before.products + 5, 'no second Tea Shop product');
  assert.equal(stripe.state.portals.length, before.portals + 5, 'no second portal');
  assert.equal(stripe.state.hooks.length, before.hooks + 5, 'no second webhook');
  assert.equal(stripe.state.prices.length, before.prices);
  assert.equal(r.webhook.id, hookId);
  assert.equal(r.webhook.action, 'unchanged');
  assert.equal(r.portal.action, 'updated');
  assert.ok(stripe.state.calls.filter((c) => c.route === '/webhook_endpoints' && c.method === 'GET').some((c) => c.params.starting_after), 'it asked for the next page');
  assert.equal(vercel.set.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET').length, 1, 'no new secret was pushed');
});

test('live without the live publishable key: the student is told, and the line is in the manual steps', async (t) => {
  const { app, vercel, deps } = await setup(t, readyConfig);
  await legalFile(app.dir);
  const r = await stripeSetup({ appDir: app.dir, live: true }, deps({ secrets: { STRIPE_LIVE_SECRET_KEY: KEYS.live }, deps: { checkHealth: healthy } }));
  assert.ok(!vercel.set.some((e) => e.name === 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'));
  assert.match(r.manual[0], /STRIPE_LIVE_PUBLISHABLE_KEY is not in your keys file/);
  assert.match(r.manual[0], /pk_test_/);
  noLeak(r);
});

test('the refusal lists each missing thing once, in the error', async (t) => {
  const { app, deps } = await setup(t, { siteUrl: 'https://tea-shop.vercel.app' });
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    await assert.rejects(() => stripeSetup({ appDir: app.dir, live: true }, deps({ secrets: { STRIPE_LIVE_SECRET_KEY: KEYS.live }, deps: { checkHealth: async () => ({ ok: true, failures: [] }) } })), /Not ready for real payments yet/);
  } finally {
    process.stdout.write = original;
  }
  assert.ok(lines.length > 0, 'the steps are printed');
  assert.ok(!lines.some((l) => /own domain/.test(l)), 'the list is not also printed one by one');
});
