import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveCheck } from '../scripts/secrets-check.mjs';

const seen = [];
const fakeFetch = (status) => async (url, init) => {
  seen.push({ url, init });
  return { status, ok: status < 300, json: async () => ({}) };
};

test('new providers use their own auth header and a cheap endpoint', async () => {
  seen.length = 0;
  const cases = [
    ['ELEVENLABS_API_KEY', 'https://api.elevenlabs.io/v1/user', 'xi-api-key'],
    ['ROUTEWAY_API_KEY', 'https://api.routeway.ai/v1/models', 'Authorization'],
    ['BRAVE_API_KEY', 'https://api.search.brave.com/res/v1/web/search?q=test&count=1', 'X-Subscription-Token'],
    ['SERPER_API_KEY', 'https://google.serper.dev/search', 'X-API-KEY'],
  ];
  for (const [name, url, header] of cases) {
    const r = await liveCheck(name, 'k'.repeat(32), fakeFetch(200));
    assert.equal(r.ok, true, name);
    const last = seen.at(-1);
    assert.equal(last.url, url);
    assert.ok(String(last.init.headers[header]).includes('k'.repeat(32)), `${name} header`);
  }
  assert.equal(seen.at(-1).init.method, 'POST');
  const s = await liveCheck('SERPAPI_API_KEY', 'a'.repeat(64), fakeFetch(401));
  assert.equal(s.ok, false);
  assert.match(seen.at(-1).url, /^https:\/\/serpapi\.com\/account\.json\?api_key=/);
});

test('Upstash token is only sent to a real Upstash URL', async () => {
  seen.length = 0;
  const bad = await liveCheck('UPSTASH_REDIS_REST_TOKEN', 'AX'.repeat(15), fakeFetch(200), new Map([['UPSTASH_REDIS_REST_URL', 'https://evil.example.com']]));
  assert.equal(bad.inconclusive, true);
  assert.equal(seen.length, 0);
  const good = await liveCheck('UPSTASH_REDIS_REST_TOKEN', 'AX'.repeat(15), fakeFetch(200), new Map([['UPSTASH_REDIS_REST_URL', 'https://db-1.upstash.io/']]));
  assert.equal(good.ok, true);
  assert.equal(seen[0].url, 'https://db-1.upstash.io/ping');
});

test('NVIDIA is format-only (no request)', async () => {
  assert.equal(await liveCheck('NVIDIA_API_KEY', `nvapi-${'x'.repeat(20)}`, fakeFetch(200)), null);
});
