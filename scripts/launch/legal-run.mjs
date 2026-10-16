// legal-generate: collect the facts, build the text, write src/lib/legal-content.ts.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { PLUGIN_ROOT } from '../lib/paths.mjs';
import { ProvisionError, readAppConfig, atomicWrite, appEnvNames } from '../provision/common.mjs';
import { DEFAULT_REGION } from '../provision/supabase-core.mjs';
import { loadServices, recordLaunch } from './common.mjs';
import { parseCountry, hasSeveralLegalSystems, withArticle } from './countries.mjs';
import { buildLegalContent, lintLegalContent, renderLegalFile, parseLegalFile, regionLabel, DEFAULT_MIN_AGE } from './legal-core.mjs';
import { readPlans } from './plans-parse.mjs';

export const LEGAL_FILE = path.join('src', 'lib', 'legal-content.ts');

// Services that the template and modules already mention in their own files, so a name in src/ proves nothing.
const NOT_DETECTED_BY_SOURCE = new Set(['resend', 'google', 'stripe']);

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', '.shipyard']);

async function readSourceNames(appDir, names) {
  // Looks for `process.env.NAME` style uses in the app's code (not the template's own files for email, Google, Stripe).
  const found = new Set();
  const wanted = [...names];
  let files = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files > 3000) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(e.name)) {
        files += 1;
        let text;
        try {
          text = await readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (text.length > 400_000) continue;
        for (const n of wanted) if (text.includes(n)) found.add(n);
      }
    }
  }
  await walk(path.join(appDir, 'src'));
  return found;
}

/** Which catalogue services this app uses, and why we think so. */
export async function detectServices({ catalogue, config, appDir, also = [], without = [], readSource = readSourceNames }) {
  const envNames = new Set(appEnvNames(config));
  const modules = new Set(config.modules ?? []);
  const all = new Map(catalogue.services.map((s) => [s.id, s]));
  for (const id of [...also, ...without]) {
    if (!all.has(id)) throw new ProvisionError(`"${id}" is not a service Shipyard knows. Choose from: ${[...all.keys()].join(', ')}.`);
  }
  const sourceNames = new Set(catalogue.services.filter((s) => !NOT_DETECTED_BY_SOURCE.has(s.id)).flatMap((s) => s.detectedBy.env));
  const inSource = await readSource(appDir, sourceNames);
  const picked = [];
  for (const s of catalogue.services) {
    const why = [];
    if (s.detectedBy.always) why.push('always used');
    if (s.detectedBy.env.some((n) => envNames.has(n))) why.push('listed in the app settings');
    if (s.detectedBy.module && modules.has(s.detectedBy.module)) why.push(`the ${s.detectedBy.module} module`);
    if (!NOT_DETECTED_BY_SOURCE.has(s.id) && s.detectedBy.env.some((n) => inSource.has(n))) why.push('used in the code');
    if (s.id === 'resend' && config.launch?.email?.sendingDomain) why.push('email domain set up');
    if (s.id === 'google' && config.launch?.googleSignIn === true) why.push('Google sign-in recorded');
    if (also.includes(s.id)) why.push('added by you');
    if (without.includes(s.id)) continue;
    if (why.length > 0) picked.push({ service: s, why });
  }
  return picked;
}

/** The profile values legal text can not be written without, with the exact command to set each. */
export function missingFacts(profile, countryInput, { billing = false } = {}) {
  const need = [];
  const company = profile.company ?? {};
  const empty = (v) => !String(v ?? '').trim();
  if (empty(company.legalName)) need.push({ path: 'company.legalName', ask: 'The name of the person or company that runs the app (your own full name is fine if you have no company).' });
  if (empty(company.address)) need.push({ path: 'company.address', ask: 'A postal address where you can be reached, on one line (street, number, city, postcode).' });
  if (empty(company.contactEmail)) need.push({ path: 'company.contactEmail', ask: 'The email address people should write to about their data and the app. Use one you read.' });
  if (billing && empty(company.phone)) {
    need.push({ path: 'company.phone', ask: 'A phone number people can call about their purchase (a mobile number is fine; the law for online shops asks for one). If you truly have none, answer: none' });
  }
  if (!parseCountry(countryInput)) {
    need.push({
      path: 'owner.country',
      ask: empty(countryInput) ? 'The country where you (or your company) are based.' : `"${countryInput}" is not a country I recognise. Give the country name or its two-letter code, for example GR.`,
    });
  }
  return need;
}

/**
 * opts: { appDir, country, minAge, supabaseRegion, also, without, dryRun, today }
 * deps: { profile, readSource }
 */
