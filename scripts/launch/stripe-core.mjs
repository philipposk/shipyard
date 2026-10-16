// stripe-setup: make the products, prices, customer portal and webhook in Stripe, and give the app what it needs.
//
// Two modes, two keys, never mixed:
//   test (default)  reads STRIPE_SECRET_KEY, which must be a test key (sk_test_ or rk_test_).
//   --live          reads STRIPE_LIVE_SECRET_KEY, which must be a live key (sk_live_ or rk_live_), and refuses to start
//                   (before it makes anything in the live Stripe account) until the go-live list is complete. The list
//                   itself runs launch-check, which only reads, using the test key (and Resend if email is set up).
// Secrets: the keys are read and used for the calls, never printed. The webhook signing secret exists only in the answer
// to "create webhook"; it goes straight into Vercel and is not returned, logged or written anywhere else.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as realVercel from '../lib/vercel.mjs';
import { readSecrets as realReadSecrets } from '../lib/secrets.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { PLUGIN_ROOT } from '../lib/paths.mjs';
import { ProvisionError, readAppConfig } from '../provision/common.mjs';
import { updateEnvFile } from '../provision/envfile.mjs';
import { createStripe } from './stripe-api.mjs';
import { readPlans } from './plans-parse.mjs';
import { parseLegalFile } from './legal-core.mjs';
import { recordLaunch, addEnvNames, appUrlOf, isTestAddress, scrub } from './common.mjs';

export const LEGAL_FILE = path.join('src', 'lib', 'legal-content.ts');
const TEST_PREFIXES = ['sk_test_', 'rk_test_'];
const LIVE_PREFIXES = ['sk_live_', 'rk_live_'];

/** The events the app's webhook handles, from the billing module (so the two can never drift apart). */
export async function loadStripeEvents(file = path.join(PLUGIN_ROOT, 'modules', 'billing', 'module.json')) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const events = manifest.stripeEvents;
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string')) {
    throw new ProvisionError('The billing module does not list the Stripe events it needs. Reinstall Shipyard.');
  }
  return [...events];
}

/** Which key to use for this mode, and a plain refusal for the wrong kind. Never includes the key in a message. */
export function pickKey({ live, secrets }) {
  const name = live ? 'STRIPE_LIVE_SECRET_KEY' : 'STRIPE_SECRET_KEY';
  const key = secrets.get(name);
  if (!key) {
    throw new ProvisionError(live
      ? 'STRIPE_LIVE_SECRET_KEY is not in your Shipyard keys file. Stripe dashboard with Test mode OFF > Developers > API keys > Secret key (starts with sk_live_). Paste it into the keys file yourself, never into the chat.'
      : 'STRIPE_SECRET_KEY is not in your Shipyard keys file. Stripe dashboard in Test mode > Developers > API keys > Secret key (starts with sk_test_). Paste it into the keys file yourself, never into the chat.');
  }
  const prefixes = live ? LIVE_PREFIXES : TEST_PREFIXES;
  if (!prefixes.some((p) => key.startsWith(p))) {
    const looksLive = LIVE_PREFIXES.some((p) => key.startsWith(p));
    const looksTest = TEST_PREFIXES.some((p) => key.startsWith(p));
    if (!live && looksLive) {
      throw new ProvisionError('STRIPE_SECRET_KEY holds a live key (real money). Test mode only accepts a test key (sk_test_). Put the live key in STRIPE_LIVE_SECRET_KEY and a test key here. Nothing was sent to Stripe.', { reason: 'wrong-key-mode' });
    }
    if (live && looksTest) {
      throw new ProvisionError('STRIPE_LIVE_SECRET_KEY holds a test key. Live mode needs the live key (sk_live_, from the Stripe dashboard with Test mode switched off). Nothing was sent to Stripe.', { reason: 'wrong-key-mode' });
    }
    throw new ProvisionError(`${name} does not look like a Stripe secret key (it should start with ${prefixes[0]}). Copy it again from the Stripe dashboard. Nothing was sent to Stripe.`, { reason: 'wrong-key-mode' });
  }
  return { name, key };
}

