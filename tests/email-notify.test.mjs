import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appDisplayName, senderFor, buildEmail, main as notifyMain } from '../scripts/notify.mjs';
import { analyse, dohResolver, main as checkMain } from '../scripts/email-check.mjs';

test('appDisplayName turns slugs into names and keeps real names', () => {
  assert.equal(appDisplayName('ballpark'), 'Ballpark');
  assert.equal(appDisplayName('journal-find'), 'Journal Find');
  assert.equal(appDisplayName('My App'), 'My App');
  assert.equal(appDisplayName(''), 'Shipyard');
  assert.equal(appDisplayName('--', '6x7'), '6x7');
});

test('senderFor keeps the verified address and uses the app name', () => {
  assert.equal(senderFor('Ballpark', 'CommitR <noreply@6x7.gr>'), 'Ballpark <noreply@6x7.gr>');
  assert.equal(senderFor('Ballpark', 'noreply@6x7.gr'), 'Ballpark <noreply@6x7.gr>');
  assert.equal(senderFor('Bad"<x>\r\n', ''), 'Badx <onboarding@resend.dev>');
});

test('buildEmail: live email has the why line first and escapes html', () => {
  const e = buildEmail({ app: 'ballpark', url: 'https://ballpark.6x7.gr', to: 'a@b.c', from: 'noreply@6x7.gr' });
  assert.equal(e.subject, 'Ballpark is live on ballpark.6x7.gr');
  assert.ok(e.text.startsWith("You're receiving this because you deployed Ballpark to ballpark.6x7.gr."));
  assert.equal(e.from, 'Ballpark <noreply@6x7.gr>');
  const x = buildEmail({ app: 'a', url: 'https://x.io/?q=<b>', kind: 'custom', subject: 's', message: '<script>', reason: 'r' });
  assert.ok(!x.html.includes('<script>') && !x.html.includes('<b>'));
  assert.throws(() => buildEmail({ app: 'a', url: 'nope' }), /full address/);
  assert.throws(() => buildEmail({ app: 'a', url: 'javascript:alert(1)' }), /https/);
  assert.throws(() => buildEmail({ app: 'a', url: 'https://x.io', kind: 'custom' }), /--subject/);
});

test('notify --dry-run sends nothing; a real send posts once without the key in the body', async () => {
  let calls = 0;
  const deps = {
    loadProfile: async () => ({ owner: { email: 'me@x.io' }, accounts: { resend: { domain: 'send.x.io' } } }),
    readSecrets: async () => new Map([['RESEND_API_KEY', 're_fake_key_1234567']]),
    fetch: async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://api.resend.com/emails');
      const body = JSON.parse(init.body);
      assert.equal(body.from, 'Shop <noreply@send.x.io>');
      assert.ok(!init.body.includes('re_fake'));
      return { ok: true, status: 200 };
    },
  };
  assert.equal(await notifyMain(['shop', '--url', 'https://shop.x.io', '--dry-run', '--json'], deps), 0);
  assert.equal(calls, 0);
  assert.equal(await notifyMain(['shop', '--url', 'https://shop.x.io', '--json'], deps), 0);
  assert.equal(calls, 1);
});

const GOOD = {
  mx: [{ exchange: 'mx1.improvmx.com', priority: 10 }, { exchange: 'mx2.improvmx.com', priority: 20 }],
  txt: [['v=spf1 include:spf.improvmx.com ~all']],
  dmarc: [['v=DMARC1; p=none;']],
  dkim: [['p=MIGf']],
  sendTxt: [['v=spf1 include:amazonses.com ~all']],
  sendMx: [{ exchange: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }],
};

test('analyse: the real 6x7.gr shape passes', () => {
  const r = analyse('6x7.gr', GOOD);
  assert.equal(r.ok, true);
  assert.ok(r.checks.find((c) => c.id === 'mx').text.includes('ImprovMX'));
});

