import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(os.tmpdir(), 'shipyard-secrets-'));
process.env.SHIPYARD_HOME = home;
const { SECRETS_PATH } = await import('../scripts/lib/paths.mjs');
const S = await import('../scripts/lib/secrets.mjs');

// Fake values built at test time (never real keys).
const FAKE = {
  SUPABASE_ACCESS_TOKEN: `sbp_${'a1'.repeat(20)}`,
  OPENROUTER_API_KEY: `sk-or-v1-${'b2'.repeat(16)}`,
  OPENAI_API_KEY: `sk-proj-${'c3'.repeat(16)}`,
  GROQ_API_KEY: `gsk_${'j0'.repeat(20)}`,
  DEEPGRAM_API_KEY: 'k1'.repeat(20),
  RESEND_API_KEY: `re_${'d4'.repeat(12)}`,
  STRIPE_SECRET_KEY: `sk_test_${'e5'.repeat(12)}`,
  STRIPE_PUBLISHABLE_KEY: `pk_test_${'f6'.repeat(12)}`,
  STRIPE_LIVE_SECRET_KEY: `sk_live_${'h8'.repeat(12)}`,
  STRIPE_LIVE_PUBLISHABLE_KEY: `pk_live_${'i9'.repeat(12)}`,
  GOOGLE_CLIENT_ID: '123456-abc.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: `GOCSPX-${'g7'.repeat(12)}`,
};

after(() => rm(home, { recursive: true, force: true }));
beforeEach(() => rm(SECRETS_PATH, { force: true }));

test('parseEnv handles comments, blanks, export, quotes, CRLF, = inside values', () => {
  const m = S.parseEnv('# c\r\n\r\nA=1\r\nexport B="two words"\nC=\'x\'\nD=a=b=c\n  E = spaced \n#F=hidden\nnot a line\n');
  assert.deepEqual([...m.entries()], [['A', '1'], ['B', 'two words'], ['C', 'x'], ['D', 'a=b=c'], ['E', 'spaced']]);
});

test('ensureSecretsFile creates the file with all known keys in order, each with a comment', async () => {
  const r = await S.ensureSecretsFile();
  assert.equal(r.created, true);
  assert.equal(r.added.length, Object.keys(FAKE).length);
  const text = await readFile(SECRETS_PATH, 'utf8');
  const keys = [...text.matchAll(/^([A-Z_]+)=$/gm)].map((x) => x[1]);
  assert.deepEqual(keys, Object.keys(FAKE));
  for (const k of keys) {
    const lines = text.split('\n');
    const i = lines.indexOf(`${k}=`);
    assert.match(lines[i - 1], /^# .{10,}/, `${k} has a comment above it`);
  }
  if (process.platform !== 'win32') assert.equal((await stat(SECRETS_PATH)).mode & 0o777, 0o600);
});

test('ensureSecretsFile appends missing keys without touching existing values', async () => {
  const original = `# mine\nSUPABASE_ACCESS_TOKEN=${FAKE.SUPABASE_ACCESS_TOKEN}\nCUSTOM=keep me`;
  await writeFile(SECRETS_PATH, original, { mode: 0o644 });
  const r = await S.ensureSecretsFile();
  assert.equal(r.created, false);
  assert.ok(!r.added.includes('SUPABASE_ACCESS_TOKEN'));
  assert.equal(r.added.length, Object.keys(FAKE).length - 1);
  const text = await readFile(SECRETS_PATH, 'utf8');
  assert.ok(text.startsWith(original));
  assert.match(text, /^CUSTOM=keep me$/m);
  assert.equal((text.match(/^SUPABASE_ACCESS_TOKEN=/gm) ?? []).length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(SECRETS_PATH)).mode & 0o777, 0o600);
  // second run changes nothing
  const before = await readFile(SECRETS_PATH, 'utf8');
  const again = await S.ensureSecretsFile();
  assert.deepEqual(again.added, []);
  assert.equal(await readFile(SECRETS_PATH, 'utf8'), before);
});

test('readSecrets returns only keys with values', async () => {
  await S.ensureSecretsFile();
  assert.equal((await S.readSecrets()).size, 0);
  await writeFile(SECRETS_PATH, `OPENAI_API_KEY=${FAKE.OPENAI_API_KEY}\nRESEND_API_KEY=\n`);
  const m = await S.readSecrets();
  assert.equal(m.get('OPENAI_API_KEY'), FAKE.OPENAI_API_KEY);
  assert.equal(m.has('RESEND_API_KEY'), false);
});

