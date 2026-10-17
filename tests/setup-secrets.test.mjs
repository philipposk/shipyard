// secrets-init and secrets-check. The "live" checks use a fake fetch: no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = await mkdtemp(path.join(os.tmpdir(), 'secrets-test-'));
process.env.SHIPYARD_HOME = HOME; // before the scripts load their paths
const { checkSecrets, liveCheck, interpretStatus, orgsLine } = await import('../scripts/secrets-check.mjs');
const { editorCommand } = await import('../scripts/secrets-init.mjs');

after(() => rm(HOME, { recursive: true, force: true }));

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const SECRETS = path.join(HOME, 'secrets.env');
const PROFILE = path.join(HOME, 'profile.json');

const run = (script, ...args) =>
  spawnSync(process.execPath, [path.join(dir, script), ...args], { env: { ...process.env, SHIPYARD_HOME: HOME, NO_COLOR: '1' }, encoding: 'utf8' });

// Made-up values, assembled so no real-looking key sits in this file.
const V = {
  sb: `sbp_${'a1b2c3d4e5'.repeat(3)}`,
  or: `sk-or-v1-${'f0e1d2c3b4'.repeat(3)}`,
  oa: `sk-${'q1w2e3r4t5'.repeat(3)}`,
  re: `re_${'z9y8x7w6v5'.repeat(3)}`,
  st: `sk_test_${'m1n2b3v4c5'.repeat(3)}`,
};
const allValues = Object.values(V);
const noLeak = (text) => allValues.every((v) => !text.includes(v));

async function reset() {
  await rm(SECRETS, { force: true });
  await rm(PROFILE, { force: true });
}

function reply(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

function fakeFetch(routes, seen = []) {
  return async (url, init = {}) => {
    seen.push({ url: String(url), auth: init.headers?.Authorization });
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) throw new TypeError('network down');
    const r = typeof hit[1] === 'function' ? hit[1](url, init) : hit[1];
    return r;
  };
}

// ---------- secrets-init ----------

test('init --no-open creates the file privately and tells the student what to do', async () => {
  await reset();
  const r = run('secrets-init.mjs', '--no-open');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Paste your keys, save, close, then tell Claude 'done'/);
  const text = await readFile(SECRETS, 'utf8');
  assert.match(text, /SUPABASE_ACCESS_TOKEN=\n/);
  assert.match(text, /GOOGLE_CLIENT_SECRET=/);
  if (process.platform !== 'win32') assert.equal((await stat(SECRETS)).mode & 0o777, 0o600);
});

test('init again keeps existing values and never prints them', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\n`);
  const r = run('secrets-init.mjs', '--no-open', '--json');
  assert.equal(r.status, 0);
  assert.ok(noLeak(r.stdout + r.stderr));
  const out = JSON.parse(r.stdout);
  assert.equal(out.created, false);
  assert.equal(out.opened, false);
  assert.ok(!out.added.includes('SUPABASE_ACCESS_TOKEN'));
  assert.match(await readFile(SECRETS, 'utf8'), new RegExp(`SUPABASE_ACCESS_TOKEN=${V.sb}`));
});

test('editorCommand picks the right program per system', async () => {
  assert.deepEqual(await editorCommand('/f', 'darwin'), ['open', ['-t', '/f']]);
  assert.deepEqual(await editorCommand('C:\\f', 'win32'), ['notepad', ['C:\\f']]);
  assert.deepEqual(await editorCommand('/f', 'linux', async (c) => (c === 'code' ? '/usr/bin/code' : null)), ['code', ['/f']]);
  assert.deepEqual(await editorCommand('/f', 'linux', async () => null), ['xdg-open', ['/f']]);
});

// ---------- secrets-check, offline ----------

test('check offline: missing required key exits 1 and points to the hint', async () => {
  await reset();
  const r = run('secrets-check.mjs');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✗ SUPABASE_ACCESS_TOKEN: missing/);
  assert.match(r.stdout, /Access Tokens/);
  assert.match(r.stdout, /- OPENAI_API_KEY: not set \(optional\)/);
});

test('check offline: good required key exits 0; odd optional key is a warning; no values printed', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\nOPENAI_API_KEY=oops\nRESEND_API_KEY=${V.re}\n`);
  const r = run('secrets-check.mjs');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /✓ SUPABASE_ACCESS_TOKEN: saved and the format looks right/);
  assert.match(r.stdout, /! OPENAI_API_KEY: saved, but the format looks wrong/);
  assert.ok(noLeak(r.stdout + r.stderr));
  assert.ok(!r.stdout.includes('oops'));
  const j = JSON.parse(run('secrets-check.mjs', '--json').stdout);
  assert.equal(j.live, false);
  assert.equal(j.keys.find((k) => k.name === 'OPENAI_API_KEY').looksValid, false);
  assert.ok(!JSON.stringify(j).includes('oops'));
  assert.ok(!('hint' in j.keys[0]));
});

