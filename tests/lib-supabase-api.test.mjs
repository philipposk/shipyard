import { test } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../scripts/lib/supabase-api.mjs');

const TOKEN = `sbp_${'9f'.repeat(20)}`;

/** Fake fetch: replies come from a queue; every call is recorded. */
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = replies.shift() ?? { status: 200, body: {} };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => r.headers?.[h.toLowerCase()] ?? null },
      text: async () => (r.status === 204 ? '' : text),
    };
  };
  return { fn, calls };
}
const auth = (f, extra = {}) => ({ token: TOKEN, fetch: f.fn, sleep: async () => {}, ...extra });

test('GET requests carry the bearer token and the right URL', async () => {
  const f = fakeFetch([{ status: 200, body: [{ id: 'o1', slug: 'o1', name: 'Me' }] }]);
  const orgs = await S.listOrganizations(auth(f));
  assert.equal(orgs[0].name, 'Me');
  assert.equal(f.calls[0].url, 'https://api.supabase.com/v1/organizations');
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('listProjects hits /projects', async () => {
  const f = fakeFetch([{ status: 200, body: [{ ref: 'r', status: 'ACTIVE_HEALTHY' }] }]);
  const list = await S.listProjects(auth(f));
  assert.equal(list[0].status, 'ACTIVE_HEALTHY');
  assert.ok(f.calls[0].url.endsWith('/projects'));
});

test('createProject sends slug, region_selection and a generated password; db_pass is hidden from JSON', async () => {
  const f = fakeFetch([{ status: 201, body: { ref: 'abcdefghijklmnopqrst', status: 'COMING_UP' } }]);
  const p = await S.createProject(auth(f), { name: 'todo', organization_id: 'my-org', region: 'eu-central-1' });
  const body = JSON.parse(f.calls[0].body);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(body.name, 'todo');
  assert.equal(body.organization_slug, 'my-org');
  assert.deepEqual(body.region_selection, { type: 'specific', code: 'eu-central-1' });
  assert.match(body.db_pass, /^[A-Za-z0-9]{32}$/);
  assert.equal(p.db_pass, body.db_pass);
  assert.ok(!JSON.stringify(p).includes(body.db_pass));
});

test('generateDbPassword is random and well-formed', () => {
  const a = S.generateDbPassword();
  const b = S.generateDbPassword();
  assert.match(a, /^[A-Za-z0-9]{32}$/);
  assert.notEqual(a, b);
});

test('createProject needs name and organization', async () => {
  await assert.rejects(() => S.createProject(auth(fakeFetch([])), { name: 'x' }), S.ApiError);
});

test('waitHealthy polls until ACTIVE_HEALTHY, tolerating an early 404', async () => {
  const f = fakeFetch([
    { status: 404, body: { message: 'not found' } },
    { status: 200, body: { status: 'COMING_UP' } },
    { status: 200, body: { status: 'ACTIVE_HEALTHY', ref: 'r' } },
  ]);
  const p = await S.waitHealthy(auth(f), 'abcdefghijklmnopqrst', { intervalMs: 1, timeoutMs: 5000 });
  assert.equal(p.status, 'ACTIVE_HEALTHY');
  assert.equal(f.calls.length, 3);
});

test('waitHealthy fails fast on INIT_FAILED and times out otherwise', async () => {
  await assert.rejects(
    () => S.waitHealthy(auth(fakeFetch([{ status: 200, body: { status: 'INIT_FAILED' } }])), 'r', { intervalMs: 1 }),
    /INIT_FAILED/,
  );
  const stuck = fakeFetch(Array.from({ length: 50 }, () => ({ status: 200, body: { status: 'COMING_UP' } })));
  await assert.rejects(() => S.waitHealthy(auth(stuck), 'r', { intervalMs: 10, timeoutMs: 30 }), /still starting/);
});

test('getApiKeys prefers publishable + secret', async () => {
  const f = fakeFetch([{ status: 200, body: [
    { type: 'legacy', name: 'anon', api_key: 'LEGACY_ANON' },
    { type: 'legacy', name: 'service_role', api_key: 'LEGACY_SERVICE' },
    { type: 'publishable', name: 'default', api_key: 'PUB_KEY' },
    { type: 'secret', name: 'default', api_key: 'SECRET_KEY' },
  ] }]);
  const k = await S.getApiKeys(auth(f), 'abcdefghijklmnopqrst');
  assert.deepEqual(k, { publicKey: 'PUB_KEY', serverKey: 'SECRET_KEY', kind: 'publishable' });
  assert.ok(f.calls[0].url.endsWith('/projects/abcdefghijklmnopqrst/api-keys?reveal=true'));
});

test('getApiKeys falls back to legacy anon + service_role', async () => {
  const f = fakeFetch([{ status: 200, body: [
    { type: 'legacy', name: 'anon', api_key: 'LEGACY_ANON' },
    { type: 'legacy', name: 'service_role', api_key: 'LEGACY_SERVICE' },
  ] }]);
  assert.deepEqual(await S.getApiKeys(auth(f), 'r'), { publicKey: 'LEGACY_ANON', serverKey: 'LEGACY_SERVICE', kind: 'legacy' });
});

test('getApiKeys with no usable keys throws a friendly error', async () => {
  await assert.rejects(() => S.getApiKeys(auth(fakeFetch([{ status: 200, body: [] }])), 'r'), /did not return the project keys/);
});

test('runSql posts { query } and returns rows', async () => {
  const f = fakeFetch([{ status: 201, body: [{ n: 1 }] }]);
  const rows = await S.runSql(auth(f), 'r', 'select 1 as n');
  assert.deepEqual(rows, [{ n: 1 }]);
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].body), { query: 'select 1 as n' });
  assert.ok(f.calls[0].url.endsWith('/projects/r/database/query'));
});

