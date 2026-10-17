import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEmail, ensureSendingKey } from '../scripts/launch/email-core.mjs';
import { launchDomain, checkWwwRedirect } from '../scripts/launch/domain-core.mjs';
import { launchSummary, recordLaunch } from '../scripts/launch/common.mjs';
import { buildLegalContent } from '../scripts/launch/legal-core.mjs';
import { missingFacts } from '../scripts/launch/legal-run.mjs';
import { parseCountry } from '../scripts/launch/countries.mjs';
import { loadServices } from '../scripts/launch/common.mjs';
import { tempApp, readConfig, fakeProfile, fakeVercel } from './launch-helpers.mjs';

const FULL = `re_${'f1'.repeat(14)}`;
const SENDING = `re_${'s2'.repeat(14)}`;

function fakeResend({ status = 'verified', keys = [], failCreate = false } = {}) {
  const calls = { created: [], deleted: [] };
  return {
    calls,
    findDomain: async () => ({ id: 'dom_1', name: 'send.tea.example', status, records: [] }),
    createDomain: async () => { throw new Error('should not create'); },
    getDomain: async () => ({ id: 'dom_1', name: 'send.tea.example', status, records: [] }),
    verifyDomain: async () => ({}),
    listApiKeys: async () => keys,
    createSendingKey: async (input) => {
      if (failCreate) { const e = new Error('Your Resend key is not allowed to manage domains. (HTTP 403)'); e.name = 'ApiError'; throw e; }
      calls.created.push(input);
      return { id: 'key_new', token: SENDING };
    },
    deleteApiKey: async (id) => { calls.deleted.push(id); return {}; },
  };
}

function fakeSupabase() {
  const state = { config: { site_url: 'https://tea.example', smtp_host: '' }, patches: [] };
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'PATCH') { const body = JSON.parse(init.body); state.patches.push(body); Object.assign(state.config, body); }
    return { ok: true, status: 200, text: async () => JSON.stringify(state.config), headers: new Map() };
  };
  return { state, fetch, calls };
}

async function emailSetup(t, config = {}) {
  const app = await tempApp({ supabaseRef: 'abcdefghijklmnopqrst', modules: ['newsletter'], launch: { domain: { name: 'tea.example' } }, ...config }, { withPlans: false });
  t.after(app.cleanup);
  const vercel = fakeVercel();
  const supabase = fakeSupabase();
  const prof = fakeProfile();
  const deps = (more = {}) => ({
    getSecret: async (name) => (name === 'RESEND_API_KEY' ? FULL : 'sbp_' + 'x'.repeat(30)),
    resend: fakeResend(), vercel, profile: prof, supabase: { fetch: supabase.fetch, sleep: async () => {} }, sleep: async () => {}, ...more,
  });
  return { app, vercel, supabase, deps };
}

test('launch-email: the app gets its own sending-only key; the account key never leaves this computer', async (t) => {
  const { app, vercel, supabase, deps } = await emailSetup(t);
  const resend = fakeResend();
  const r = await launchEmail({ appDir: app.dir, check: false }, deps({ resend }));
  assert.equal(r.smtpConfigured, true);
  assert.deepEqual(resend.calls.created, [{ name: 'shipyard-tea-shop', domainId: 'dom_1' }]);
  // Supabase's SMTP password and Vercel's RESEND_API_KEY are the sending-only key.
  assert.equal(supabase.state.config.smtp_pass, SENDING);
  assert.equal(vercel.set.find((e) => e.name === 'RESEND_API_KEY').value, SENDING);
  // The full-access key is nowhere.
  const everything = JSON.stringify({ vercel: vercel.set, supabase: supabase.state.patches, result: r });
  assert.ok(!everything.includes(FULL), 'the account key leaked');
  assert.ok(!JSON.stringify(r).includes(SENDING), 'even the sending-only key is not in the result');
  assert.match(await readFile(path.join(app.dir, '.env.local'), 'utf8'), new RegExp(`RESEND_API_KEY=${SENDING}`));
  assert.equal((await readConfig(app.dir)).launch.email.verified, true);
});

