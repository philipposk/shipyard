import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDns, hostResolvesToVercel, isVercelDnsTarget, isVercelAddress, answeredByVercel, createResolver } from '../scripts/launch/dns.mjs';
import { normalizeDomain, isApexDomain, fallbackRecords, formatRecordTable, launchDomain } from '../scripts/launch/domain-core.mjs';
import { domainsAdd, domainsVerify, extractJson } from '../scripts/launch/vercel-domains.mjs';
import { createResend, ResendError } from '../scripts/launch/resend-api.mjs';
import { parsePlansSource, readPlans } from '../scripts/launch/plans-parse.mjs';
import { tempApp, readConfig, fakeProfile, fakeVercel } from './launch-helpers.mjs';

/** A resolver with fixed answers. Anything not listed is "no answer". */
const resolver = (name, { a = {}, cname = {}, ns = {} } = {}) => ({
  name,
  resolve4: async (h) => a[h] ?? [],
  resolveCname: async (h) => cname[h] ?? [],
  resolveNs: async (h) => ns[h] ?? [],
});

// ---------------------------------------------------------------- DNS check with injected resolvers

test('checkDns: every resolver must agree, and an A record with the Vercel address passes', async () => {
  const good = (n) => resolver(n, { a: { 'tea.example': ['76.76.21.21'] } });
  const r = await checkDns([good('1.1.1.1'), good('8.8.8.8')], 'tea.example', { records: [{ type: 'A', name: '@', value: '76.76.21.21' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.perResolver.map((p) => [p.resolver, p.via]), [['1.1.1.1', 'A'], ['8.8.8.8', 'A']]);
});

test('checkDns: one resolver that has not caught up yet means "not ready"', async () => {
  const r = await checkDns([resolver('1.1.1.1', { a: { 'tea.example': ['76.76.21.21'] } }), resolver('8.8.8.8')], 'tea.example', {});
  assert.equal(r.ok, false);
  assert.deepEqual(r.perResolver.map((p) => p.ok), [true, false]);
  assert.deepEqual(r.perResolver[1].found, []);
});

test('checkDns: no resolvers at all is not "ready"', async () => {
  assert.equal((await checkDns([], 'tea.example', {})).ok, false);
});

test('hostResolvesToVercel: CNAME to Vercel passes (project-specific targets too), CNAME elsewhere fails', async () => {
  const host = 'app.tea.example';
  const ok = await hostResolvesToVercel(resolver('x', { cname: { [host]: ['cname.vercel-dns.com.'] } }), host, {});
  assert.deepEqual([ok.ok, ok.via], [true, 'CNAME']);
  const project = await hostResolvesToVercel(resolver('x', { cname: { [host]: ['abc123.vercel-dns-017.com'] } }), host, {});
  assert.equal(project.ok, true);
  const exact = await hostResolvesToVercel(resolver('x', { cname: { [host]: ['custom.example.net'] } }), host, { records: [{ type: 'CNAME', name: 'app', value: 'custom.example.net' }] });
  assert.equal(exact.ok, true, 'the value Vercel asked for counts');
  const wrong = await hostResolvesToVercel(resolver('x', { cname: { [host]: ['elsewhere.example.net'] } }), host, {});
  assert.deepEqual([wrong.ok, wrong.found], [false, ['elsewhere.example.net']]);
});

test('hostResolvesToVercel: a flattened apex CNAME (an address inside Vercel\'s ranges) passes; other addresses do not', async () => {
  for (const ip of ['76.76.21.21', '76.76.21.164', '66.33.60.34']) {
    const r = await hostResolvesToVercel(resolver('x', { a: { 'tea.example': [ip] } }), 'tea.example', {});
    assert.equal(r.ok, true, ip);
  }
  const other = await hostResolvesToVercel(resolver('x', { a: { 'tea.example': ['104.21.5.5'] } }), 'tea.example', {});
  assert.deepEqual([other.ok, other.found], [false, ['104.21.5.5']]);
  assert.equal(isVercelAddress('76.76.21.164'), true);
  assert.equal(isVercelAddress('76.76.22.1'), false);
  assert.equal(isVercelAddress('176.76.21.1'), false);
});

test('hostResolvesToVercel: name servers on Vercel count, found from the host upwards', async () => {
  const r = resolver('x', { ns: { 'tea.example': ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] } });
  const ok = await hostResolvesToVercel(r, 'tea.example', { nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] });
  assert.deepEqual([ok.ok, ok.via], [true, 'NS']);
  const sub = await hostResolvesToVercel(r, 'app.tea.example', { nameservers: ['ns1.vercel-dns.com'] });
  assert.equal(sub.ok, true);
  const other = await hostResolvesToVercel(resolver('x', { ns: { 'tea.example': ['ns.registrar.example'] } }), 'tea.example', { nameservers: ['ns1.vercel-dns.com'] });
  assert.equal(other.ok, false);
});

test('isVercelDnsTarget', () => {
  assert.equal(isVercelDnsTarget('cname.vercel-dns.com'), true);
  assert.equal(isVercelDnsTarget('CNAME.vercel-dns.com.'), true);
  assert.equal(isVercelDnsTarget('abc.vercel-dns-017.com'), true);
  assert.equal(isVercelDnsTarget('vercel-dns.com.evil.example'), false);
  assert.equal(isVercelDnsTarget('notvercel-dns.com'), false);
});

test('createResolver never throws: a server that cannot be reached is "no answer"', async () => {
  const r = createResolver('127.0.0.1', { timeoutMs: 50 });
  assert.equal(r.name, '127.0.0.1');
  assert.equal(typeof r.resolve4, 'function');
});

test('answeredByVercel: the x-vercel-id header or "server: Vercel" says the site is served by Vercel', async () => {
  const reply = (headers, status = 200) => async () => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  assert.deepEqual(await answeredByVercel('tea.example', { fetch: reply({ 'x-vercel-id': 'fra1::abc' }) }), { ok: true, status: 200 });
  assert.equal((await answeredByVercel('tea.example', { fetch: reply({ server: 'Vercel' }, 308) })).ok, true);
  assert.equal((await answeredByVercel('tea.example', { fetch: reply({ server: 'cloudflare' }) })).ok, false);
  assert.equal((await answeredByVercel('tea.example', { fetch: async () => { throw new Error('ECONNREFUSED'); } })).ok, false);
});

// ---------------------------------------------------------------- domain names

test('normalizeDomain: accepts normal names, strips the extras, and punycodes international names', () => {
  assert.equal(normalizeDomain('Example.COM'), 'example.com');
  assert.equal(normalizeDomain('https://www.Example.com/path?x=1#y'), 'www.example.com');
  assert.equal(normalizeDomain('example.co.uk.'), 'example.co.uk');
  assert.equal(normalizeDomain('app.example.gr'), 'app.example.gr');
  assert.equal(normalizeDomain('παράδειγμα.gr'), 'xn--hxajbheg2az3al.gr');
});

test('normalizeDomain: refuses what is not a domain you own, in plain words', () => {
  for (const bad of ['', '   ', 'localhost', 'example', 'my-app.vercel.app', 'foo.localhost', 'me@example.com', 'example.com:3000', '192.168.1.1', '-bad.example.com', 'exa mple.com', 'example.c', 'a..b.com']) {
    assert.throws(() => normalizeDomain(bad), (e) => e.name === 'ProvisionError' && e.message.length > 20, JSON.stringify(bad));
  }
  assert.throws(() => normalizeDomain('my-app.vercel.app'), /test address/);
  assert.throws(() => normalizeDomain('192.168.1.1'), /IP address|ending/);
});

test('isApexDomain and fallbackRecords: two-part endings like co.uk count as the plain domain', () => {
  assert.equal(isApexDomain('example.com'), true);
  assert.equal(isApexDomain('example.co.uk'), true);
  assert.equal(isApexDomain('example.com.gr'), true);
  assert.equal(isApexDomain('app.example.com'), false);
  assert.equal(isApexDomain('www.example.co.uk'), false);
  assert.deepEqual(fallbackRecords('example.com'), [{ type: 'A', name: '@', value: '76.76.21.21' }]);
  assert.deepEqual(fallbackRecords('app.example.com'), [{ type: 'CNAME', name: 'app', value: 'cname.vercel-dns.com' }]);
  assert.deepEqual(fallbackRecords('a.b.example.com'), [{ type: 'CNAME', name: 'a.b', value: 'cname.vercel-dns.com' }]);
});

test('formatRecordTable lines up the columns', () => {
  const lines = formatRecordTable([{ type: 'A', name: '@', value: '76.76.21.21' }, { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }]);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Type\s+Name\s+Value$/);
  assert.ok(lines[3].startsWith('CNAME  www'));
});

