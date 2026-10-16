// A small Stripe REST client (https://api.stripe.com/v1), no SDK. Form-encoded bodies, bearer key, list pagination,
// retries on 429 and (for reads) 5xx, and error messages that never contain the key.
// Endpoints used were checked against Stripe's API reference on 2026-10-16:
//   GET/POST /prices (lookup_keys[] up to 10, transfer_lookup_key), GET/POST /products,
//   GET/POST/DELETE /webhook_endpoints (the signing `secret` is only in the create response),
//   GET/POST /billing_portal/configurations.
import { randomUUID } from 'node:crypto';
import { scrub } from './common.mjs';

export const STRIPE_BASE = 'https://api.stripe.com/v1';

export class StripeApiError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Nested objects and arrays the way Stripe wants them: a[b]=1, list[0]=x, list[1][k]=y. null/undefined are left out. */
export function encodeForm(params) {
  const pairs = [];
  const add = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${prefix}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) add(prefix ? `${prefix}[${k}]` : k, v);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  add('', params);
  return pairs.join('&');
}

const HELP = {
  401: 'Stripe did not accept the key. Copy it again from the Stripe dashboard (Developers > API keys) into your Shipyard keys file.',
  403: 'This Stripe key is not allowed to do that. Use a key with full access, or a restricted key that can write products, prices, webhooks and the customer portal.',
  429: 'Stripe says we are going too fast. Wait a minute and run it again.',
};

/** createStripe({ key, fetch, sleep }) -> { get, post, del, listAll, mode } */
export function createStripe({ key, fetch: doFetch = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = STRIPE_BASE }) {
  if (!key) throw new StripeApiError(0, 'No Stripe key.');
  const mode = /^(?:sk|rk)_live_/.test(key) ? 'live' : /^(?:sk|rk)_test_/.test(key) ? 'test' : 'unknown';

  async function request(method, path, params) {
    const idempotencyKey = method === 'POST' ? randomUUID() : undefined;
    const query = method === 'GET' && params ? `?${encodeForm(params)}` : '';
    const body = method === 'POST' && params ? encodeForm(params) : undefined;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await doFetch(`${base}${path}${query}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'User-Agent': 'shipyard-launch',
            ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if ((method === 'GET' || idempotencyKey) && attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new StripeApiError(0, 'Could not reach Stripe. Check your internet connection and try again.');
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.ok) {
        if (json === null) throw new StripeApiError(res.status, 'Stripe sent back something unexpected.');
        return json;
      }
      if ((res.status === 429 || res.status >= 500) && (res.status === 429 || method === 'GET' || idempotencyKey) && attempt < 3) {
        await sleep(Math.min(1000 * 2 ** attempt, 10_000));
        continue;
      }
      const detail = scrub(String(json?.error?.message ?? ''), [key]).replace(/\s+/g, ' ').trim().slice(0, 240);
      const lead = HELP[res.status] ?? (res.status >= 500 ? 'Stripe is having trouble right now. Try again in a few minutes.' : 'Stripe refused the request.');
      throw new StripeApiError(res.status, detail ? `${lead} (HTTP ${res.status}: ${detail})` : `${lead} (HTTP ${res.status})`, String(json?.error?.code ?? ''));
    }
  }

  const api = {
    mode,
    get: (path, params) => request('GET', path, params),
    post: (path, params) => request('POST', path, params ?? {}),
    del: (path) => request('DELETE', path),
    /** Every object of a list endpoint, following `has_more` (pages of 100, at most 50 pages). */
    async listAll(path, params = {}) {
      const out = [];
      let after;
      for (let page = 0; page < 50; page++) {
        const body = await request('GET', path, { limit: 100, ...params, ...(after ? { starting_after: after } : {}) });
        const data = Array.isArray(body?.data) ? body.data : [];
        out.push(...data);
        if (!body?.has_more || data.length === 0) break;
        after = data.at(-1).id;
      }
      return out;
    },
  };
  return api;
}