test('check offline: a required key in the wrong format fails', async () => {
  await reset();
  await writeFile(SECRETS, 'SUPABASE_ACCESS_TOKEN=not-a-token\n');
  const r = run('secrets-check.mjs');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✗ SUPABASE_ACCESS_TOKEN: saved, but the format looks wrong/);
});

test('check offline does not touch the profile', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\n`);
  run('secrets-check.mjs');
  await assert.rejects(stat(PROFILE));
});

test('check: bad flag is 2, --help is 0', () => {
  assert.equal(run('secrets-check.mjs', '--nope').status, 2);
  assert.equal(run('secrets-check.mjs', '--help').status, 0);
  assert.equal(run('secrets-init.mjs', '--nope').status, 2);
});

// ---------- secrets-check, live (fake fetch) ----------

test('interpretStatus', () => {
  assert.equal(interpretStatus('X', 200).ok, true);
  assert.equal(interpretStatus('X', 401).ok, false);
  assert.equal(interpretStatus('X', 401).inconclusive, undefined);
  assert.equal(interpretStatus('X', 429).inconclusive, true);
  assert.equal(interpretStatus('X', 503).inconclusive, true);
});

test('live: results update the profile, orgs are listed, no value leaks', async () => {
  await reset();
  await writeFile(SECRETS, [
    `SUPABASE_ACCESS_TOKEN=${V.sb}`,
    `OPENROUTER_API_KEY=${V.or}`,
    `OPENAI_API_KEY=${V.oa}`,
    `RESEND_API_KEY=${V.re}`,
    `STRIPE_SECRET_KEY=${V.st}`,
    '',
  ].join('\n'));
  const seen = [];
  const fetchImpl = fakeFetch({
    'https://api.supabase.com/v1/organizations': reply(200, [{ id: 'abc', slug: 'abc', name: 'My Org' }]),
    'https://openrouter.ai/api/v1/key': reply(401, { error: 'bad' }),
    'https://api.openai.com/v1/models': reply(200, { data: [] }),
    'https://api.resend.com/domains': reply(200, { data: [{ name: 'example.com', status: 'verified' }] }),
    'https://api.stripe.com/v1/balance': reply(200, { object: 'balance' }),
  }, seen);

  const result = await checkSecrets({ live: true, fetchImpl });
  const by = Object.fromEntries(result.keys.map((k) => [k.name, k]));
  assert.equal(result.ok, false); // OpenRouter rejected
  assert.equal(by.SUPABASE_ACCESS_TOKEN.ok, true);
  assert.equal(by.OPENROUTER_API_KEY.ok, false);
  assert.match(by.OPENROUTER_API_KEY.live.reason, /did not accept/);
  assert.deepEqual(result.orgs, [{ slug: 'abc', name: 'My Org' }]);
  assert.ok(noLeak(JSON.stringify(result)));
  assert.equal(seen.length, 5);
  assert.ok(seen.every((s) => s.auth?.startsWith('Bearer ')));

  const p = JSON.parse(await readFile(PROFILE, 'utf8'));
  assert.equal(p.accounts.supabase.ok, false); // key works, but no organization is saved yet
  assert.equal(p.accounts.openrouter.ok, false);
  assert.equal(p.accounts.openai.ok, true);
  assert.equal(p.accounts.resend.ok, true);
  assert.equal(p.accounts.resend.domain, 'example.com');
  assert.equal(p.accounts.stripe.ok, true);
  assert.equal(p.accounts.stripe.mode, 'test');
});

test('live: Supabase is marked connected only once an organization is saved', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\n`);
  const fetchImpl = fakeFetch({ 'https://api.supabase.com/': reply(200, [{ id: 'abc', slug: 'abc', name: 'My Org' }]) });
  await checkSecrets({ live: true, fetchImpl });
  assert.equal(JSON.parse(await readFile(PROFILE, 'utf8')).accounts.supabase.ok, false);
  const p = JSON.parse(await readFile(PROFILE, 'utf8'));
  p.accounts.supabase.orgId = 'abc';
  await writeFile(PROFILE, JSON.stringify(p));
  await checkSecrets({ live: true, fetchImpl });
  assert.equal(JSON.parse(await readFile(PROFILE, 'utf8')).accounts.supabase.ok, true);
});