test('launch-email: a second run reuses the key kept in .env.local instead of making another', async (t) => {
  const { app, deps } = await emailSetup(t);
  await launchEmail({ appDir: app.dir }, deps());
  const resend = fakeResend();
  await launchEmail({ appDir: app.dir }, deps({ resend }));
  assert.deepEqual(resend.calls.created, []);
  assert.deepEqual(resend.calls.deleted, []);
});

test('ensureSendingKey: makes the new key first and deletes nothing itself; older keys of the same name are handed back', async () => {
  const resend = fakeResend({ keys: [{ id: 'old1', name: 'shipyard-tea-shop' }, { id: 'other', name: 'something else' }] });
  const r = await ensureSendingKey({ resend, slug: 'tea-shop', domainId: 'dom_1', accountKey: FULL, local: undefined });
  assert.deepEqual(resend.calls.deleted, [], 'nothing deleted yet');
  assert.equal(r.created, true);
  assert.equal(r.id, 'key_new');
  assert.deepEqual(r.staleIds, ['old1']);
  // A local value equal to the account key is never taken as the app's key.
  const again = await ensureSendingKey({ resend: fakeResend(), slug: 'tea-shop', domainId: 'dom_1', accountKey: FULL, local: FULL, localDomainId: 'dom_1' });
  assert.equal(again.created, true);
  assert.notEqual(again.token, FULL);
});

test('ensureSendingKey: the key on this computer is reused only for the domain it was made for', async () => {
  const mine = `re_${'k7'.repeat(14)}`;
  const same = await ensureSendingKey({ resend: fakeResend(), slug: 'tea-shop', domainId: 'dom_1', accountKey: FULL, local: mine, localDomainId: 'dom_1', localKeyId: 'key_a' });
  assert.deepEqual([same.created, same.token, same.id], [false, mine, 'key_a']);
  const other = fakeResend();
  const changed = await ensureSendingKey({ resend: other, slug: 'tea-shop', domainId: 'dom_2', accountKey: FULL, local: mine, localDomainId: 'dom_1', localKeyId: 'key_a' });
  assert.equal(changed.created, true, 'another sending domain needs a key for that domain');
  assert.deepEqual(other.calls.created, [{ name: 'shipyard-tea-shop', domainId: 'dom_2' }]);
  const unknown = await ensureSendingKey({ resend: fakeResend(), slug: 'tea-shop', domainId: 'dom_1', accountKey: FULL, local: mine });
  assert.equal(unknown.created, true, 'a key whose domain nobody remembers is not trusted');
  // Older copies are only listed for removal when the current key id is known.
  const withOld = fakeResend({ keys: [{ id: 'key_a', name: 'shipyard-tea-shop' }, { id: 'key_z', name: 'shipyard-tea-shop' }] });
  assert.deepEqual((await ensureSendingKey({ resend: withOld, slug: 'tea-shop', domainId: 'dom_1', accountKey: FULL, local: mine, localDomainId: 'dom_1', localKeyId: 'key_a' })).staleIds, ['key_z']);
  assert.deepEqual((await ensureSendingKey({ resend: withOld, slug: 'tea-shop', domainId: 'dom_1', accountKey: FULL, local: mine, localDomainId: 'dom_1' })).staleIds, []);
});

test('launch-email: on a fresh computer the new key goes to Supabase and Vercel first, and only then the old key is deleted', async (t) => {
  const { app, vercel, supabase, deps } = await emailSetup(t);
  const resend = fakeResend({ keys: [{ id: 'old1', name: 'shipyard-tea-shop' }] });
  const order = [];
  const baseCreate = resend.createSendingKey;
  resend.createSendingKey = async (i) => { order.push('create'); return baseCreate(i); };
  resend.deleteApiKey = async (id) => { order.push(`delete:${id}:vercel=${vercel.set.some((e) => e.name === 'RESEND_API_KEY')}:smtp=${Boolean(supabase.state.config.smtp_pass)}`); return {}; };
  const r = await launchEmail({ appDir: app.dir }, deps({ resend }));
  assert.deepEqual(order, ['create', 'delete:old1:vercel=true:smtp=true']);
  assert.match(r.warnings.join(' '), /deploy/);
  const config = await readConfig(app.dir);
  assert.equal(config.launch.email.keyId, 'key_new');
  assert.equal(config.launch.email.keyDomainId, 'dom_1');
  assert.ok(!JSON.stringify(config).includes(SENDING), 'the key itself is never saved in the app file');
});