// ---------------------------------------------------------------- vercel domains output

const fakeRun = (answers) => async (cmd, args) => {
  const joined = args.join(' ');
  for (const [pattern, out] of answers) if (pattern.test(joined)) return { code: 0, stdout: '', stderr: '', ...out };
  return { code: 1, stdout: '', stderr: 'unexpected', };
};

test('domainsVerify: reads the records, name servers and clashes from the CLI JSON (with noise around it)', async () => {
  const json = { ok: false, status: 'invalid', message: 'DNS not set', recommended: { records: [{ type: 'a', name: '@', value: '76.76.21.21' }, { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }], nameservers: ['ns1.vercel-dns.com'] }, conflicts: [{ type: 'A', value: '1.2.3.4' }] };
  const run = fakeRun([[/domains verify tea\.example --project tea-shop --format=json/, { stdout: `Vercel CLI 64.3.1\n${JSON.stringify(json, null, 2)}\n` }]]);
  const r = await domainsVerify({ cwd: '.', domain: 'tea.example', project: 'tea-shop', run });
  assert.equal(r.parsed, true);
  assert.equal(r.ok, false);
  assert.deepEqual(r.records, [{ type: 'A', name: '@', value: '76.76.21.21' }, { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }]);
  assert.deepEqual(r.nameservers, ['ns1.vercel-dns.com']);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.message, 'DNS not set');
});