/**
 * Everything that must be true before real money is taken. Pure: facts in, a plain list of what is missing out.
 * facts: { appUrl, legal (parsed legal-content or null), plans, signupMode, vercelPlan, testSetupAt, health: { ok, failures[] } | null }
 */
export function livePreflight(facts) {
  const problems = [];
  if (!facts.appUrl || isTestAddress(facts.appUrl)) {
    problems.push('The app is not on your own domain yet. Real payments need your own address (not a vercel.app one). Run launch-domain.mjs first.');
  }
  const c = facts.legal?.controller;
  const empty = ['name', 'address', 'email', 'country'].filter((f) => !String(c?.[f] ?? '').trim());
  if (!facts.legal) problems.push('The legal pages have not been made yet. Run legal-generate.mjs first.');
  else if (empty.length > 0) problems.push(`The legal pages are missing who runs the app (${empty.join(', ')}). Fill your details with profile.mjs and run legal-generate.mjs again.`);
  else if (!(facts.legal.terms ?? []).some((s) => s?.id === 'right-to-withdraw')) {
    problems.push('The terms were written before payments were added: they have no subscription or withdrawal text. Run legal-generate.mjs again.');
  }
  if (facts.signupMode !== 'verified') {
    problems.push('Sign-ups do not need a confirmed email yet. Run launch-email.mjs with --switch-to-verified and deploy, so every paying customer has a real email address.');
  }
  if (facts.vercelPlan !== 'pro') {
    problems.push('Vercel Pro is not confirmed. Vercel\'s free Hobby plan is for non-commercial use only, so an app that takes money needs Pro. Once you have it, save it with: profile.mjs set accounts.vercel.plan pro');
  }
  if (!facts.testSetupAt) {
    problems.push('Payments have not been tried in test mode yet. Run stripe-setup.mjs (without --live) and make a test purchase first.');
  }
  if (!facts.health) problems.push('The go-live check has not been run. Run launch-check.mjs on this app first.');
  else if (!facts.health.ok) {
    problems.push(`The go-live check is not passing yet (${facts.health.failures.slice(0, 5).join('; ')}${facts.health.failures.length > 5 ? '; ...' : ''}). Run launch-check.mjs to see them all.`);
  }
  return problems;
}

/** Sort and compare two lists of event names. */
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Which Vercel environments the payment values go to. After go-live, test values never touch production. */
export function targetsFor({ live, paymentsLive }) {
  if (live) return ['production'];
  return paymentsLive ? ['development'] : ['production', 'development'];
}

async function ensurePrices({ stripe, plans, slug, appName, log: say }) {
  const out = [];
  const paid = plans.filter((p) => p.priceCents > 0);
  for (const plan of paid) {
    const currency = plan.currency.toLowerCase();
    const matching = (await stripe.get('/prices', { lookup_keys: [plan.lookupKey] })).data ?? [];
    const existing = matching.find((p) => p.lookup_key === plan.lookupKey) ?? null;
    let productId = existing ? (typeof existing.product === 'string' ? existing.product : existing.product?.id) : null;
    const productName = `${appName} ${plan.name}`.slice(0, 250);

    if (!productId) {
      const products = await stripe.listAll('/products', { active: true });
      const mine = products.find((p) => p.metadata?.shipyard_app === slug && p.metadata?.shipyard_plan === plan.id);
      if (mine) productId = mine.id;
    }
    let productAction = 'unchanged';
    if (!productId) {
      const product = await stripe.post('/products', { name: productName, metadata: { shipyard_app: slug, shipyard_plan: plan.id } });
      productId = product.id;
      productAction = 'created';
    } else {
      const product = await stripe.get(`/products/${productId}`);
      if (product.name !== productName || product.active === false) {
        await stripe.post(`/products/${productId}`, { name: productName, active: true, metadata: { shipyard_app: slug, shipyard_plan: plan.id } });
        productAction = 'updated';
      }
    }

    const same = existing && existing.active !== false
      && existing.unit_amount === plan.priceCents
      && String(existing.currency).toLowerCase() === currency
      && existing.recurring?.interval === plan.interval
      && (existing.recurring?.interval_count ?? 1) === 1;
    let price = existing;
    let priceAction = 'unchanged';
    if (!same) {
      // Prices can not be edited. A changed amount makes a new price and moves the lookup key to it, so the app finds
      // the new one by the same name. People already subscribed keep the old price until they change plan.
      price = await stripe.post('/prices', {
        product: productId,
        unit_amount: plan.priceCents,
        currency,
        recurring: { interval: plan.interval },
        lookup_key: plan.lookupKey,
        transfer_lookup_key: true,
        metadata: { shipyard_app: slug, shipyard_plan: plan.id },
      });
      priceAction = existing ? 'new-price' : 'created';
    }
    say(`${plan.name}: product ${productAction}, price ${priceAction} (${plan.lookupKey}).`);
    out.push({ planId: plan.id, name: plan.name, lookupKey: plan.lookupKey, productId, priceId: price.id, productAction, priceAction });
  }
  return out;
}