export async function generateLegal(opts, deps = {}) {
  const { appDir } = opts;
  const profileApi = deps.profile ?? realProfile;
  const config = await readAppConfig(appDir);
  const profile = await profileApi.loadProfile();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const countryInput = opts.country || profile.owner?.country || '';
  const billingOn = (config.modules ?? []).includes('billing') || appEnvNames(config).includes('STRIPE_SECRET_KEY');
  const need = missingFacts(profile, countryInput, { billing: billingOn });
  if (need.length > 0) {
    const lines = need.map((n) => `  ${n.path}: ${n.ask}`).join('\n');
    throw new ProvisionError(
      `I can not write the legal pages yet. I still need ${need.length === 1 ? 'one thing' : `${need.length} things`} from you:\n${lines}\nAsk the student, then save each answer with: node "${PLUGIN_ROOT}/scripts/profile.mjs" set <name> "<answer>"`,
      { reason: 'missing-facts', needs: need.map((n) => ({ path: n.path, ask: n.ask, command: `node "${PLUGIN_ROOT}/scripts/profile.mjs" set ${n.path} "<answer>"` })) },
    );
  }
  const country = parseCountry(countryInput);
  const minAge = opts.minAge ?? DEFAULT_MIN_AGE;
  if (!Number.isInteger(minAge) || minAge < 13 || minAge > 21) throw new ProvisionError('The minimum age must be a whole number between 13 and 21.');

  const catalogue = await loadServices();
  const detected = await detectServices({ catalogue, config, appDir, also: opts.also ?? [], without: opts.without ?? [], readSource: deps.readSource });
  const services = detected.map((d) => d.service);
  const modules = config.modules ?? [];
  const billing = modules.includes('billing') || services.some((s) => s.id === 'stripe');
  let plans = null;
  if (billing) plans = await readPlans(appDir, config.slug);

  const explicitRegion = opts.supabaseRegion || profile.accounts?.supabase?.region || profile.defaults?.region || config.launch?.legal?.supabaseRegion || '';
  const regionCode = explicitRegion || DEFAULT_REGION;
  if (opts.supabaseRegion && !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(opts.supabaseRegion)) {
    throw new ProvisionError(`"${opts.supabaseRegion}" does not look like a Supabase region. Use something like eu-central-1.`);
  }

  const content = buildLegalContent({
    appName: config.name || config.slug,
    appDescription: config.description || '',
    controller: {
      name: profile.company.legalName,
      address: profile.company.address,
      email: profile.company.contactEmail,
      vatId: profile.company.vatId,
      phone: profile.company.phone,
    },
    country,
    services,
    modules,
    plans,
    supabaseRegion: { code: regionCode },
    minAge,
    governingLaw: opts.governingLaw,
    today,
  });

  const problems = lintLegalContent(content);
  if (problems.length > 0) {
    throw new ProvisionError(`The text I built has problems with your details: ${problems.slice(0, 4).join('; ')}. Fix those details with profile.mjs and run this again.`, { reason: 'lint', problems });
  }

  // Same input must give the same file: keep the old date unless the words changed.
  const target = path.join(appDir, LEGAL_FILE);
  let existing = null;
  try {
    existing = parseLegalFile(await readFile(target, 'utf8'));
  } catch {
    existing = null;
  }
  if (existing && JSON.stringify({ ...existing, updatedAt: '' }) === JSON.stringify({ ...content, updatedAt: '' })) {
    content.updatedAt = existing.updatedAt;
  }
  const text = renderLegalFile(content);
  let current = '';
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = '';
  }
  const changed = current !== text;
  if (changed && !opts.dryRun) await atomicWrite(target, text);

  const warnings = [];
  if (!explicitRegion) warnings.push(`I assumed the Supabase database is in ${regionLabel(DEFAULT_REGION)} (${DEFAULT_REGION}, the Shipyard default). If it is somewhere else, run this again with --supabase-region <code>.`);
  if (services.some((s) => s.flags?.analytics)) warnings.push('The cookie text says analytics only runs after the visitor agrees. Make sure the app really waits for that agreement before it loads analytics.');
  if (services.some((s) => s.flags?.ai)) warnings.push('The text names the AI company you use. If you add or change an AI provider, run this again.');
  if ((profile.owner?.languages ?? ['en']).some((l) => l !== 'en')) warnings.push('The text is in English only. If your users read another language, have a translation made and checked.');
  const paid = (plans ?? []).filter((p) => p.priceCents > 0);
  if (billing) warnings.push('The text promises: 30 days notice before a price rise, a 14-day withdrawal right with a refund, and refunds of unused time if the app closes. Only keep these if you are happy to honour them.');
  if (billing && paid.length > 0) {
    const has = async (rel) => readFile(path.join(appDir, rel), 'utf8').then(() => true, () => false);
    if (!(await has(path.join('src', 'app', 'api', 'billing', 'withdraw', 'route.ts')))) {
      warnings.push('The terms point to a "Withdraw from contract" button in Settings, but this app does not have it yet. Add the payments module again from the latest Shipyard (node add-module.mjs <app-folder> billing --force-file <each changed file>), or the text is not true.');
    }
    const checkout = await readFile(path.join(appDir, 'src', 'app', 'api', 'billing', 'checkout', 'route.ts'), 'utf8').catch(() => '');
    if (!checkout.includes('termsConsent')) {
      warnings.push('The terms say buyers tick a box at checkout to ask for the service to start at once. This app\'s checkout does not show that box yet, so the refund-minus-days-used rule does not hold. Update the payments module.');
    }
    warnings.push(`Stripe checkout shows that box only if your Terms link is saved in Stripe: Settings, Business, Public details, Terms of service: your site address plus /terms.`);
  }
  if (hasSeveralLegalSystems(country.code) && !opts.governingLaw) warnings.push(`${country.name} has several legal systems. The terms now say the law of ${withArticle(country.name)}; say which one with --governing-law, for example --governing-law "the State of Texas".`);
  warnings.push('The text says you reply to data requests within one month.');

  const result = {
    ok: true,
    file: LEGAL_FILE,
    changed,
    dryRun: Boolean(opts.dryRun),
    updatedAt: content.updatedAt,
    country: country.name,
    countryCode: country.code,
    controller: content.controller,
    services: detected.map((d) => ({ id: d.service.id, name: d.service.name, why: d.why })),
    withdrawalText: billing && plans?.some((p) => p.priceCents > 0),
    sections: { privacy: content.privacy.map((s) => s.title), terms: content.terms.map((s) => s.title) },
    readback: readbackBullets({ content, services, billing, plans, country, minAge }),
    warnings,
    reminder: 'This text is a clear draft, not legal advice. Have a lawyer or an accountant check it before you take payments.',
    catalogueVerifiedAt: catalogue.verifiedAt,
  };

  if (!opts.dryRun) {
    await recordLaunch(appDir, { legal: { generatedAt: content.updatedAt, country: country.code, services: services.map((s) => s.id), withdrawalText: result.withdrawalText } }, { profile: profileApi });
  }
  return result;
}