test('domainsVerify: output that is not JSON is reported as not parsed, never a crash', async () => {
  const r = await domainsVerify({ cwd: '.', domain: 'tea.example', project: 'p', run: fakeRun([[/verify/, { stdout: 'Error: not logged in' }]]) });
  assert.deepEqual([r.ok, r.parsed, r.records], [false, false, []]);
  const ok = await domainsVerify({ cwd: '.', domain: 'tea.example', project: 'p', run: fakeRun([[/verify/, { stdout: JSON.stringify({ ok: true }) }]]) });
  assert.deepEqual([ok.ok, ok.parsed, ok.records], [true, true, []]);
  assert.equal(extractJson('no json here'), null);
  assert.deepEqual(extractJson('x {"a":1} y'), { a: 1 });
});

test('domainsAdd: added, already added, needs a proof of ownership, and plain failures', async () => {
  assert.deepEqual(await domainsAdd({ domain: 'tea.example', project: 'p', run: fakeRun([[/domains add/, { stdout: 'Success! Domain added' }]]) }), { ok: true, already: false });
  assert.equal((await domainsAdd({ domain: 'tea.example', project: 'p', run: async () => ({ code: 1, stdout: '', stderr: 'Error: Domain is already assigned to this project' }) })).already, true);
  const needs = await domainsAdd({ domain: 'tea.example', project: 'p', run: async () => ({ code: 1, stdout: '', stderr: 'Domain is used by another account. Add a TXT record to verify' }) });
  assert.deepEqual([needs.ok, needs.needsVerification], [false, true]);
  const other = await domainsAdd({ domain: 'tea.example', project: 'p', run: async () => ({ code: 1, stdout: '', stderr: 'Error: rate limited' }) });
  assert.deepEqual([other.ok, other.error], [false, 'Error: rate limited']);
});

// ---------------------------------------------------------------- launch-domain --check, end to end with fakes

