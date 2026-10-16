// launch-domain: put the app on the student's own domain.
import { domainToASCII } from 'node:url';
import * as realVercel from '../lib/vercel.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { ProvisionError, readAppConfig, updateAppConfig } from '../provision/common.mjs';
import { setAuthUrlsForApp } from '../provision/supabase-core.mjs';
import { addRedirects as addAuthRedirects } from '../shells/supabase.mjs';
import { checkSite } from '../provision/deploy-core.mjs';
import { domainsAdd, domainsVerify } from './vercel-domains.mjs';
import { defaultResolvers, checkDns, answeredByVercel } from './dns.mjs';
import { recordLaunch, sleepMs, isTestAddress } from './common.mjs';

// Two-part endings where the registered name has three labels (example.co.uk). Not a full public-suffix list:
// it only decides whether to also set up "www". --no-www overrides.
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'com.gr', 'gov.gr', 'edu.gr',
  'co.jp', 'co.in', 'com.tr', 'com.mx', 'com.ar', 'co.il', 'com.cn', 'com.sg', 'com.hk', 'com.tw', 'co.kr', 'com.pl', 'com.pt', 'com.es',
]);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** "https://WWW.Example.com/" -> "www.example.com". Throws a plain-English error for anything that is not a domain name. */
export function normalizeDomain(input) {
  let text = String(input ?? '').trim().toLowerCase();
  if (!text) throw new ProvisionError('Give the domain, for example: node launch-domain.mjs ./my-app example.com');
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (/@|\s|:/.test(text)) throw new ProvisionError(`"${input}" is not a domain name. Use just the name, for example example.com (no https://, no port, no email address).`);
  const ascii = domainToASCII(text);
  if (!ascii) throw new ProvisionError(`"${input}" is not a valid domain name.`);
  const labels = ascii.split('.');
  if (labels.length < 2 || ascii.length > 253 || !labels.every((l) => LABEL.test(l))) {
    throw new ProvisionError(`"${input}" is not a valid domain name. It needs at least two parts, like example.com, made of letters, numbers and dashes.`);
  }
  const tld = labels.at(-1);
  if (!(/^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld))) throw new ProvisionError(`"${input}" does not end in a real domain ending like .com or .gr.`);
  if (/^\d+$/.test(labels.join(''))) throw new ProvisionError('Use a domain name, not an IP address.');
  if (ascii.endsWith('.vercel.app') || ascii.endsWith('.localhost') || ascii === 'localhost') {
    throw new ProvisionError('That is a test address, not your own domain. Use a domain you bought, for example example.com.');
  }
  return ascii;
}

/** Is this the plain domain (example.com, example.co.uk) as opposed to a subdomain like app.example.com? */
export function isApexDomain(host) {
  const labels = host.split('.');
  if (labels.length === 2) return true;
  return labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join('.'));
}

/** Records to show when Vercel's own answer could not be read. These are the long-standing Vercel values. */
export function fallbackRecords(host) {
  if (isApexDomain(host)) return [{ type: 'A', name: '@', value: '76.76.21.21' }];
  const label = host.split('.').slice(0, -2).join('.');
  return [{ type: 'CNAME', name: label, value: 'cname.vercel-dns.com' }];
}

/**
 * Does https://www.<host> answer with a redirect to https://<host>? Vercel serves a second host as a second copy of the
 * site unless it is told to redirect, and a second copy splits sign-in sessions and looks like duplicate pages to search engines.
 * -> { ok, status, location }
 */
export async function checkWwwRedirect({ www, host, fetch: doFetch = fetch }) {
  try {
    const res = await doFetch(`https://${www}/`, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'shipyard-domain-check' } });
    const location = String(res.headers?.get?.('location') ?? '');
    let target = '';
    try {
      target = location ? new URL(location, `https://${www}/`).hostname : '';
    } catch {
      target = '';
    }
    const redirect = [301, 302, 307, 308].includes(res.status);
    return { ok: redirect && target === host, status: res.status, location };
  } catch {
    return { ok: false, status: 0, location: '' };
  }
}

export const wwwRedirectSteps = (www, host) => `In the Vercel dashboard open your project > Settings > Domains, press Edit next to ${www}, choose "Redirect to Another Domain", pick ${host}, set the status to 308 and save.`;

/** A copy-paste table, one line per record. */
export function formatRecordTable(rows) {
  const head = ['Type', 'Name', 'Value'];
  const lines = rows.map((r) => [r.type, r.name, r.value]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...lines.map(fmt)];
}

/**
 * opts: { appDir, domain, check, timeoutMin, www (default true), intervalSec }
 * deps: { run, vercel, resolvers, fetch, sleep, profile, setAuthUrls, add, verify }
 */
