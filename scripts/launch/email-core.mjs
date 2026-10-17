// launch-email: a verified sending domain at Resend, then real emails from Supabase and from the app.
import path from 'node:path';
import * as realVercel from '../lib/vercel.mjs';
import * as supabaseApi from '../lib/supabase-api.mjs';
import { getSecret as realGetSecret } from '../lib/secrets.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { ProvisionError, readAppConfig, originOf, isLocalOrigin } from '../provision/common.mjs';
import { updateEnvFile, readEnvText } from '../provision/envfile.mjs';
import { parseEnv } from '../lib/secrets.mjs';
import { createResend } from './resend-api.mjs';
import { normalizeDomain, formatRecordTable } from './domain-core.mjs';
import { parseCountry, isEea, isUk } from './countries.mjs';
import { recordLaunch, addEnvNames, sleepMs, scrub } from './common.mjs';

export const SHARED_EMAIL_MESSAGE = 'This app shares its Supabase project with other apps, so Shipyard does not change the project\'s sign-up email settings (they belong to every app there): not the email server, not the sender, and not whether sign-ups need a confirmed email. Change them by hand in the Supabase dashboard (Authentication) if you really want to. The app\'s own emails (RESEND_API_KEY on Vercel) still work.';

export const SMTP = { host: 'smtp.resend.com', port: '465', user: 'resend' };
const REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'];