async function ensurePortal({ stripe, slug, appName, appUrl, products }) {
  const byProduct = new Map();
  for (const p of products) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p.priceId]);
  const canSwitch = products.length > 1;
  const params = {
    business_profile: {
      headline: `Manage your ${appName} subscription`.slice(0, 255),
      privacy_policy_url: `${appUrl}/privacy`,
      terms_of_service_url: `${appUrl}/terms`,
    },
    default_return_url: `${appUrl}/settings/billing`,
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: false } },
      subscription_update: canSwitch
        ? {
          enabled: true,
          default_allowed_updates: ['price'],
          proration_behavior: 'create_prorations',
          products: [...byProduct].map(([product, prices]) => ({ product, prices })),
        }
        : { enabled: false },
    },
    metadata: { shipyard_app: slug },
  };
  const all = await stripe.listAll('/billing_portal/configurations', { active: true });
  const mine = all.find((c) => c.metadata?.shipyard_app === slug);
  if (mine) {
    await stripe.post(`/billing_portal/configurations/${mine.id}`, params);
    return { id: mine.id, action: 'updated' };
  }
  const made = await stripe.post('/billing_portal/configurations', params);
  return { id: made.id, action: 'created' };
}

/**
 * The webhook. Returns { id, action, secret?, created, removed } where `secret` is set only when the endpoint was just created.
 * The caller must put the secret into Vercel and let go of it.
 *
 * The endpoint is found by the tag `shipyard_app=<slug>` first (so a new address, for example after launch-domain, moves the
 * same endpoint instead of leaving the old one behind to fail), and by its exact address as a fallback. Moving it keeps the
 * signing secret, so the app needs nothing new. Extra endpoints tagged for this app are removed.
 */
async function ensureWebhook({ stripe, url, events, slug, secretKnown }) {
  const endpoints = await stripe.listAll('/webhook_endpoints');
  const tagged = endpoints.filter((e) => e.metadata?.shipyard_app === slug);
  const mine = tagged.find((e) => e.url === url) ?? endpoints.find((e) => e.url === url) ?? tagged[0] ?? null;
  const extras = tagged.filter((e) => mine && e.id !== mine.id);
  const create = async () => {
    const made = await stripe.post('/webhook_endpoints', {
      url,
      enabled_events: events,
      description: `Shipyard: ${slug}`,
      metadata: { shipyard_app: slug },
    });
    return { id: made.id, secret: made.secret, created: true };
  };
  const dropExtras = async () => {
    for (const extra of extras) await stripe.del(`/webhook_endpoints/${extra.id}`);
    return extras.length;
  };
  if (!mine) return { ...(await create()), action: 'created', removed: 0 };
  // The signing secret can be read only when the endpoint is made. If the app does not have it (a fresh Vercel project, a
  // lost value), the only way to get one is to make the endpoint again.
  if (secretKnown === false) {
    await stripe.del(`/webhook_endpoints/${mine.id}`);
    const made = await create();
    return { ...made, action: 'recreated', removed: await dropExtras() };
  }
  const listed = Array.isArray(mine.enabled_events) ? mine.enabled_events : [];
  const moved = mine.url !== url;
  if (moved || !sameSet(listed, events) || mine.status !== 'enabled' || mine.metadata?.shipyard_app !== slug) {
    await stripe.post(`/webhook_endpoints/${mine.id}`, { url, enabled_events: events, disabled: false, metadata: { shipyard_app: slug } });
    return { id: mine.id, action: moved ? 'moved' : 'updated', created: false, removed: await dropExtras() };
  }
  return { id: mine.id, action: 'unchanged', created: false, removed: await dropExtras() };
}