test('organizations are printed as "name: slug=<id>"', () => {
  const line = orgsLine([{ slug: 'vercel_icfg_x', name: "Team's projects" }, { slug: 'abc', name: 'Main' }]);
  assert.match(line, /Team's projects: slug=vercel_icfg_x; Main: slug=abc/);
});

test('live: everything accepted gives ok', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\n`);
  const result = await checkSecrets({ live: true, fetchImpl: fakeFetch({ 'https://api.supabase.com/': reply(200, []) }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.orgs, []);
});

test('live: a rejected required key fails and is saved as not ok', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\n`);
  const result = await checkSecrets({ live: true, fetchImpl: fakeFetch({ 'https://api.supabase.com/': reply(401, { message: 'nope' }) }) });
  assert.equal(result.ok, false);
  const k = result.keys[0];
  assert.equal(k.live.ok, false);
  assert.match(k.live.reason, /did not accept your access token/i);
  assert.equal(JSON.parse(await readFile(PROFILE, 'utf8')).accounts.supabase.ok, false);
});

test('live: network trouble or rate limits change nothing in the profile', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\nOPENAI_API_KEY=${V.oa}\nOPENROUTER_API_KEY=${V.or}\n`);
  const result = await checkSecrets({
    live: true,
    fetchImpl: fakeFetch({ 'https://api.openai.com/': reply(429, {}), 'https://openrouter.ai/': reply(503, {}) }),
  });
  const by = Object.fromEntries(result.keys.map((k) => [k.name, k]));
  assert.equal(by.SUPABASE_ACCESS_TOKEN.live.inconclusive, true); // fetch threw
  assert.match(by.SUPABASE_ACCESS_TOKEN.live.reason, /Could not reach Supabase/);
  assert.equal(by.OPENAI_API_KEY.live.inconclusive, true);
  assert.equal(by.OPENAI_API_KEY.ok, true); // format was fine, provider just busy
  assert.equal(result.ok, true);
  await assert.rejects(stat(PROFILE)); // nothing learned, nothing saved
});

test('live: Resend send-only keys count as working', async () => {
  const r = await liveCheck('RESEND_API_KEY', V.re, fakeFetch({ 'https://api.resend.com/': reply(401, { name: 'restricted_api_key', message: 'x' }) }));
  assert.equal(r.ok, true);
});

test('live: Stripe live key is noticed', async () => {
  const live = `sk_live_${'a1'.repeat(15)}`;
  const r = await liveCheck('STRIPE_SECRET_KEY', live, fakeFetch({ 'https://api.stripe.com/': reply(200, {}) }));
  assert.equal(r.details.mode, 'live');
});

test('live: values with spaces are not sent', async () => {
  const seen = [];
  const r = await liveCheck('OPENAI_API_KEY', 'sk-abc def', fakeFetch({ 'https://': reply(200, {}) }, seen));
  assert.equal(r.ok, false);
  assert.equal(seen.length, 0);
});

test('live: keys without a live check (Google, Stripe publishable) are format-only', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\nGOOGLE_CLIENT_ID=abc.apps.googleusercontent.com\n`);
  const seen = [];
  const result = await checkSecrets({ live: true, fetchImpl: fakeFetch({ 'https://api.supabase.com/': reply(200, []) }, seen) });
  assert.equal(seen.length, 1);
  assert.equal(result.keys.find((k) => k.name === 'GOOGLE_CLIENT_ID').ok, true);
});