const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A name that is safe inside `Name <address>` and inside an env file. */
export function senderName(appName) {
  return String(appName ?? '').replace(/[<>"'\r\n,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'App';
}

/**
 * The email Supabase sends to confirm a new account. The link goes to the app's /auth/confirm with the one-time value
 * in the link itself, so it works on any device (Supabase's default link only works in the browser that signed up).
 */
export function confirmationEmail(appName) {
  const name = htmlEscape(appName);
  return {
    subject: `Confirm your email for ${String(appName).replace(/[\r\n]/g, ' ')}`,
    html: [
      `<h2>Confirm your email</h2>`,
      `<p>Thanks for signing up to ${name}. Press the link below to confirm that this is your email address.</p>`,
      `<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email">Confirm my email</a></p>`,
      `<p>If you did not sign up, you can ignore this email.</p>`,
    ].join('\n'),
  };
}

/**
 * The key an app gets. The account key in the keys file can make and delete domains and read every email ever sent,
 * so it never leaves this computer. Each app gets its own key that can only send email from its own domain.
 * It is kept in the app's .env.local (the Resend answer is the only time the value is shown), reused on a re-run,
 * and replaced when this computer has no copy of the one Resend holds, or when the copy was made for another domain.
 *
 * Nothing is deleted here. The new key is made first; the caller deletes `staleIds` (older keys with this app's name)
 * only after Supabase and Vercel have the new value, so a failure half way never leaves the app without a working key.
 * localDomainId / localKeyId: what the app's file remembers about the key in .env.local (ids, not secrets).
 * -> { token, created, id, staleIds }
 */
export async function ensureSendingKey({ resend, slug, domainId, accountKey, local, localDomainId, localKeyId }) {
  const have = String(local ?? '');
  const name = `shipyard-${slug}`;
  const reusable = have.startsWith('re_') && have !== accountKey && have.length >= 20 && Boolean(domainId) && localDomainId === domainId;
  if (reusable) {
    // Older copies are only cleaned up when we know which key is the current one.
    let staleIds = [];
    if (localKeyId) {
      try {
        staleIds = (await resend.listApiKeys()).filter((k) => k.name === name && k.id !== localKeyId).map((k) => k.id);
      } catch {
        staleIds = [];
      }
    }
    return { token: have, created: false, id: localKeyId || '', staleIds };
  }
  const older = (await resend.listApiKeys()).filter((k) => k.name === name).map((k) => k.id);
  const made = await resend.createSendingKey({ name, domainId });
  return { token: made.token, created: true, id: made.id || '', staleIds: older.filter((id) => id !== made.id) };
}

/** Which Resend region to use: the EU one for people based in Europe, else Resend's default. */
export function pickRegion({ requested, countryInput }) {
  if (requested) {
    if (!REGIONS.includes(requested)) throw new ProvisionError(`"${requested}" is not a Resend region. Choose from: ${REGIONS.join(', ')}.`);
    return requested;
  }
  const c = parseCountry(countryInput);
  return c && (isEea(c.code) || isUk(c.code)) ? 'eu-west-1' : undefined;
}

const normalizeRecords = (records) => (Array.isArray(records) ? records : []).map((r) => ({
  purpose: String(r.record ?? ''),
  type: String(r.type ?? ''),
  name: String(r.name ?? ''),
  value: String(r.value ?? ''),
  priority: r.priority === undefined || r.priority === null ? '' : String(r.priority),
  status: String(r.status ?? ''),
}));

function dnsTable(records) {
  const rows = records.map((r) => ({ type: r.type, name: r.name, value: r.priority ? `${r.value}   (priority ${r.priority})` : r.value }));
  return formatRecordTable(rows);
}

/**
 * opts: { appDir, domain, region, check, timeoutMin, intervalSec, switchToVerified }
 * deps: { getSecret, fetch, sleep, run, vercel, profile, resend, supabase: { fetch, sleep } }
 */
export async function launchEmail(opts, deps = {}) {
  const { appDir } = opts;
  const run = deps.run ?? realRun;
  const vercel = deps.vercel ?? realVercel;
  const profileApi = deps.profile ?? realProfile;
  const getSecret = deps.getSecret ?? realGetSecret;
  const sleep = deps.sleep ?? sleepMs;
  const total = opts.check ? 5 : 3;

  const config = await readAppConfig(appDir);
  const profile = await profileApi.loadProfile();
  const scope = profile.accounts?.vercel?.scope || undefined;
  const appName = config.name || config.slug;
  // An app that shares its Supabase project with other apps must not touch the project's sign-up email settings: they
  // belong to every app there (the email server and sender, and whether sign-ups need a confirmed email).
  const sharedProject = Boolean(config.shared || config.supabaseShared);
  if (sharedProject && opts.switchToVerified) {
    throw new ProvisionError(SHARED_EMAIL_MESSAGE, { reason: 'shared-project' });
  }

  const baseDomain = config.launch?.domain?.name || (profile.domain?.choice === 'own' ? profile.domain?.name : '') || '';
  const sending = normalizeDomain(opts.domain || (baseDomain ? `send.${baseDomain}` : ''));
  if (!opts.domain && !baseDomain) {
    throw new ProvisionError('Which domain should the emails come from? Set up your domain first (launch-domain.mjs), or pass one with --domain, for example --domain send.example.com.');
  }
  const region = pickRegion({ requested: opts.region, countryInput: profile.owner?.country });

  const key = await getSecret('RESEND_API_KEY');
  const secretValues = [key];
  const resend = deps.resend ?? createResend({ key, fetch: deps.fetch, sleep });

  log.step(1, total, `Finding or creating the sending domain ${sending} at Resend`);
  let domain = await resend.findDomain(sending);
  let created = false;
  if (!domain) {
    domain = await resend.createDomain({ name: sending, region });
    created = true;
    log.ok(`Created ${sending} at Resend${region ? ` (region ${region})` : ''}.`);
  } else {
    log.ok(`${sending} is already at Resend.`);
  }
  let full = Array.isArray(domain.records) && domain.records.length > 0 ? domain : await resend.getDomain(domain.id);
  let records = normalizeRecords(full.records);
  let status = String(full.status ?? domain.status ?? 'not_started');

  log.step(2, total, 'The DNS records Resend needs');
  if (status !== 'verified') {
    log.info('Add these records where you bought the domain (its DNS settings):');
    for (const line of dnsTable(records)) log.info(line);
    log.info('Name: type it exactly as shown. Some registrars add the domain name for you, so do not type it twice. Types TXT, MX and CNAME all matter.');
  } else {
    log.ok('Resend already verified this domain.');
  }

  const result = {
    ok: true,
    sendingDomain: sending,
    domainId: full.id ?? domain.id,
    created,
    status,
    verified: status === 'verified',
    records: records.map(({ purpose, type, name, value, priority, status: s }) => ({ purpose, type, name, value, ...(priority ? { priority } : {}), status: s })),
    smtpConfigured: false,
    vercelUpdated: false,
    signupMode: config.launch?.signupMode ?? 'starter',
    warnings: [],
    next: '',
  };

  // Data attached to errors: everything we know, but never an `ok: true` that would hide the failure.
  const info = () => {
    const { ok, next, ...rest } = result;
    return rest;
  };

  if (status !== 'verified' && opts.check) {
    log.step(3, total, 'Asking Resend to check the records, and waiting');
    const intervalMs = (opts.intervalSec ?? 15) * 1000;
    const tries = Math.max(1, Math.ceil(((opts.timeoutMin ?? 10) * 60_000) / intervalMs));
    for (let attempt = 1; attempt <= tries; attempt++) {
      await resend.verifyDomain(result.domainId);
      await sleep(Math.min(intervalMs, 5000));
      full = await resend.getDomain(result.domainId);
      status = String(full.status ?? '');
      records = normalizeRecords(full.records);
      if (status === 'verified') break;
      if (status === 'failed') break;
      const waiting = records.filter((r) => r.status && r.status !== 'verified').map((r) => `${r.purpose || r.type} ${r.status}`);
      log.info(`Attempt ${attempt}/${tries}: ${status || 'pending'}${waiting.length ? ` (${waiting.join(', ')})` : ''}`);
      if (attempt < tries) await sleep(intervalMs);
    }
    result.status = status;
    result.verified = status === 'verified';
    result.records = records.map(({ purpose, type, name, value, priority, status: s }) => ({ purpose, type, name, value, ...(priority ? { priority } : {}), status: s }));
    if (status === 'failed') {
      throw new ProvisionError('Resend could not find the DNS records. Check each one at your registrar (type, name, value), wait a few minutes, then run this again with --check.', { reason: 'failed', ...info() });
    }
    if (status !== 'verified') {
      throw new ProvisionError(`The domain is not verified yet (Resend says: ${status || 'pending'}). DNS changes can take up to a few hours. Run this again with --check later.`, { reason: 'pending', ...info() });
    }
  }

  if (!result.verified) {
    result.next = opts.check ? '' : 'Add the records above, then run this again with --check. It waits for Resend to confirm (up to 10 minutes).';
    return result;
  }
  log.ok(`${sending} is verified at Resend.`);

  // ---- A key for this app only (sending from this domain, nothing else)
  const localEnv = parseEnv(await readEnvText(path.join(appDir, '.env.local')));
  let appKey;
  try {
    appKey = await ensureSendingKey({
      resend,
      slug: config.slug,
      domainId: result.domainId,
      accountKey: key,
      local: localEnv.get('RESEND_API_KEY'),
      localDomainId: config.launch?.email?.keyDomainId,
      localKeyId: config.launch?.email?.keyId,
    });
  } catch (err) {
    if (err?.name === 'ApiError') {
      throw new ProvisionError(`${scrub(err.message, [key])} Shipyard needs a Resend key with "Full access" to make the sending-only key for this app. Make one at resend.com > API Keys and put it in your Shipyard keys file.`, { ...info(), reason: 'api-key' });
    }
    throw err;
  }
  secretValues.push(appKey.token);
  await updateEnvFile(path.join(appDir, '.env.local'), { RESEND_API_KEY: appKey.token });
  // Remember which domain (and which Resend key) the copy in .env.local belongs to, before anything else can fail.
  await recordLaunch(appDir, { email: { keyDomainId: result.domainId, keyId: appKey.id } }, { profile: profileApi });
  log.ok(appKey.created ? 'Made a sending-only Resend key for this app (it can send email from your domain and nothing else).' : 'Using this app\'s sending-only Resend key.');

  // ---- Supabase: real sign-up emails
  const refStep = opts.check ? 4 : 3;
  let after = {};
  let supabaseCall = null;
  const from = `noreply@${sending}`;
  if (sharedProject) {
    log.step(refStep, total, 'Skipping the Supabase email settings (this app shares its project with other apps)');
    log.warn(SHARED_EMAIL_MESSAGE);
    result.warnings.push(SHARED_EMAIL_MESSAGE);
    result.supabaseSkipped = 'shared-project';
  } else {
    log.step(refStep, total, 'Connecting Supabase to Resend, so sign-up emails go out');
    const ref = config.supabaseRef || (profile.apps ?? []).find((a) => a.slug === config.slug)?.supabaseRef;
    if (!ref) throw new ProvisionError('This app has no Supabase project yet. Run provision-supabase.mjs on the app folder first.');
    const token = await getSecret('SUPABASE_ACCESS_TOKEN');
    const auth = { token, fetch: deps.supabase?.fetch, sleep: deps.supabase?.sleep };
    const safe = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err?.name === 'ApiError') throw new ProvisionError(scrub(err.message, [key, token, ...secretValues]));
        throw err;
      }
    };
    supabaseCall = { ref, auth, safe };
    const before = (await safe(() => supabaseApi.getAuthConfig(auth, ref))) ?? {};
    if (before.smtp_host && before.smtp_host !== SMTP.host) log.warn(`Replacing the custom email settings Supabase had (${before.smtp_host}).`);
    await safe(() => supabaseApi.patchAuthConfig(auth, ref, {
      external_email_enabled: true,
      smtp_host: SMTP.host,
      smtp_port: SMTP.port,
      smtp_user: SMTP.user,
      smtp_pass: appKey.token,
      smtp_admin_email: from,
      smtp_sender_name: senderName(appName),
    }));
    after = (await safe(() => supabaseApi.getAuthConfig(auth, ref))) ?? {};
    if (after.smtp_host !== SMTP.host || after.smtp_admin_email !== from) {
      throw new ProvisionError('Supabase accepted the email settings but does not show them back. Open Supabase > Authentication > Emails > SMTP Settings and check them.');
    }
    result.smtpConfigured = true;
    log.ok(`Supabase now sends its emails from ${from} through Resend.`);
  }

  // ---- Vercel: the app's own emails (password reset, newsletter)
  const fromHeader = `${senderName(appName)} <${from}>`;
  const failures = [];
  for (const [name, value] of [['RESEND_API_KEY', appKey.token], ['RESEND_FROM', fromHeader]]) {
    const r = await vercel.envAdd({ cwd: appDir, name, value, scope, run });
    if (!r.ok) failures.push(`${name}: ${scrub(r.error, secretValues)}`);
  }
  if (failures.length > 0) {
    throw new ProvisionError(`${sharedProject ? 'The sending key is ready' : 'Supabase is ready'}, but Vercel did not accept the email settings (${failures.join('; ')}). Run provision-vercel.mjs, then this again.`, { ...info(), reason: 'vercel' });
  }
  result.vercelUpdated = true;

  // Supabase and Vercel have the new key now, so the older keys with this app's name can go.
  if (appKey.staleIds.length > 0) {
    let removed = 0;
    for (const id of appKey.staleIds) {
      try {
        await resend.deleteApiKey(id);
        removed += 1;
      } catch (err) {
        log.warn(`Could not remove an old Resend key (${scrub(err?.message ?? 'unknown error', secretValues)}). You can delete it at resend.com > API Keys (it is named shipyard-${config.slug}).`);
      }
    }
    if (removed > 0) {
      const note = `Removed ${removed} older Resend key${removed === 1 ? '' : 's'} for this app. The live app still has the old key until you deploy again, so its own emails (password reset, newsletter) fail until then: run deploy.mjs now.`;
      result.warnings.push(note);
      log.warn(note);
    }
  }
  await updateEnvFile(path.join(appDir, '.env.local'), { RESEND_FROM: fromHeader });
  await addEnvNames(appDir, ['RESEND_API_KEY', 'RESEND_FROM']);
  log.ok('RESEND_API_KEY and RESEND_FROM are set on Vercel.');

  await recordLaunch(appDir, { email: { sendingDomain: sending, from: fromHeader, verified: true, verifiedAt: new Date().toISOString(), smtp: !sharedProject, region: region ?? null } }, { profile: profileApi });
  const saved = await profileApi.loadProfile();
  saved.accounts = { ...(saved.accounts ?? {}), resend: { ...(saved.accounts?.resend ?? {}), ok: true, domain: sending } };
  await profileApi.saveProfile(saved);

  // ---- optional: turn on verified sign-ups
  if (opts.switchToVerified) {
    const siteUrl = String(after.site_url ?? '');
    if (!siteUrl || isLocalOrigin(siteUrl)) {
      throw new ProvisionError('Supabase still thinks the app lives at localhost, so confirmation links would point to your computer. Run launch-domain.mjs (or provision-supabase.mjs with --url) first, then this again.', { ...info(), reason: 'site-url' });
    }
    originOf(siteUrl);
    const mail = confirmationEmail(appName);
    const { ref, auth, safe } = supabaseCall;
    await safe(() => supabaseApi.patchAuthConfig(auth, ref, {
      mailer_autoconfirm: false,
      mailer_subjects_confirmation: mail.subject,
      mailer_templates_confirmation_content: mail.html,
    }));
    const modeFailures = [];
    const mode = await vercel.envAdd({ cwd: appDir, name: 'NEXT_PUBLIC_SIGNUP_MODE', value: 'verified', scope, run });
    if (!mode.ok) modeFailures.push(`NEXT_PUBLIC_SIGNUP_MODE: ${scrub(mode.error, secretValues)}`);
    const contact = String(profile.company?.contactEmail ?? '').trim();
    if (contact && !/[\s'"$#]/.test(contact)) {
      const c = await vercel.envAdd({ cwd: appDir, name: 'NEXT_PUBLIC_CONTACT_EMAIL', value: contact, scope, run });
      if (!c.ok) modeFailures.push(`NEXT_PUBLIC_CONTACT_EMAIL: ${scrub(c.error, secretValues)}`);
    }
    // Email list: ticks collected while sign-ups were unconfirmed never proved the address was the person's own.
    // From this moment only ticks given after the switch count (the cut-off stays where it was set on a re-run).
    const switchedAt = config.launch?.signupSwitchedAt || new Date().toISOString();
    if ((config.modules ?? []).includes('newsletter')) {
      const cut = await vercel.envAdd({ cwd: appDir, name: 'NEWSLETTER_CONSENT_NOT_BEFORE', value: switchedAt, scope, run });
      if (!cut.ok) modeFailures.push(`NEWSLETTER_CONSENT_NOT_BEFORE: ${scrub(cut.error, secretValues)}`);
      else {
        await updateEnvFile(path.join(appDir, '.env.local'), { NEWSLETTER_CONSENT_NOT_BEFORE: switchedAt });
        await addEnvNames(appDir, ['NEWSLETTER_CONSENT_NOT_BEFORE']);
        const warning = 'Anyone who joined your email list before this switch never proved their address is theirs, so they are left out of newsletters. They can tick the box again in Settings. Newsletters go only to people who ticked after today.';
        result.warnings.push(warning);
        log.warn(warning);
      }
    }
    if (modeFailures.length > 0) throw new ProvisionError(`Supabase is ready for confirmed sign-ups, but Vercel did not accept: ${modeFailures.join('; ')}. Run this again.`, { ...info(), reason: 'vercel' });
    await recordLaunch(appDir, { signupMode: 'verified', signupSwitchedAt: config.launch?.signupSwitchedAt || switchedAt }, { profile: profileApi });
    result.signupMode = 'verified';
    log.ok('Sign-ups now need a confirmed email (Supabase confirmation is on, with a link that works on any device).');
  }

  result.next = opts.switchToVerified
    ? 'Deploy again so the app builds with the new settings: run deploy.mjs. Then sign up with a real email address to try it.'
    : 'Next: switch sign-ups to confirmed emails with --switch-to-verified (it sets NEXT_PUBLIC_SIGNUP_MODE=verified and Supabase\'s email confirmation), then deploy again with deploy.mjs.';
  return result;
}

export { REGIONS };