/**
 * opts: { appDir, live }
 * deps: { readSecrets, fetch, sleep, run, vercel, profile, stripe, checkHealth, events, now }
 */
export async function stripeSetup(opts, deps = {}) {
  const { appDir } = opts;
  const live = Boolean(opts.live);
  const run = deps.run ?? realRun;
  const vercel = deps.vercel ?? realVercel;
  const profileApi = deps.profile ?? realProfile;
  const readSecrets = deps.readSecrets ?? realReadSecrets;
  const total = live ? 5 : 4;

  const config = await readAppConfig(appDir);
  if (!(config.modules ?? []).includes('billing')) {
    throw new ProvisionError('This app does not have the payments module yet. Add it first: node add-module.mjs <app-folder> billing');
  }
  const profile = await profileApi.loadProfile();
  const profileApp = (profile.apps ?? []).find((a) => a.slug === config.slug) ?? null;
  const scope = profile.accounts?.vercel?.scope || undefined;
  const slug = config.slug;
  const appName = config.name || slug;
  const appUrl = appUrlOf(config, profileApp);

  // ---- keys: the right kind for the mode, checked before anything else
  const secrets = await readSecrets();
  const { key } = pickKey({ live, secrets });
  const secretValues = [key];
  const paymentsLive = config.launch?.billing?.mode === 'live';

  // ---- go-live list: before any call to Stripe
  if (live) {
    log.step(1, total, 'Checking the go-live list');
    let legal = null;
    try {
      legal = parseLegalFile(await readFile(path.join(appDir, LEGAL_FILE), 'utf8'));
    } catch {
      legal = null;
    }
    let health = null;
    const checkHealth = deps.checkHealth ?? (async () => {
      const { launchCheck } = await import('./check-core.mjs');
      const r = await launchCheck({ appDir, live: false }, { profile: profileApi });
      return { ok: r.ok, failures: r.checks.filter((c) => c.status === 'fail').map((c) => c.label) };
    });
    try {
      health = await checkHealth(appDir);
    } catch (err) {
      health = { ok: false, failures: [`the check itself stopped: ${scrub(err.message, secretValues)}`] };
    }
    const problems = livePreflight({
      appUrl,
      legal,
      signupMode: config.launch?.signupMode ?? 'starter',
      vercelPlan: profile.accounts?.vercel?.plan,
      testSetupAt: config.launch?.billing?.testSetupAt,
      health,
    });
    if (problems.length > 0) {
      throw new ProvisionError(
        `Not ready for real payments yet. ${problems.length === 1 ? 'One thing is' : `${problems.length} things are`} missing:\n${problems.map((p) => `  - ${p}`).join('\n')}\nNothing was made in your live Stripe account.`,
        { reason: 'preflight', problems },
      );
    }
    log.ok('Everything on the go-live list is done.');
  }

  if (!appUrl || !/^https:\/\//.test(appUrl) || /^https:\/\/(?:localhost|127\.)/.test(appUrl)) {
    throw new ProvisionError('The app has no public https address yet, so Stripe has nowhere to send payment messages. Deploy first (deploy.mjs), then run this again.', { reason: 'no-url' });
  }
  if (!config.vercelProject && !profileApp?.vercelProject) {
    throw new ProvisionError('This app has no Vercel project yet. Run provision-vercel.mjs on the app folder first.');
  }

  const stripe = deps.stripe ?? createStripe({ key, fetch: deps.fetch, sleep: deps.sleep });
  if (stripe.mode !== (live ? 'live' : 'test')) {
    throw new ProvisionError(`This Stripe key is for ${stripe.mode} mode, but you asked for ${live ? 'live' : 'test'} mode. Nothing was sent to Stripe.`, { reason: 'wrong-key-mode' });
  }
  const plans = await readPlans(appDir, slug);
  if (!plans.some((p) => p.priceCents > 0)) {
    throw new ProvisionError('plans.ts has no paid plan, so there is nothing to set up in Stripe. Add a paid plan to src/lib/billing/plans.ts first.');
  }
  const events = deps.events ?? await loadStripeEvents();
  const webhookUrl = `${appUrl}/api/billing/webhook`;
  const say = (m) => log.ok(m);
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err?.name === 'ApiError') throw new ProvisionError(scrub(err.message, secretValues), { reason: 'stripe' });
      throw err;
    }
  };

  const n = live ? 2 : 1;
  log.step(n, total, `Products and prices in Stripe (${live ? 'live' : 'test'} mode)`);
  const products = await guard(() => ensurePrices({ stripe, plans, slug, appName, log: say }));

  log.step(n + 1, total, 'The customer portal (cancel, update card, invoices)');
  const portal = await guard(() => ensurePortal({ stripe, slug, appName, appUrl, products }));
  say(`Customer portal ${portal.action}.`);

  log.step(n + 2, total, `The webhook at ${webhookUrl}`);
  const targets = targetsFor({ live, paymentsLive });
  const wantsSecretOnVercel = live || !paymentsLive;
  let secretKnown;
  if (wantsSecretOnVercel) {
    const listed = await vercel.envLs({ cwd: appDir, scope, run });
    if (listed.ok) {
      // Vercel keeps one record per environment, so the list has a row for each. Put them together.
      const have = listed.envs.filter((e) => e.name === 'STRIPE_WEBHOOK_SECRET').flatMap((e) => e.targets);
      secretKnown = targets.every((t) => have.includes(t));
    }
  }
  const webhook = await guard(() => ensureWebhook({ stripe, url: webhookUrl, events, slug, secretKnown }));
  say(`Webhook ${webhook.action}.`);
  if (webhook.removed > 0) say(`Removed ${webhook.removed} old webhook${webhook.removed === 1 ? '' : 's'} for this app, so Stripe stops sending to the old address.`);

  log.step(n + 3, total, 'Giving the app its Stripe settings on Vercel');
  const pushed = [];
  const failures = [];
  const push = async (name, value) => {
    const r = await vercel.envAdd({ cwd: appDir, name, value, target: targets, scope, run });
    if (r.ok) pushed.push(name);
    else failures.push(`${name}: ${scrub(r.error, [...secretValues, value])}`);
    return r.ok;
  };
  if (webhook.created) {
    const secret = webhook.secret;
    secretValues.push(secret);
    if (wantsSecretOnVercel) {
      const stored = await push('STRIPE_WEBHOOK_SECRET', secret);
      if (!stored) {
        // The value is lost the moment this function ends. Remove the endpoint so the next run can make it again.
        await guard(() => stripe.del(`/webhook_endpoints/${webhook.id}`)).catch(() => {});
        throw new ProvisionError(`Vercel did not accept the webhook secret (${failures.join('; ')}). The webhook was removed so you can run this again.`, { reason: 'vercel', pushed });
      }
    } else {
      log.warn('Payments are live, so the test webhook secret was not put on production. It stays unused.');
    }
    webhook.secret = undefined;
  }
  // `targets` already keeps test values off production once payments are live.
  await push('STRIPE_SECRET_KEY', key);
  // The app finds its prices by lookup key (plans.ts), so price ids are not pushed: only the keys and the portal are.
  const pkName = live ? 'STRIPE_LIVE_PUBLISHABLE_KEY' : 'STRIPE_PUBLISHABLE_KEY';
  const pk = secrets.get(pkName);
  const manualWarnings = [];
  if (pk) await push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', pk);
  else if (live) {
    const m = `${pkName} is not in your keys file, so production still has the test publishable key (pk_test_) next to your live secret key. Add ${pkName} to your keys file (Stripe dashboard with Test mode off > Developers > API keys > Publishable key) and run this again.`;
    log.warn(m);
    manualWarnings.push(m);
  } else {
    log.warn(`${pkName} is not in your keys file, so NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY was not set. Add it if your code uses Stripe in the browser (the default app does not).`);
  }
  await push('STRIPE_PORTAL_CONFIGURATION', portal.id);
  if (failures.length > 0) {
    throw new ProvisionError(`Stripe is ready, but Vercel did not accept ${failures.length} setting${failures.length === 1 ? '' : 's'}: ${failures.join('; ')}. Run provision-vercel.mjs, then this again.`, { reason: 'vercel', pushed });
  }
  log.ok(`${pushed.length} settings are on Vercel (${targets.join(' and ')}).`);

  if (!live) await updateEnvFile(path.join(appDir, '.env.local'), { STRIPE_PORTAL_CONFIGURATION: portal.id });
  await addEnvNames(appDir, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_PORTAL_CONFIGURATION']);

  const now = (deps.now ? deps.now() : new Date()).toISOString();
  const prices = Object.fromEntries(products.map((p) => [p.lookupKey, p.priceId]));
  const record = live
    ? { mode: 'live', liveSetupAt: now, webhookUrl, prices, portalId: portal.id }
    : { ...(paymentsLive ? {} : { mode: 'test' }), testSetupAt: now, ...(paymentsLive ? {} : { webhookUrl, prices, portalId: portal.id }) };
  await recordLaunch(appDir, { billing: record }, { profile: profileApi });
  try {
    const saved = await profileApi.loadProfile();
    saved.accounts = { ...(saved.accounts ?? {}), stripe: { ...(saved.accounts?.stripe ?? {}), ok: true, mode: live ? 'live' : (paymentsLive ? 'live' : 'test') } };
    await profileApi.saveProfile(saved);
  } catch {
    // convenience copy only
  }

  const manual = [
    ...manualWarnings,
    `In the Stripe dashboard (${live ? 'with Test mode off' : 'in Test mode'}) go to Settings > Business > Public details and add your Terms link: ${appUrl}/terms . The "I agree" box at checkout needs it, and checkout shows a message until it is there.`,
  ];
  if (live) {
    manual.push('Do a real purchase of your cheapest plan with your own card, check the plan shows in Settings > Billing, then refund it in the Stripe dashboard (Payments, open it, Refund). Then run launch-check.mjs --live.');
  } else {
    manual.push('Try a purchase with the test card 4242 4242 4242 4242 (any future date, any 3 digits, any postcode), then open the admin Health page.');
  }
  return {
    ok: true,
    mode: live ? 'live' : 'test',
    appUrl,
    products: products.map(({ planId, name, lookupKey, productId, priceId, productAction, priceAction }) => ({ planId, name, lookupKey, productId, priceId, productAction, priceAction })),
    portal,
    webhook: { id: webhook.id, url: webhookUrl, action: webhook.action, removed: webhook.removed ?? 0, events },
    vercel: { environments: targets, set: pushed },
    manual,
    next: live ? 'Deploy again (deploy.mjs) so the app starts with the live settings, then do the real test purchase.' : 'Deploy again (deploy.mjs) so the app has the new settings, then try a test purchase.',
  };
}