test('launch-email: if Resend will not make the new key, the old key is left alone', async (t) => {
  const { app, deps } = await emailSetup(t);
  const resend = fakeResend({ keys: [{ id: 'old1', name: 'shipyard-tea-shop' }], failCreate: true });
  await assert.rejects(() => launchEmail({ appDir: app.dir }, deps({ resend })), /Full access/);
  assert.deepEqual(resend.calls.deleted, []);
});

test('launch-email: if Supabase or Vercel does not take the new key, the old key is not deleted and a re-run finishes the job', async (t) => {
  const { app, vercel, deps } = await emailSetup(t);
  const resend = fakeResend({ keys: [{ id: 'old1', name: 'shipyard-tea-shop' }] });
  const bad = fakeVercel({ failOn: ['RESEND_API_KEY'] });
  await assert.rejects(() => launchEmail({ appDir: app.dir }, deps({ resend, vercel: bad })), /Vercel did not accept/);
  assert.deepEqual(resend.calls.deleted, [], 'the app still has a working key');
  // The re-run reuses the key made the first time (same domain), gives it to Vercel, then cleans up the old one.
  const second = await launchEmail({ appDir: app.dir }, deps({ resend, vercel }));
  assert.equal(resend.calls.created.length, 1, 'no third key');
  assert.deepEqual(resend.calls.deleted, ['old1']);
  assert.equal(second.vercelUpdated, true);
});

test('launch-email: a different sending domain gets a key made for that domain, not the old one', async (t) => {
  const { app, supabase, deps } = await emailSetup(t);
  await launchEmail({ appDir: app.dir }, deps());
  assert.equal(supabase.state.config.smtp_pass, SENDING);
  const NEW = `re_${'n3'.repeat(14)}`;
  const resend = fakeResend({ keys: [{ id: 'key_new', name: 'shipyard-tea-shop' }] });
  resend.findDomain = async () => ({ id: 'dom_2', name: 'mail.tea.example', status: 'verified', records: [] });
  resend.getDomain = resend.findDomain;
  resend.createSendingKey = async (i) => { resend.calls.created.push(i); return { id: 'key_dom2', token: NEW }; };
  await launchEmail({ appDir: app.dir, domain: 'mail.tea.example' }, deps({ resend }));
  assert.deepEqual(resend.calls.created, [{ name: 'shipyard-tea-shop', domainId: 'dom_2' }]);
  assert.equal(supabase.state.config.smtp_pass, NEW);
  assert.deepEqual(resend.calls.deleted, ['key_new']);
  assert.equal((await readConfig(app.dir)).launch.email.keyDomainId, 'dom_2');
  assert.match(await readFile(path.join(app.dir, '.env.local'), 'utf8'), new RegExp(`RESEND_API_KEY=${NEW}`));
});

test('launch-email: if Resend will not make the key, nothing is sent to Supabase or Vercel and the full key is not used as a fallback', async (t) => {
  const { app, vercel, supabase, deps } = await emailSetup(t);
  await assert.rejects(
    () => launchEmail({ appDir: app.dir }, deps({ resend: fakeResend({ failCreate: true }) })),
    (e) => { assert.match(e.message, /"Full access"/); assert.ok(!e.message.includes(FULL)); return true; },
  );
  assert.equal(vercel.set.length, 0);
  assert.equal(supabase.state.patches.length, 0);
});