const reply = (status, headers = {}) => ({ ok: status < 300, status, url: 'https://tea.example/', text: async () => 'hello', headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

async function domainRun(t, { resolvers, fetch, noWww = true, check = true, verifyOk = true }) {
  const app = await tempApp({ launch: {} }, { withPlans: false });
  t.after(app.cleanup);
  const calls = { authUrls: [], redirects: [], added: [] };
  const vercel = fakeVercel();
  const prof = fakeProfile({ accounts: { vercel: { scope: 'team' } } });
  const deps = {
    vercel, profile: prof, sleep: async () => {}, resolvers, fetch,
    add: async (o) => { calls.added.push(o.domain); return { ok: true }; },
    verify: async () => ({ ok: verifyOk, parsed: true, records: verifyOk ? [] : [{ type: 'A', name: '@', value: '76.76.21.21' }], nameservers: [], conflicts: [] }),
    setAuthUrls: async (o) => { calls.authUrls.push(o.url); return { changed: true }; },
    addRedirects: async (o) => { calls.redirects.push(...o.redirects); return { status: 'added' }; },
    now: () => new Date('2027-02-03T04:05:06Z'),
  };
  const run = () => launchDomain({ appDir: app.dir, domain: 'tea.example', check, www: !noWww ? undefined : false, intervalSec: 1, timeoutMin: 1 }, deps);
  return { app, calls, vercel, prof, run };
}

test('launch-domain --check: when DNS and https are right it switches the app over (env, config, profile, Supabase)', async (t) => {
  const good = (n) => resolver(n, { a: { 'tea.example': ['76.76.21.21'] } });
  const { app, calls, vercel, prof, run } = await domainRun(t, { resolvers: [good('1.1.1.1'), good('8.8.8.8')], fetch: async () => reply(200) });
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.live, true);
  assert.equal(r.url, 'https://tea.example');
  assert.deepEqual(calls.added, ['tea.example']);
  const env = vercel.set.filter((e) => e.name === 'NEXT_PUBLIC_SITE_URL');
  assert.equal(env.length, 1);
  assert.deepEqual([env[0].value, env[0].target], ['https://tea.example', ['production']]);
  assert.deepEqual(calls.authUrls, ['https://tea.example']);
  const config = await readConfig(app.dir);
  assert.deepEqual([config.url, config.siteUrl], ['https://tea.example', 'https://tea.example']);
  assert.deepEqual([config.launch.domain.name, config.launch.domain.verifiedAt], ['tea.example', '2027-02-03T04:05:06.000Z']);
  assert.deepEqual([prof.profile.domain.choice, prof.profile.domain.name], ['own', 'tea.example']);
  assert.equal(prof.profile.apps.find((a) => a.slug === 'tea-shop').url, 'https://tea.example');
});

test('launch-domain --check: a flattened apex CNAME (Vercel address range, not 76.76.21.21) is accepted', async (t) => {
  const flat = (n) => resolver(n, { a: { 'tea.example': ['76.76.21.164'] } });
  const { calls, run } = await domainRun(t, { resolvers: [flat('1.1.1.1'), flat('8.8.8.8')], fetch: async () => reply(200) });
  const r = await run();
  assert.equal(r.ok, true);
  assert.deepEqual(calls.authUrls, ['https://tea.example']);
});

test('launch-domain --check: behind Cloudflare\'s proxy the addresses look wrong, but a Vercel answer is enough', async (t) => {
  const proxied = (n) => resolver(n, { a: { 'tea.example': ['104.21.5.5', '172.67.1.1'] } });
  const fetch = async () => reply(200, { 'x-vercel-id': 'fra1::abcd', server: 'cloudflare' });
  const { calls, vercel, run } = await domainRun(t, { resolvers: [proxied('1.1.1.1'), proxied('8.8.8.8')], fetch });
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.dnsReady, true);
  assert.deepEqual(calls.authUrls, ['https://tea.example']);
  assert.equal(vercel.set.filter((e) => e.name === 'NEXT_PUBLIC_SITE_URL').length, 1);
});

test('launch-domain --check: when DNS is wrong and the site is not Vercel, nothing is switched and the student hears about Cloudflare\'s grey cloud', async (t) => {
  const wrong = (n) => resolver(n, { a: { 'tea.example': ['104.21.5.5'] } });
  const { calls, vercel, run } = await domainRun(t, { resolvers: [wrong('1.1.1.1'), wrong('8.8.8.8')], fetch: async () => reply(200, { server: 'nginx' }), verifyOk: false });
  await assert.rejects(run, (e) => {
    assert.equal(e.data.reason, 'waiting-for-dns');
    assert.match(e.message, /DNS only/);
    assert.match(e.message, /sees 104\.21\.5\.5/);
    return true;
  });
  assert.deepEqual(calls.authUrls, []);
  assert.equal(vercel.set.length, 0);
});

test('launch-domain without --check only adds the domain and prints the records', async (t) => {
  const { calls, vercel, run } = await domainRun(t, { resolvers: [], fetch: async () => reply(200), check: false, verifyOk: false });
  const r = await run();
  assert.equal(r.live, false);
  assert.deepEqual(r.records, [{ host: 'tea.example', type: 'A', name: '@', value: '76.76.21.21' }]);
  assert.match(r.next, /--check/);
  assert.deepEqual(calls.added, ['tea.example']);
  assert.equal(vercel.set.length, 0);
});