export async function launchDomain(opts, deps = {}) {
  const { appDir } = opts;
  const run = deps.run ?? realRun;
  const vercel = deps.vercel ?? realVercel;
  const profileApi = deps.profile ?? realProfile;
  const sleep = deps.sleep ?? sleepMs;
  const add = deps.add ?? domainsAdd;
  const verify = deps.verify ?? domainsVerify;
  const setAuthUrls = deps.setAuthUrls ?? ((o) => setAuthUrlsForApp(o, deps.supabase ?? {}));
  const total = opts.check ? 5 : 3;

  let host = normalizeDomain(opts.domain);
  const typedWww = host.startsWith('www.') && isApexDomain(host.slice(4));
  if (typedWww) host = host.slice(4);
  const apex = isApexDomain(host);
  const wantWww = apex && opts.www !== false;
  const www = `www.${host}`;

  const config = await readAppConfig(appDir);
  const profile = await profileApi.loadProfile();
  const scope = profile.accounts?.vercel?.scope || undefined;
  const project = config.vercelProject || (profile.apps ?? []).find((a) => a.slug === config.slug)?.vercelProject;
  if (!project) throw new ProvisionError('This app has no Vercel project yet. Run provision-vercel.mjs on the app folder first.');
  if (!config.siteUrl && !config.url) {
    log.warn('The app has not been deployed yet. The domain can still be set up; deploy before you check it.');
  }

  log.step(1, total, `Adding ${host}${wantWww ? ` and ${www}` : ''} to the Vercel project "${project}"`);
  const hosts = wantWww ? [host, www] : [host];
  const added = [];
  for (const h of hosts) {
    const r = await add({ cwd: appDir, domain: h, project, scope, run });
    if (!r.ok) throw new ProvisionError(`Vercel did not accept ${h}. ${r.error}`, { reason: r.needsVerification ? 'needs-verification' : 'vercel', domain: h });
    added.push({ host: h, already: Boolean(r.already) });
    log.ok(r.already ? `${h} was already added.` : `${h} added.`);
  }

  log.step(2, total, 'Asking Vercel which DNS records you need');
  const expected = new Map();
  let usedDefaults = false;
  let alreadyConfigured = true;
  for (const h of hosts) {
    const v = await verify({ cwd: appDir, domain: h, project, scope, run });
    let records = v.records;
    if (!v.parsed || records.length === 0) {
      if (!v.ok) {
        records = h === host ? fallbackRecords(h) : [{ type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }];
        usedDefaults = true;
      }
    }
    expected.set(h, { records, nameservers: v.nameservers, conflicts: v.conflicts, ok: v.ok });
    if (!v.ok) alreadyConfigured = false;
  }
  const table = [];
  for (const h of hosts) {
    for (const r of expected.get(h).records) {
      // Vercel gives names relative to the domain ("@", "www"); keep them. Records for the www host named "@" mean "www".
      table.push({ host: h, type: r.type, name: h === www && (r.name === '@' || r.name === '') ? 'www' : r.name, value: r.value });
    }
  }
  const conflicts = hosts.flatMap((h) => expected.get(h).conflicts.map((c) => ({ host: h, conflict: c })));
  if (alreadyConfigured) log.ok('The DNS records for this domain are already right.');
  else {
    log.info('Add these records where you bought the domain (its DNS settings):');
    for (const line of formatRecordTable(table)) log.info(line);
    log.info('Name: type it exactly as shown. "@" means the domain itself. Some registrars add the domain name for you, so do not type it twice.');
    log.info('If the registrar already has an A or CNAME record for the same name, replace it.');
    log.info('At Cloudflare: set each record to "DNS only" (the grey cloud, not the orange one). The orange cloud hides the address Vercel needs to see.');
    if (usedDefaults) log.warn('These are the standard Vercel values. Vercel\'s project page (Settings > Domains) may show different, project-specific values: those work too.');
    if (conflicts.length > 0) log.warn(`Vercel sees records that clash with these: remove them at your registrar first (${conflicts.length}).`);
  }

  const result = {
    ok: true,
    domain: host,
    www: wantWww ? www : null,
    project,
    records: table,
    recordsFromVercel: !usedDefaults,
    dnsReady: false,
    live: false,
    next: '',
  };

  if (!opts.check) {
    result.next = alreadyConfigured
      ? 'Run this again with --check to finish the setup.'
      : 'Add the records above, then run this again with --check. It waits until the domain works (up to 10 minutes).';
    return result;
  }

  // ---- wait for DNS and HTTPS
  const intervalMs = (opts.intervalSec ?? 15) * 1000;
  const tries = Math.max(1, Math.ceil(((opts.timeoutMin ?? 10) * 60_000) / intervalMs));
  const resolvers = deps.resolvers ?? defaultResolvers();
  log.step(3, total, 'Waiting for the domain to work (DNS first, then the secure https certificate)');
  let dnsOk = false;
  let httpsOk = false;
  let lastDns = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const checks = [];
    for (const h of hosts) {
      let c = await checkDns(resolvers, h, expected.get(h));
      if (!c.ok) {
        // The address lists can look wrong while the site works (a flattened apex CNAME, Cloudflare's proxy). Ask the site itself.
        const answer = await answeredByVercel(h, { fetch: deps.fetch });
        if (answer.ok) c = { ...c, ok: true, viaVercel: true };
      }
      checks.push([h, c]);
    }
    lastDns = checks;
    dnsOk = checks.every(([, c]) => c.ok);
    if (dnsOk) {
      const site = await checkSite(`https://${host}`, { fetch: deps.fetch, sleep, tries: 1, delayMs: 0 });
      httpsOk = site.ok;
      if (httpsOk) break;
      log.info(`Attempt ${attempt}/${tries}: DNS is right, waiting for the https certificate...`);
    } else {
      const bad = checks.filter(([, c]) => !c.ok).map(([h]) => h).join(', ');
      log.info(`Attempt ${attempt}/${tries}: DNS is not right yet for ${bad}.`);
    }
    if (attempt < tries) await sleep(intervalMs);
  }
  result.dnsReady = dnsOk;
  if (!httpsOk) {
    const why = dnsOk
      ? 'The DNS records are right, but https is not ready yet. Vercel issues the certificate after DNS works; it can take a few more minutes.'
      : 'The DNS records are not visible yet. Changes can take from a few minutes to a few hours to spread. At Cloudflare, set the record to "DNS only" (grey cloud).';
    const detail = !dnsOk && lastDns ? lastDns.flatMap(([h, c]) => c.perResolver.filter((p) => !p.ok).map((p) => `${h} at ${p.resolver}: ${p.found.length ? `sees ${p.found.join(', ')}` : 'sees nothing'}`)).join('; ') : '';
    throw new ProvisionError(`${why}${detail ? ` (${detail})` : ''} Check the records and run this again with --check.`, { reason: dnsOk ? 'waiting-for-certificate' : 'waiting-for-dns', domain: host, records: table, dnsReady: dnsOk });
  }
  log.ok(`https://${host} opens.`);

  // ---- switch the app over
  const url = `https://${host}`;
  log.step(4, total, 'Telling the app its new address');
  const set = await vercel.envAdd({ cwd: appDir, name: 'NEXT_PUBLIC_SITE_URL', value: url, target: ['production'], scope, run });
  const warnings = [];
  if (!set.ok) {
    throw new ProvisionError(`The domain works, but Vercel did not accept the new NEXT_PUBLIC_SITE_URL (${set.error}). Run this again with --check.`, { reason: 'env' });
  }
  log.ok('NEXT_PUBLIC_SITE_URL updated on Vercel (production).');
  await updateAppConfig(appDir, { url, siteUrl: url });
  await recordLaunch(appDir, { domain: { name: host, url, www: wantWww ? www : null, verifiedAt: (deps.now ? deps.now() : new Date()).toISOString() } }, { profile: profileApi });
  const saved = await profileApi.loadProfile();
  saved.domain = { ...(saved.domain ?? {}), choice: 'own', name: host };
  await profileApi.saveProfile(saved);
  await profileApi.upsertApp({ slug: config.slug, url });

  log.step(5, total, 'Telling Supabase the new address (so sign-in and email links work)');
  let authUrls;
  try {
    const r = await setAuthUrls({ appDir, url });
    authUrls = { ok: true, changed: r.changed };
    log.ok('Sign-in addresses updated (the old address stays allowed).');
  } catch (err) {
    authUrls = { ok: false, error: err.message };
    warnings.push(`Supabase was not updated: ${err.message} Run: node provision-supabase.mjs <app-folder> --url ${url}`);
    log.fail(warnings.at(-1));
  }

  // The www address must send people to the main address, or there are two copies of the site.
  let wwwRedirect = null;
  if (wantWww) {
    wwwRedirect = await checkWwwRedirect({ www, host, fetch: deps.fetch });
    try {
      const r = await (deps.addRedirects ?? ((o) => addAuthRedirects(o, deps.supabase ?? {})))({ appDir, redirects: [`https://${www}/**`] });
      if (r.status === 'added') log.ok(`Sign-in is also allowed from ${www} (until it redirects).`);
    } catch (err) {
      warnings.push(`Supabase did not accept ${www} as a sign-in address (${err.message}). Sign-in from ${www} may fail until the redirect below is set.`);
    }
    if (wwwRedirect.ok) log.ok(`${www} redirects to ${host}.`);
    else {
      const message = `${www} still opens as a second copy of your site${wwwRedirect.status ? ` (it answered ${wwwRedirect.status})` : ''}. Do this by hand: ${wwwRedirectSteps(www, host)} Then run this again with --check.`;
      warnings.push(message);
      log.fail(message);
    }
  }
  const wwwOk = !wantWww || wwwRedirect.ok;

  return {
    ...result,
    ok: authUrls.ok && wwwOk,
    dnsReady: true,
    live: true,
    url,
    authUrls,
    wwwRedirect,
    warnings,
    ...(authUrls.ok && wwwOk ? {} : { error: !authUrls.ok ? warnings.find((w) => w.startsWith('Supabase was not updated')) : warnings.find((w) => w.includes('second copy')) }),
    next: 'Deploy again so the app builds with its new address: run deploy.mjs. Then run launch-email.mjs for real sign-up emails.',
  };
}

export { isTestAddress };
