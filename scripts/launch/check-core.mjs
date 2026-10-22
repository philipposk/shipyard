// launch-check: the go-live gate. Runs the app's own checks (verify) and everything that has to be true before other
// people use it for real: legal pages, own domain, real emails, payments set up in Stripe, deletion, store apps.
// Every item ends as ok / warn / fail / skip with a plain next step. Nothing here crashes on a missing service: a
// service that is not set up is a failure with the command that fixes it.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as realVercel from '../lib/vercel.mjs';
import { readSecrets as realReadSecrets, parseEnv } from '../lib/secrets.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import { readAppConfig } from '../provision/common.mjs';
import { readEnvText } from '../provision/envfile.mjs';
import { CHECK_NAMES } from '../verify/index.mjs';
import { tally } from '../verify/format.mjs';
import { createStripe } from './stripe-api.mjs';
import { createResend } from './resend-api.mjs';
import { parseLegalFile } from './legal-core.mjs';
import { detectServices } from './legal-run.mjs';
import { readPlans } from './plans-parse.mjs';
import { loadServices, appUrlOf, isTestAddress, scrub } from './common.mjs';
import { loadStripeEvents } from './stripe-core.mjs';
import { checkWwwRedirect, wwwRedirectSteps } from './domain-core.mjs';
import { storeCheck } from '../shells/store-core.mjs';
import { agentName } from '../lib/agent.mjs';

const exists = (p) => stat(p).then(() => true, () => false);
const read = (p) => readFile(p, 'utf8').catch(() => '');

/** A check result. */
const R = (status, detail, fix) => ({ status, detail, ...(fix ? { fix } : {}) });

async function getPage(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'shipyard-launch-check' } });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } catch {
    return { status: 0, text: '' };
  }
}

/**
 * opts: { appDir, live, url }
 * deps: { fetch, readSecrets, vercel, run, profile, runVerify, storeCheck, stripe, resend }
 * Returns { ok, live, checks: [{ id, label, status, detail, fix? }], counts }
 */