test('auth config get and patch', async () => {
  const f = fakeFetch([{ status: 200, body: { site_url: 'http://localhost:3000', uri_allow_list: '' } }, { status: 200, body: {} }]);
  const cfg = await S.getAuthConfig(auth(f), 'r');
  assert.equal(cfg.site_url, 'http://localhost:3000');
  await S.patchAuthConfig(auth(f), 'r', { site_url: 'https://x.vercel.app' });
  assert.equal(f.calls[1].method, 'PATCH');
  assert.ok(f.calls[1].url.endsWith('/projects/r/config/auth'));
  assert.deepEqual(JSON.parse(f.calls[1].body), { site_url: 'https://x.vercel.app' });
});

test('errors carry status and a plain message, never the token or key-looking text', async () => {
  const leaky = { message: `bad token ${TOKEN} and key sb_secret_${'x'.repeat(30)} Bearer ${TOKEN}` };
  const f = fakeFetch([{ status: 400, body: leaky }]);
  await assert.rejects(() => S.listProjects(auth(f)), (e) => {
    assert.ok(e instanceof S.ApiError);
    assert.equal(e.status, 400);
    assert.ok(!e.message.includes(TOKEN));
    assert.ok(!e.message.includes('sb_secret_'));
    return true;
  });
  const unauth = fakeFetch([{ status: 401, body: { message: 'nope' } }]);
  await assert.rejects(() => S.listProjects(auth(unauth)), (e) => e.status === 401 && /access token/i.test(e.message));
});

test('error bodies from the api-keys endpoint are never copied', async () => {
  const f = fakeFetch([{ status: 400, body: { message: 'secret detail: PUB_KEY_VALUE' } }]);
  await assert.rejects(() => S.getApiKeys(auth(f), 'r'), (e) => !e.message.includes('PUB_KEY_VALUE'));
});

test('429 is retried (honouring retry-after), then succeeds', async () => {
  const f = fakeFetch([{ status: 429, body: {}, headers: { 'retry-after': '1' } }, { status: 200, body: [] }]);
  assert.deepEqual(await S.listProjects(auth(f)), []);
  assert.equal(f.calls.length, 2);
});

test('5xx on GET is retried, but a POST is not', async () => {
  const get = fakeFetch([{ status: 502, body: '' }, { status: 200, body: [] }]);
  assert.deepEqual(await S.listProjects(auth(get)), []);
  const post = fakeFetch([{ status: 502, body: '' }, { status: 200, body: [] }]);
  await assert.rejects(() => S.runSql(auth(post), 'r', 'select 1'), (e) => e.status === 502);
  assert.equal(post.calls.length, 1);
});

test('network failure becomes a friendly ApiError; missing token is rejected before any request', async () => {
  const boom = { token: TOKEN, sleep: async () => {}, fetch: async () => { throw new TypeError('fetch failed'); } };
  await assert.rejects(() => S.runSql(boom, 'r', 'select 1'), /Could not reach Supabase/);
  const f = fakeFetch([]);
  await assert.rejects(() => S.listProjects({ token: '', fetch: f.fn }), /access token/);
  assert.equal(f.calls.length, 0);
});

test('mergeUriAllowList adds, keeps existing, drops duplicates and blanks', () => {
  const merged = S.mergeUriAllowList('https://a.com/**, http://localhost:3000/**', ['http://localhost:3000/**', 'https://b.com/**', '']);
  assert.equal(merged, 'https://a.com/**,http://localhost:3000/**,https://b.com/**');
  assert.equal(S.mergeUriAllowList(null, ['x']), 'x');
});

test('orgSlug prefers slug, falls back to id', () => {
  assert.equal(S.orgSlug({ id: 'old', slug: 'new' }), 'new');
  assert.equal(S.orgSlug({ id: 'old' }), 'old');
});