test('launch-email --switch-to-verified: with the email list, earlier ticks stop counting and the student is told', async (t) => {
  const { app, vercel, deps } = await emailSetup(t);
  const r = await launchEmail({ appDir: app.dir, switchToVerified: true }, deps());
  assert.equal(r.signupMode, 'verified');
  const cut = vercel.set.find((e) => e.name === 'NEWSLETTER_CONSENT_NOT_BEFORE');
  assert.ok(cut && Number.isFinite(Date.parse(cut.value)));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /before this switch never proved their address/);
  assert.match(await readFile(path.join(app.dir, '.env.local'), 'utf8'), /NEWSLETTER_CONSENT_NOT_BEFORE=/);
  // A second run keeps the same cut-off (verified-era ticks must not be thrown away).
  const second = await launchEmail({ appDir: app.dir, switchToVerified: true }, deps());
  const cuts = vercel.set.filter((e) => e.name === 'NEWSLETTER_CONSENT_NOT_BEFORE');
  assert.equal(cuts.at(-1).value, cut.value);
  assert.equal(second.signupMode, 'verified');
});

test('launch-email --switch-to-verified: an app without the email list gets no cut-off', async (t) => {
  const { app, vercel, deps } = await emailSetup(t, { modules: [] });
  const r = await launchEmail({ appDir: app.dir, switchToVerified: true }, deps());
  assert.ok(!vercel.set.some((e) => e.name === 'NEWSLETTER_CONSENT_NOT_BEFORE'));
  assert.deepEqual(r.warnings, []);
});

test('launch-email on an app that shares its Supabase project: the project\'s sign-up email settings are never touched', async (t) => {
  for (const flag of [{ shared: true, schema: 'app_tea' }, { supabaseShared: true }]) {
    const { app, vercel, supabase, deps } = await emailSetup(t, flag);
    const asked = [];
    const d = deps({ getSecret: async (name) => { asked.push(name); return name === 'RESEND_API_KEY' ? FULL : 'sbp_' + 'x'.repeat(30); } });
    const r = await launchEmail({ appDir: app.dir }, d);
    // No call to the Supabase auth settings at all: not a read, not a PATCH.
    assert.deepEqual(supabase.state.patches, []);
    assert.equal(supabase.calls.length, 0, 'Supabase was not called');
    assert.ok(!asked.includes('SUPABASE_ACCESS_TOKEN'), 'the Supabase token was not even read');
    assert.equal(r.smtpConfigured, false);
    assert.equal(r.supabaseSkipped, 'shared-project');
    assert.ok(r.warnings.some((w) => /shares its Supabase project/.test(w)));
    // The app\'s own emails still work: the sending key and sender are set on Vercel.
    assert.deepEqual(vercel.set.map((e) => e.name).sort(), ['RESEND_API_KEY', 'RESEND_FROM']);
    assert.equal(r.vercelUpdated, true);
    assert.equal((await readConfig(app.dir)).launch.email.smtp, false);
  }
});

test('launch-email --switch-to-verified on a shared app is refused before anything is changed anywhere', async (t) => {
  const { app, vercel, supabase, deps } = await emailSetup(t, { shared: true, schema: 'app_tea' });
  const resend = fakeResend();
  const touched = [];
  for (const name of Object.keys(resend)) {
    if (typeof resend[name] === 'function') { const original = resend[name]; resend[name] = async (...a) => { touched.push(name); return original(...a); }; }
  }
  await assert.rejects(
    () => launchEmail({ appDir: app.dir, switchToVerified: true }, deps({ resend })),
    (e) => e.data.reason === 'shared-project' && /does not change the project's sign-up email settings/.test(e.message),
  );
  assert.deepEqual(touched, []);
  assert.deepEqual(vercel.set, []);
  assert.equal(supabase.calls.length, 0);
  assert.deepEqual(supabase.state.patches, []);
});

// ---------------------------------------------------------------- domain