export async function launchCheck(opts, deps = {}) {
  const { appDir } = opts;
  const live = Boolean(opts.live);
  const fetchImpl = deps.fetch ?? fetch;
  const profileApi = deps.profile ?? realProfile;
  const vercel = deps.vercel ?? realVercel;
  const run = deps.run ?? realRun;
  const readSecrets = deps.readSecrets ?? realReadSecrets;

  const config = await readAppConfig(appDir);
  const profile = await profileApi.loadProfile();
  const profileApp = (profile.apps ?? []).find((a) => a.slug === config.slug) ?? null;
  const modules = config.modules ?? [];
  const billing = modules.includes('billing');
  const newsletter = modules.includes('newsletter');
  const appUrl = opts.url ? new URL(opts.url).origin : appUrlOf(config, profileApp);
  const secrets = await readSecrets();
  const scope = profile.accounts?.vercel?.scope || undefined;
  const secretValues = [...secrets.values()];
  /** What a missing live-only item is: a failure when going live, a warning while trying things out. */
  const need = live ? 'fail' : 'warn';

  const checks = [];
  const add = async (id, label, fn) => {
    let r;
    try {
      r = await fn();
    } catch (err) {
      r = R('fail', `This check stopped by itself: ${scrub(err?.message ?? 'unknown error', secretValues).slice(0, 200)}`, `Run it again. If it keeps stopping, ask ${agentName()} to look at it.`);
    }
    checks.push({ id, label, ...r });
  };

  // ---- the app's own checks
  await add('verify', 'The app works (pages, sign-in, privacy rules, no leaked keys)', async () => {
    const ctx = {
      appDir,
      url: appUrl,
      app: { ...config, ...(profileApp ?? {}) },
      secrets: parseEnv(await readEnvText(path.join(appDir, '.env.local'))),
      log: { info() {}, ok() {}, fail() {}, warn() {} },
    };
    let results;
    if (deps.runVerify) results = await deps.runVerify(ctx);
    else {
      const { runChecks } = await import('../verify.mjs');
      results = await runChecks(ctx, CHECK_NAMES);
    }
    const t = tally(results);
    const failed = results.filter((c) => !c.ok);
    if (failed.length > 0) {
      return R('fail', `${failed.length} of the app's checks failed: ${failed.map((c) => `${c.name} (${(c.problems ?? [])[0] ?? c.summary})`).join('; ').slice(0, 400)}`, 'Run verify.mjs on the app to see every problem, fix them, then run this again.');
    }
    if (!appUrl) return R('warn', `The offline checks passed (${t.passed} ok, ${t.skipped} skipped). The app is not online yet, so its pages were not checked.`, 'Deploy the app (deploy.mjs), then run this again.');
    return R('ok', `${t.passed} checks passed${t.skipped ? `, ${t.skipped} skipped` : ''}.`);
  });

  // ---- legal pages
  let legal = null;
  try {
    legal = parseLegalFile(await read(path.join(appDir, 'src', 'lib', 'legal-content.ts')));
  } catch {
    legal = null;
  }
  await add('legal-controller', 'Privacy policy and terms say who runs the app', async () => {
    if (!legal) return R('fail', 'The legal pages have not been made yet.', 'Run legal-generate.mjs on the app.');
    const c = legal.controller ?? {};
    const empty = ['name', 'address', 'email', 'country'].filter((f) => !String(c[f] ?? '').trim());
    return empty.length > 0
      ? R('fail', `The legal pages are missing: ${empty.join(', ')}.`, 'Save your details with profile.mjs set company.<field> and run legal-generate.mjs again.')
      : R('ok', `The pages name ${c.name}.`);
  });
  await add('legal-services', 'The privacy policy lists every service the app uses', async () => {
    if (!legal) return R('skip', 'No legal pages yet.');
    const catalogue = await loadServices();
    const detected = await detectServices({ catalogue, config, appDir });
    const section = (legal.privacy ?? []).find((s) => s.id === 'who-processes-your-data');
    const listed = new Set((section?.table?.rows ?? []).map((r) => String(r[0]).toLowerCase()));
    const missing = detected.map((d) => d.service).filter((s) => !listed.has(s.name.toLowerCase()));
    return missing.length > 0
      ? R('fail', `The privacy policy does not mention: ${missing.map((s) => s.name).join(', ')}.`, 'Run legal-generate.mjs again.')
      : R('ok', `All ${detected.length} services are listed.`);
  });
  if (billing) {
    await add('legal-withdrawal', 'The terms cover subscriptions and the 14-day right to withdraw', async () => {
      if (!legal) return R('skip', 'No legal pages yet.');
      return (legal.terms ?? []).some((s) => s.id === 'right-to-withdraw')
        ? R('ok', 'The terms have the withdrawal section.')
        : R('fail', 'The terms were written before payments were added.', 'Run legal-generate.mjs again.');
    });
    await add('legal-phone', 'A phone number is given for customers', async () => {
      const has = Boolean(String(legal?.controller?.phone ?? '').trim());
      const saidNone = String(profile.company?.phone ?? '').trim().toLowerCase() === 'none';
      if (has || saidNone) return R('ok', has ? 'The terms give a phone number.' : 'You said you have no phone number.');
      return R(need, 'No phone number is given. Online shops in the EU have to give one if they have one.', 'Run: profile.mjs set company.phone "<number>" (or "none"), then legal-generate.mjs again.');
    });
    await add('withdraw-button', 'Customers can withdraw from the contract in the app', async () => {
      const route = await exists(path.join(appDir, 'src', 'app', 'api', 'billing', 'withdraw', 'route.ts'));
      const checkout = await read(path.join(appDir, 'src', 'app', 'api', 'billing', 'checkout', 'route.ts'));
      const problems = [];
      if (!route) problems.push('there is no "Withdraw from contract" button (src/app/api/billing/withdraw)');
      if (!checkout.includes('termsConsent')) problems.push('checkout does not show the "I agree and ask the service to start now" box');
      return problems.length > 0
        ? R(need, `The payments module is out of date: ${problems.join('; ')}.`, 'Update the payments module from the latest Shipyard, then deploy again.')
        : R('ok', 'The withdraw button and the checkout agreement box are there.');
    });
  }

  // ---- the live site
  await add('live-pages', 'The legal pages (and the pricing page) open on the live site', async () => {
    if (!appUrl) return R(need, 'The app is not online yet.', 'Deploy the app (deploy.mjs).');
    const paths = ['/privacy', '/terms', ...(billing ? ['/pricing'] : [])];
    const bad = [];
    for (const p of paths) {
      const r = await getPage(fetchImpl, `${appUrl}${p}`);
      if (r.status !== 200) bad.push(`${p} answered ${r.status || 'nothing'}`);
    }
    return bad.length > 0 ? R('fail', bad.join('; '), 'Deploy the latest version (deploy.mjs) and check the pages open.') : R('ok', `${paths.join(', ')} open.`);
  });
  await add('pwa', 'The app can be installed from the browser (manifest)', async () => {
    if (config.pwa === false) return R('skip', 'This app was made without install support.');
    if (!appUrl) return R('skip', 'The app is not online yet.');
    const r = await getPage(fetchImpl, `${appUrl}/manifest.webmanifest`);
    if (r.status !== 200) return R('fail', `The manifest answered ${r.status || 'nothing'}.`, 'Deploy again and check /manifest.webmanifest opens.');
    try {
      const m = JSON.parse(r.text);
      if (!m?.name || !Array.isArray(m.icons) || m.icons.length === 0) return R('fail', 'The manifest has no name or no icons.', 'Check src/app/manifest and the icons in public/.');
      return R('ok', 'The manifest has a name and icons.');
    } catch {
      return R('fail', 'The manifest is not valid JSON.', 'Check src/app/manifest.');
    }
  });
  await add('domain', 'The app is on your own domain', async () => {
    if (appUrl && !isTestAddress(appUrl)) return R('ok', `The app lives at ${appUrl}.`);
    return R(need, 'The app still uses a test address (vercel.app).', 'Buy a domain and run launch-domain.mjs.');
  });
  await add('www-redirect', 'The www address sends people to the main address', async () => {
    const www = config.launch?.domain?.www;
    const host = config.launch?.domain?.name;
    if (!www || !host) return R('skip', 'No www address was set up.');
    const r = await checkWwwRedirect({ www, host, fetch: fetchImpl });
    return r.ok
      ? R('ok', `${www} redirects to ${host}.`)
      : R('warn', `${www} still opens as a second copy of the site${r.status ? ` (it answered ${r.status})` : ''}.`, wwwRedirectSteps(www, host));
  });
  await add('signup-mode', 'Sign-ups need a confirmed email', async () => {
    return config.launch?.signupMode === 'verified'
      ? R('ok', 'New accounts must confirm their email.')
      : R(need, 'Anyone can sign up with any email address without confirming it.', 'Run launch-email.mjs with --switch-to-verified, then deploy.');
  });
  await add('email-domain', 'Real emails work (sending domain verified)', async () => {
    const sending = config.launch?.email?.sendingDomain;
    if (config.launch?.email?.verified !== true || !sending) {
      return R(need, 'No verified sending domain yet, so sign-up and password emails only reach you.', 'Run launch-email.mjs.');
    }
    const key = secrets.get('RESEND_API_KEY');
    if (!key) return R('ok', `${sending} was verified (not re-checked: no Resend key on this computer).`);
    try {
      const resend = deps.resend ?? createResend({ key, fetch: deps.fetch, sleep: deps.sleep });
      const d = await resend.findDomain(sending);
      if (!d) return R('fail', `Resend no longer has ${sending}.`, 'Run launch-email.mjs again.');
      return d.status === 'verified' ? R('ok', `${sending} is verified at Resend.`) : R('fail', `Resend says ${sending} is "${d.status}".`, 'Check the DNS records, then run launch-email.mjs --check.');
    } catch {
      return R('warn', `${sending} was verified earlier, but Resend could not be asked now.`, 'Check your internet connection and run this again.');
    }
  });
  if (newsletter) {
    await add('newsletter-consent', 'The email list only takes addresses that were confirmed', async () => {
      return config.launch?.signupMode === 'verified'
        ? R('ok', 'Sign-ups are confirmed, so a tick in the email list box belongs to the real owner of the address.')
        : R(need, 'The email list is closed until sign-ups need a confirmed email (nobody can be added with someone else\'s address).', 'Run launch-email.mjs with --switch-to-verified.');
    });
  }

  // ---- payments
  if (billing) {
    await add('vercel-plan', 'Vercel Pro is confirmed (the free plan is not for businesses)', async () => {
      return profile.accounts?.vercel?.plan === 'pro'
        ? R('ok', 'Vercel Pro is confirmed.')
        : R(need, 'Vercel Pro is not confirmed. The free Hobby plan is for non-commercial use only.', 'After upgrading, run: profile.mjs set accounts.vercel.plan pro');
    });
    await add('stripe', live ? 'Stripe (live): prices, webhook and portal exist' : 'Stripe (test): prices, webhook and portal exist', async () => {
      const keyName = live ? 'STRIPE_LIVE_SECRET_KEY' : 'STRIPE_SECRET_KEY';
      const key = secrets.get(keyName);
      if (!key) return R('fail', `${keyName} is not in your keys file.`, live ? 'Add the live key to your keys file, then run stripe-setup.mjs --live.' : 'Add your test key to your keys file, then run stripe-setup.mjs.');
      const stripe = deps.stripe ?? createStripe({ key, fetch: deps.fetch, sleep: deps.sleep });
      if (stripe.mode !== (live ? 'live' : 'test')) return R('fail', `${keyName} is a ${stripe.mode} key, but this check is for ${live ? 'live' : 'test'} mode.`, 'Put the right key in the right place in your keys file.');
      const plans = await readPlans(appDir, config.slug);
      const events = await loadStripeEvents();
      const problems = [];
      for (const p of plans.filter((x) => x.priceCents > 0)) {
        const found = ((await stripe.get('/prices', { lookup_keys: [p.lookupKey] })).data ?? []).find((x) => x.lookup_key === p.lookupKey);
        if (!found || found.active === false) problems.push(`no active price for ${p.name}`);
        else if (found.unit_amount !== p.priceCents) problems.push(`the price for ${p.name} in Stripe is not the one in plans.ts`);
      }
      const url = `${appUrl}/api/billing/webhook`;
      const endpoints = await stripe.listAll('/webhook_endpoints');
      const hook = endpoints.find((e) => e.url === url);
      if (!appUrl) problems.push('the app has no address for the webhook');
      else if (!hook) problems.push('Stripe does not know this site\'s webhook address');
      else {
        if (hook.status !== 'enabled') problems.push('the webhook is switched off');
        const listed = hook.enabled_events ?? [];
        const lacking = listed.includes('*') ? [] : events.filter((e) => !listed.includes(e));
        if (lacking.length > 0) problems.push(`the webhook misses ${lacking.length} event${lacking.length === 1 ? '' : 's'}`);
      }
      // An endpoint for this app at an old address (for example the vercel.app one) gets events the app can no longer check.
      const old = appUrl ? endpoints.filter((e) => e.metadata?.shipyard_app === config.slug && e.url !== url) : [];
      if (old.length > 0) problems.push(`Stripe still sends to ${old.length} old webhook address${old.length === 1 ? '' : 'es'} for this app (${old.map((e) => e.url).join(', ')}), which would fail`);
      // The portal must be this app's own, not another app's or one made by hand in the dashboard.
      const portals = await stripe.listAll('/billing_portal/configurations', { active: true });
      if (!portals.some((c) => c.metadata?.shipyard_app === config.slug)) problems.push('no customer portal for this app');
      if (problems.length === 0) {
        const env = await vercel.envLs({ cwd: appDir, scope, run });
        if (env.ok) {
          const names = new Set(env.envs.filter((e) => !live || e.targets.includes('production')).map((e) => e.name));
          const lacking = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((n) => !names.has(n));
          if (lacking.length > 0) problems.push(`Vercel does not have ${lacking.join(' and ')}`);
        } else {
          return R('warn', 'Stripe is set up, but Vercel could not be asked whether the app has its settings.', 'Log in to Vercel (setup) and run this again.');
        }
      }
      return problems.length > 0
        ? R('fail', `${problems.join('; ')}.`, live ? 'Run stripe-setup.mjs --live.' : 'Run stripe-setup.mjs.')
        : R('ok', `Prices, webhook and customer portal are set up in Stripe (${live ? 'live' : 'test'} mode).`);
    });
    // Stripe's API does not show the Terms link, so this can never pass or fail. It is a reminder, not a warning: a warning that
    // can never clear would keep the list from ever turning green. (stripe-setup prints the same step.)
    await add('stripe-terms-link', 'Stripe knows your Terms link (needed for the checkout agreement box)', async () => {
      return R('skip', `Shipyard cannot read this from Stripe, so check it by hand once: Stripe dashboard > Settings > Business > Public details, Terms link ${appUrl ?? 'your site'}/terms . If it is missing, checkout shows an error.`);
    });
  }

  // ---- account deletion, store apps
  await add('account-deletion', 'People can delete their own account', async () => {
    return (await exists(path.join(appDir, 'src', 'app', 'api', 'account', 'delete', 'route.ts')))
      ? R('ok', 'Account deletion is in the app.')
      : R('fail', 'The app has no account deletion (src/app/api/account/delete/route.ts).', 'Update the app to the newest template.');
  });
  if ((await exists(path.join(appDir, 'mobile'))) || (await exists(path.join(appDir, 'desktop')))) {
    await add('store-apps', 'The phone and desktop apps pass the store check', async () => {
      const r = await (deps.storeCheck ?? storeCheck)({ appDir, offline: !appUrl }, { fetch: deps.fetch, profile: profileApi });
      const bad = (r.checks ?? []).filter((c) => c.status === 'fail');
      return bad.length > 0
        ? R('fail', `${bad.length} store problem${bad.length === 1 ? '' : 's'}: ${bad.map((c) => c.message ?? c.id).join('; ').slice(0, 400)}`, 'Run store-check.mjs to see each one with its fix.')
        : R('ok', 'The store check passes.');
    });
  }

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] += 1;
  return { ok: counts.fail === 0, live, appUrl, checks, counts };
}