/** Five plain bullets the agent reads back to the student. */
export function readbackBullets({ content, services, billing, plans, country, minAge }) {
  const paid = (plans ?? []).filter((p) => p.priceCents > 0);
  const bullets = [
    `Who is responsible: ${content.controller.name}, ${content.controller.country}, reachable at ${content.controller.email}.`,
    `What is collected: email and a scrambled password, the profile, what people save, and basic technical details${services.some((s) => s.id === 'google') ? ', plus name and email from Google sign-in' : ''}${services.some((s) => s.flags?.ai) ? ', and what people send to the AI features' : ''}.`,
    `Who else sees it: ${services.map((s) => s.name).join(', ')}. Each one is listed with what it does and where it works.`,
    `People's rights: delete the account in Settings at any time, ask for a copy or a correction by email (answer within one month), complain to the data protection authority. The app is for people aged ${minAge} and over.`,
  ];
  if (billing && paid.length > 0) {
    bullets.push(`Payments: ${paid.map((p) => `${p.name} is ${(p.priceCents / 100).toFixed(2)} ${p.currency.toUpperCase()} per ${p.interval}`).join('; ')}. Renews until cancelled in Settings. EU and UK buyers can withdraw within 14 days and get a refund minus the days used.`);
  } else {
    bullets.push(`Terms: fair use, people keep what they save, no promise the app is always online, liability limited as far as the law allows, the law of ${country.name} applies.`);
  }
  return bullets;
}

export function printResult(result) {
  log.ok(`${result.changed ? (result.dryRun ? 'Would write' : 'Wrote') : 'Already up to date:'} ${result.file} (${result.country}).`);
  log.info(`Services listed: ${result.services.map((s) => s.name).join(', ')}.`);
  log.info(`Privacy sections: ${result.sections.privacy.length}. Terms sections: ${result.sections.terms.length}.`);
  for (const w of result.warnings) log.warn(w);
  log.warn(result.reminder);
}