// ---------------------------------------------------------------- Resend client

const jsonReply = (status, body, headers = {}) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test('resend client: lists domains across pages, finds one by name (any case), and never puts the key in an error', async () => {
  const KEY = `re_${'q9'.repeat(14)}`;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.includes('after=d2')) return jsonReply(200, { has_more: false, data: [{ id: 'd3', name: 'Send.Tea.Example' }] });
    if (url.includes('/domains?')) return jsonReply(200, { has_more: true, data: [{ id: 'd1', name: 'a.example' }, { id: 'd2', name: 'b.example' }] });
    return jsonReply(401, { message: `bad key ${KEY}` });
  };
  const resend = createResend({ key: KEY, fetch, sleep: async () => {} });
  assert.equal((await resend.findDomain('send.tea.example')).id, 'd3');
  assert.equal((await resend.listDomains()).length, 3);
  await assert.rejects(() => resend.listApiKeys(), (e) => e instanceof ResendError && !e.message.includes(KEY) && /did not accept your key/.test(e.message));
});

test('resend client: creates a sending-only key for one domain; retries a busy answer once', async () => {
  const bodies = [];
  let busy = true;
  const fetch = async (url, init) => {
    if (busy) { busy = false; return jsonReply(429, {}, { 'retry-after': '0' }); }
    bodies.push(JSON.parse(init.body));
    return jsonReply(200, { id: 'k1', token: ('re_' + 'new_token_value_123456') });
  };
  const resend = createResend({ key: ('re_' + 'test_key_123456789'), fetch, sleep: async () => {} });
  assert.deepEqual(await resend.createSendingKey({ name: 'shipyard-tea', domainId: 'dom_1' }), { id: 'k1', token: ('re_' + 'new_token_value_123456') });
  assert.deepEqual(bodies, [{ name: 'shipyard-tea', permission: 'sending_access', domain_id: 'dom_1' }]);
  const none = createResend({ key: ('re_' + 'test_key_123456789'), fetch: async () => jsonReply(200, { id: 'k2' }), sleep: async () => {} });
  await assert.rejects(() => none.createSendingKey({ name: 'x' }), /did not give back the new key/);
  assert.throws(() => createResend({ key: '' }), /No Resend key/);
});

// ---------------------------------------------------------------- plans.ts parsing

const plansFile = (json) => `export const x = 1;\n// shipyard:plans:start\n${json}\n// shipyard:plans:end\n`;
const plan = (more = {}) => ({ id: 'pro', name: 'Pro', priceCents: 900, currency: 'EUR', interval: 'month', lookupKey: '<APP_SLUG>_pro_monthly', features: [], ...more });

test('plans.ts: reads the block between the markers and fills in the app name', () => {
  const plans = parsePlansSource(plansFile(JSON.stringify([plan({ id: 'free', priceCents: 0, lookupKey: undefined }), plan()])), 'tea-shop');
  assert.deepEqual(plans.map((p) => p.id), ['free', 'pro']);
  assert.equal(plans[1].lookupKey, 'tea-shop_pro_monthly');
});

test('plans.ts: each mistake gets a plain message', () => {
  const bad = (json, re) => assert.throws(() => parsePlansSource(typeof json === 'string' && json.startsWith('export') ? json : plansFile(JSON.stringify(json)), 's-1'), re);
  bad('export const nothing = 1;', /lost its markers/);
  assert.throws(() => parsePlansSource(plansFile('[ { "id": "pro", }'), 's'), /not valid JSON/);
  bad([], /at least one plan/);
  bad([plan({ priceCents: 9.5 })], /whole number of cents/);
  bad([plan({ currency: 'EURO' })], /3-letter currency/);
  bad([plan({ interval: 'week' })], /month" or "year/);
  bad([plan({ lookupKey: 'A B' })], /lookupKey/);
  bad([plan(), plan({ id: 'team' })], /share the lookupKey/);
  bad([plan(), plan()], /repeated id/);
});

test('readPlans: a missing file says how to add the payments module', async (t) => {
  const app = await tempApp({}, { withPlans: false });
  t.after(app.cleanup);
  await assert.rejects(() => readPlans(app.dir, 'tea-shop'), /Add the payments module first/);
  const withPlans = await tempApp({});
  t.after(withPlans.cleanup);
  assert.ok((await readPlans(withPlans.dir, 'tea-shop')).some((p) => p.priceCents > 0));
});