test('live: a key with the wrong format is never sent (a Supabase token on the OpenAI line)', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\nOPENAI_API_KEY=${V.sb}\nSTRIPE_SECRET_KEY=${V.oa}\n`);
  const seen = [];
  const result = await checkSecrets({ live: true, fetchImpl: fakeFetch({ 'https://api.supabase.com/': reply(200, []) }, seen) });
  assert.equal(seen.length, 1); // only the real Supabase token went out
  assert.ok(seen.every((s) => s.url.startsWith('https://api.supabase.com/')));
  const by = Object.fromEntries(result.keys.map((k) => [k.name, k]));
  assert.equal(by.OPENAI_API_KEY.looksValid, false);
  assert.equal(by.OPENAI_API_KEY.ok, false);
  assert.equal(by.OPENAI_API_KEY.live.skipped, true);
  assert.equal(by.OPENAI_API_KEY.live.reason, 'format looks wrong for OPENAI_API_KEY, not sent to OpenAI');
  assert.equal(by.STRIPE_SECRET_KEY.live.reason, 'format looks wrong for STRIPE_SECRET_KEY, not sent to Stripe');
  assert.equal(result.ok, true); // optional keys with a bad format are a warning, as offline
  assert.ok(noLeak(JSON.stringify({ ...result, keys: result.keys.map((k) => ({ ...k, hint: undefined })) })));
  const p = JSON.parse(await readFile(PROFILE, 'utf8'));
  assert.notEqual(p.accounts.openai?.ok, true); // OpenAI was never asked, so it is not marked as working
});

test('live: a required key with the wrong format fails and is not sent', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.oa}\n`);
  const seen = [];
  const result = await checkSecrets({ live: true, fetchImpl: fakeFetch({ 'https://': reply(200, []) }, seen) });
  assert.equal(seen.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.keys[0].live.skipped, true);
  await assert.rejects(stat(PROFILE));
});

test('check --live (command line): says the format looks wrong and sends nothing', async () => {
  await reset();
  await writeFile(SECRETS, `SUPABASE_ACCESS_TOKEN=${V.sb}\nOPENAI_API_KEY=${V.sb}\n`);
  const script = path.join(dir, 'secrets-check.mjs');
  // A child process whose fetch only records the call: no network, whatever the code does.
  const code = `
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(String(url)); return new Response('[]', { status: 200 }); };
    process.argv = [process.argv[0], ${JSON.stringify(script)}, '--live'];
    process.on('exit', () => console.error('FETCHED ' + JSON.stringify(urls)));
    await import(${JSON.stringify(pathToFileURL(script).href)});
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, SHIPYARD_HOME: HOME, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  assert.match(r.stdout, /Format looks wrong for OPENAI_API_KEY, not sent to OpenAI/);
  const fetched = JSON.parse(/FETCHED (.*)/.exec(r.stderr)[1]);
  assert.deepEqual(fetched, ['https://api.supabase.com/v1/organizations']);
  assert.ok(noLeak(r.stdout + r.stderr));
});