const resolvers = [{ name: 'test', resolve4: async (h) => (h.startsWith('www.') ? [] : ['76.76.21.21']), resolveCname: async (h) => (h.startsWith('www.') ? ['cname.vercel-dns.com'] : []), resolveNs: async () => [] }];
const reply = (status, headers = {}) => ({ ok: status < 300, status, url: 'https://tea.example/', text: async () => 'hello', headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

async function domainSetup(t, wwwReply) {
  const app = await tempApp({ launch: {} }, { withPlans: false });
  t.after(app.cleanup);
  const calls = { redirects: [], authUrls: [] };
  const fetch = async (url, init) => (new URL(url).hostname.startsWith('www.') ? wwwReply : reply(200));
  const deps = {
    vercel: fakeVercel(), profile: fakeProfile({ accounts: { vercel: { scope: 'team' } } }), sleep: async () => {}, resolvers, fetch,
    add: async () => ({ ok: true }), verify: async () => ({ ok: true, parsed: true, records: [], nameservers: [], conflicts: [] }),
    setAuthUrls: async (o) => { calls.authUrls.push(o.url); return { changed: true }; },
    addRedirects: async (o) => { calls.redirects.push(...o.redirects); return { status: 'added', added: o.redirects }; },
  };
  return { app, calls, deps };
}

test('launch-domain: www must redirect to the main address; until it does the run fails with the exact dashboard steps', async (t) => {
  const { app, calls, deps } = await domainSetup(t, reply(200));
  const r = await launchDomain({ appDir: app.dir, domain: 'tea.example', check: true, intervalSec: 1, timeoutMin: 1 }, deps);
  assert.equal(r.live, true);
  assert.equal(r.ok, false);
  assert.equal(r.wwwRedirect.ok, false);
  assert.match(r.error, /www\.tea\.example still opens as a second copy/);
  assert.match(r.error, /Redirect to Another Domain/);
  assert.match(r.error, /308/);
  assert.deepEqual(calls.redirects, ['https://www.tea.example/**'], 'sign-in is allowed from www too');
  assert.equal((await readConfig(app.dir)).launch.domain.name, 'tea.example', 'the apex is still switched over');
});

test('launch-domain: passes once www answers with a redirect to the main address', async (t) => {
  const { app, deps } = await domainSetup(t, reply(308, { location: 'https://tea.example/' }));
  const r = await launchDomain({ appDir: app.dir, domain: 'tea.example', check: true, intervalSec: 1, timeoutMin: 1 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.wwwRedirect.ok, true);
});

test('checkWwwRedirect: only a redirect to the apex counts', async () => {
  const f = (res) => async () => res;
  assert.equal((await checkWwwRedirect({ www: 'www.a.com', host: 'a.com', fetch: f(reply(308, { location: 'https://a.com/' })) })).ok, true);
  assert.equal((await checkWwwRedirect({ www: 'www.a.com', host: 'a.com', fetch: f(reply(301, { location: '/x' })) })).ok, false, 'a redirect to itself');
  assert.equal((await checkWwwRedirect({ www: 'www.a.com', host: 'a.com', fetch: f(reply(308, { location: 'https://other.com/' })) })).ok, false);
  assert.equal((await checkWwwRedirect({ www: 'www.a.com', host: 'a.com', fetch: f(reply(200)) })).ok, false);
  assert.equal((await checkWwwRedirect({ www: 'www.a.com', host: 'a.com', fetch: async () => { throw new Error('x'); } })).ok, false);
});

// ---------------------------------------------------------------- settings summary

test('the launch scripts save the short summary the settings page reads', async (t) => {
  const app = await tempApp({ shells: { mobile: {} } }, { withPlans: false });
  t.after(app.cleanup);
  const prof = fakeProfile();
  await recordLaunch(app.dir, { domain: { name: 'tea.example' } }, { profile: prof });
  await recordLaunch(app.dir, { email: { verified: true } }, { profile: prof });
  await recordLaunch(app.dir, { legal: { generatedAt: '2027-01-01' }, billing: { mode: 'test' } }, { profile: prof });
  const saved = prof.profile.apps.find((a) => a.slug === 'tea-shop');
  assert.deepEqual(saved.launch, { domain: 'tea.example', emailVerified: true, legalAt: '2027-01-01', billing: 'test', shells: ['mobile'] });
  assert.deepEqual(launchSummary({}), { domain: '', emailVerified: false, legalAt: '', billing: '', shells: [] });
});

// ---------------------------------------------------------------- legal text

async function content(extra = {}, modules = ['billing']) {
  const catalogue = await loadServices();
  return buildLegalContent({
    appName: 'Tea Shop', appDescription: '', controller: { name: 'Tea Ltd', address: '1 Tea St', email: 'hi@tea.example', phone: '+30 210 0', ...extra.controller },
    country: parseCountry('GR'), services: catalogue.services.filter((s) => (extra.ids ?? ['supabase', 'vercel', 'stripe', 'google', 'openai']).includes(s.id)), modules,
    plans: modules.includes('billing') ? [{ id: 'free', name: 'Free', priceCents: 0, currency: 'EUR', interval: 'month' }, { id: 'pro', name: 'Pro', priceCents: 900, currency: 'EUR', interval: 'month' }] : null,
    supabaseRegion: { code: 'eu-central-1' }, minAge: 16, today: '2027-01-01',
  });
}
const text = (section) => [section.title, ...section.paragraphs].join('\n');

test('terms: the withdrawal text matches what checkout and the app really do, and names the in-app button and the phone number', async () => {
  const c = await content();
  const w = text(c.terms.find((s) => s.id === 'right-to-withdraw'));
  assert.match(w, /tick a box at checkout/);
  assert.match(w, /ask us to start the service straight away/);
  assert.match(w, /"Withdraw from contract" in Settings, under Billing/);
  assert.match(w, /call \+30 210 0/);
  assert.doesNotMatch(w, /When you subscribe, you ask us/);
  assert.match(text(c.privacy.find((s) => s.id === 'who-we-are')), /by phone on \+30 210 0/);
  assert.match(text(c.terms.find((s) => s.id === 'contact-us')), /call \+30 210 0/);
  assert.equal(c.controller.phone, '+30 210 0');
});

test('a phone of "none" is left out of the text', async () => {
  const c = await content({ controller: { phone: 'none' } });
  assert.equal(c.controller.phone, undefined);
  assert.doesNotMatch(JSON.stringify(c), /by phone|call /);
});

test('legal text closes the smaller gaps: required data, processors own copies, Google acting for itself, changes for paying customers', async () => {
  const c = await content();
  assert.match(text(c.privacy.find((s) => s.id === 'what-we-collect')), /You need to give your email address and a password to have an account/);
  const keep = text(c.privacy.find((s) => s.id === 'how-long-we-keep-it'));
  assert.match(keep, /Stripe keeps your customer record/);
  assert.match(keep, /OpenAI may keep what you send to an AI feature for a limited time to check for abuse/);
  const who = text(c.privacy.find((s) => s.id === 'who-processes-your-data'));
  assert.match(who, /Most of them handle your data only for us/);
  assert.match(who, /Google, when you choose to sign in with it, acts for itself/);
  assert.doesNotMatch(who, /^We use these companies to run the app\. They handle your data for us/m);
  const stripeOnly = await content({ ids: ['supabase', 'vercel', 'stripe'] }, ['billing']);
  assert.match(text(stripeOnly.privacy.find((s) => s.id === 'who-processes-your-data')), /Most of them handle your data only for us and only for the purpose shown\. The exception is explained below/);
  assert.doesNotMatch(text(stripeOnly.privacy.find((s) => s.id === 'who-processes-your-data')), /Google/);
  const changes = text(c.terms.find((s) => s.id === 'changes-to-terms'));
  assert.match(changes, /you can cancel before it applies and get back the unused part of what you paid/);
  const free = await content({}, []);
  assert.match(text(free.terms.find((s) => s.id === 'changes-to-terms')), /you accept the new terms/);
});

test('legal-generate asks for a phone number only when the app takes payments', () => {
  const profile = { company: { legalName: 'a', address: 'b', contactEmail: 'c@d.ef' }, owner: { country: 'GR' } };
  assert.deepEqual(missingFacts(profile, 'GR').map((n) => n.path), []);
  assert.deepEqual(missingFacts(profile, 'GR', { billing: true }).map((n) => n.path), ['company.phone']);
  assert.deepEqual(missingFacts({ ...profile, company: { ...profile.company, phone: 'none' } }, 'GR', { billing: true }), []);
});