test('analyse: missing MX, two SPF lines, SPF without ImprovMX, missing DMARC', () => {
  assert.equal(analyse('a.io', { ...GOOD, mx: [] }).checks.find((c) => c.id === 'mx').ok, false);
  assert.match(analyse('a.io', { ...GOOD, txt: [['v=spf1 ~all'], ['v=spf1 -all']] }).checks.find((c) => c.id === 'spf').text, /more than one/);
  assert.match(analyse('a.io', { ...GOOD, txt: [['v=spf1 include:_spf.google.com ~all']] }).checks.find((c) => c.id === 'spf').text, /ImprovMX/);
  const d = analyse('a.io', { ...GOOD, dmarc: [] });
  assert.equal(d.ok, false);
  assert.match(d.checks.find((c) => c.id === 'dmarc').fix, /_dmarc/);
  // Sending subdomain problems warn but do not fail receiving.
  assert.equal(analyse('a.io', { ...GOOD, dkim: [] }).ok, true);
});

test('dohResolver parses MX and quoted TXT answers', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => (url.includes('type=MX')
      ? { Status: 0, Answer: [{ type: 15, data: '10 mx1.improvmx.com.' }] }
      : { Status: 0, Answer: [{ type: 5, data: 'x.' }, { type: 16, data: '"v=spf1 " "~all"' }] }),
  });
  const r = dohResolver(fetchImpl);
  assert.deepEqual(await r.resolveMx('a.io'), [{ priority: 10, exchange: 'mx1.improvmx.com' }]);
  assert.deepEqual(await r.resolveTxt('a.io'), [['v=spf1 ~all']]);
  const nx = dohResolver(async () => ({ ok: true, json: async () => ({ Status: 3 }) }));
  await assert.rejects(nx.resolveTxt('x.a.io'), (e) => e.code === 'ENOTFOUND');
});

test('email-check main uses an injected resolver and rejects bad domains', async () => {
  const resolver = {
    resolveMx: async (n) => (n === 'a.io' ? GOOD.mx : []),
    resolveTxt: async (n) => (n === 'a.io' ? GOOD.txt : n === '_dmarc.a.io' ? GOOD.dmarc : []),
  };
  assert.equal(await checkMain(['a.io', '--json'], { resolver }), 0);
  await assert.rejects(checkMain(['not a domain']), /Give a domain/);
});

test('analyse: existing non-Resend sending records are only reported, never replaced', () => {
  const r = analyse('a.io', { ...GOOD, dkim: [] });
  const send = r.checks.find((c) => c.id === 'send');
  assert.equal(send.ok, false);
  assert.match(send.fix, /leave them as they are/);
  assert.doesNotMatch(send.fix, /launch-email/);
  const none = analyse('a.io', { ...GOOD, dkim: [], sendTxt: [], sendMx: [] }).checks.find((c) => c.id === 'send');
  assert.match(none.fix, /Only if/);
});

test('analyse: Gmail send-as warns when the one SPF line lacks Google and suggests a merged line', () => {
  const rec = { mx: [{ exchange: 'mx1.improvmx.com' }], txt: [['v=spf1 include:spf.improvmx.com ~all']], dmarc: [['v=DMARC1; p=none;']] };
  assert.equal(analyse('6x7.gr', rec, '').checks.some((c) => c.id === 'spf-gmail'), false);
  const r = analyse('6x7.gr', rec, '', { gmailSendAs: true });
  const w = r.checks.find((c) => c.id === 'spf-gmail');
  assert.ok(w && !w.ok && w.optional);
  assert.match(w.fix, /"v=spf1 include:spf\.improvmx\.com include:_spf\.google\.com ~all"/);
  assert.match(w.fix, /exactly one/);
  const good = { ...rec, txt: [['v=spf1 include:spf.improvmx.com include:_spf.google.com ~all']] };
  assert.equal(analyse('6x7.gr', good, '', { gmailSendAs: true }).checks.some((c) => c.id === 'spf-gmail'), false);
  const none = analyse('6x7.gr', { ...rec, txt: [] }, '', { gmailSendAs: true }).checks.find((c) => c.id === 'spf');
  assert.match(none.fix, /include:spf\.improvmx\.com include:_spf\.google\.com ~all/);
});