test('listSecrets: never contains values, flags presence and shape', async () => {
  const lines = Object.entries(FAKE).map(([k, v]) => `${k}=${v}`);
  lines[1] = 'OPENROUTER_API_KEY=not-a-real-key'; // present but wrong shape
  lines[Object.keys(FAKE).indexOf('RESEND_API_KEY')] = 'RESEND_API_KEY='; // empty
  await writeFile(SECRETS_PATH, lines.join('\n'));
  const list = await S.listSecrets();
  assert.deepEqual(list.map((s) => s.name), Object.keys(FAKE));
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.deepEqual([by.SUPABASE_ACCESS_TOKEN.present, by.SUPABASE_ACCESS_TOKEN.looksValid], [true, true]);
  assert.deepEqual([by.OPENROUTER_API_KEY.present, by.OPENROUTER_API_KEY.looksValid], [true, false]);
  assert.deepEqual([by.RESEND_API_KEY.present, by.RESEND_API_KEY.looksValid], [false, false]);
  assert.equal(by.STRIPE_SECRET_KEY.looksValid, true);
  assert.equal(by.GROQ_API_KEY.looksValid, true);
  assert.equal(by.DEEPGRAM_API_KEY.looksValid, true);
  assert.equal(by.STRIPE_PUBLISHABLE_KEY.looksValid, true);
  assert.equal(by.SUPABASE_ACCESS_TOKEN.required, true);
  const dump = JSON.stringify(list);
  for (const v of Object.values(FAKE)) assert.ok(!dump.includes(v), 'a value leaked into listSecrets');
});

test('looksValid heuristics', async () => {
  const check = async (name, value) => {
    await writeFile(SECRETS_PATH, `${name}=${value}\n`);
    return (await S.listSecrets()).find((s) => s.name === name).looksValid;
  };
  assert.equal(await check('SUPABASE_ACCESS_TOKEN', 'sbp_short'), false);
  assert.equal(await check('SUPABASE_ACCESS_TOKEN', FAKE.OPENAI_API_KEY), false);
  assert.equal(await check('OPENAI_API_KEY', FAKE.OPENROUTER_API_KEY), false); // OpenRouter key in the OpenAI slot
  assert.equal(await check('OPENAI_API_KEY', `sk-${'z'.repeat(30)}`), true);
  // Test and live keys can not be mixed up: a live key in the test slot is refused, and the other way round.
  assert.equal(await check('STRIPE_SECRET_KEY', `sk_live_${'q'.repeat(24)}`), false);
  assert.equal(await check('STRIPE_SECRET_KEY', `rk_live_${'q'.repeat(24)}`), false);
  assert.equal(await check('STRIPE_SECRET_KEY', `rk_test_${'q'.repeat(24)}`), true);
  assert.equal(await check('STRIPE_SECRET_KEY', FAKE.STRIPE_PUBLISHABLE_KEY), false);
  assert.equal(await check('STRIPE_PUBLISHABLE_KEY', `pk_live_${'q'.repeat(24)}`), false);
  assert.equal(await check('STRIPE_LIVE_SECRET_KEY', `sk_live_${'q'.repeat(24)}`), true);
  assert.equal(await check('STRIPE_LIVE_SECRET_KEY', `rk_live_${'q'.repeat(24)}`), true);
  assert.equal(await check('STRIPE_LIVE_SECRET_KEY', FAKE.STRIPE_SECRET_KEY), false);
  assert.equal(await check('STRIPE_LIVE_PUBLISHABLE_KEY', FAKE.STRIPE_LIVE_PUBLISHABLE_KEY), true);
  assert.equal(await check('STRIPE_LIVE_PUBLISHABLE_KEY', FAKE.STRIPE_PUBLISHABLE_KEY), false);
  assert.equal(await check('RESEND_API_KEY', 're_'), false);
  assert.equal(await check('GOOGLE_CLIENT_ID', 'nope'), false);
  assert.equal(await check('GOOGLE_CLIENT_SECRET', FAKE.GOOGLE_CLIENT_SECRET), true);
});

test('real-money keys and the full-access Resend key are never in the per-app list', () => {
  for (const n of ['STRIPE_LIVE_SECRET_KEY', 'STRIPE_LIVE_PUBLISHABLE_KEY', 'RESEND_API_KEY', 'SUPABASE_ACCESS_TOKEN']) assert.equal(S.PER_APP_SECRETS.has(n), false, n);
  assert.equal(S.PER_APP_SECRETS.has('STRIPE_SECRET_KEY'), true);
  assert.deepEqual([...S.LIVE_ONLY_SECRETS].sort(), ['STRIPE_LIVE_PUBLISHABLE_KEY', 'STRIPE_LIVE_SECRET_KEY']);
});

test('getSecret returns the value; a missing one throws a friendly error naming the step', async () => {
  await writeFile(SECRETS_PATH, `SUPABASE_ACCESS_TOKEN=${FAKE.SUPABASE_ACCESS_TOKEN}\nRESEND_API_KEY=\n`);
  assert.equal(await S.getSecret('SUPABASE_ACCESS_TOKEN'), FAKE.SUPABASE_ACCESS_TOKEN);
  await assert.rejects(() => S.getSecret('RESEND_API_KEY'), (err) => {
    assert.ok(err instanceof S.MissingSecretError);
    assert.match(err.message, /RESEND_API_KEY/);
    assert.match(err.message, /"email" step/);
    assert.equal(err.step, 'email');
    assert.ok(!err.message.includes(FAKE.SUPABASE_ACCESS_TOKEN));
    return true;
  });
  await rm(SECRETS_PATH);
  await assert.rejects(() => S.getSecret('SUPABASE_ACCESS_TOKEN'), /"supabase" step/);
});
