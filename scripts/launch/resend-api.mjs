// Small client for the Resend API (https://api.resend.com), checked against Resend's docs on 2026-10-16:
//   POST /domains {name, region?}   -> { id, name, status, records: [{record,name,type,ttl,status,value,priority?}], region, ... }
//   GET  /domains?limit&after       -> { object:"list", has_more, data:[{id,name,status,region,...}] }  (limit 1..100)
//   GET  /domains/{id}              -> the domain with its records
//   POST /domains/{id}/verify       -> { object:"domain", id }
//   POST /api-keys {name, permission:"sending_access"|"full_access", domain_id?} -> { id, token }  (the token is only in this response)
//   GET  /api-keys                  -> { data:[{id,name,created_at}] }     DELETE /api-keys/{id}
// Domain status values seen in the docs: not_started. Resend's dashboard also documents pending, verified, failed and
// temporary_failure, which this client treats as: verified = ready, failed = give up, anything else = keep waiting.
import { scrub } from './common.mjs';

export const RESEND_BASE = 'https://api.resend.com';

export class ResendError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError'; // runCli prints ApiError messages as they are
    this.status = status;
  }
}

const HELP = {
  401: 'Resend did not accept your key. Make a new one at resend.com > API Keys and paste it into your Shipyard keys file.',
  403: 'Your Resend key is not allowed to manage domains. Make a key with "Full access" at resend.com > API Keys.',
  404: 'Resend could not find that domain.',
  422: 'Resend did not accept that domain name.',
  429: 'Resend says we are going too fast. Wait a minute and run it again.',
};

/** createResend({ key, fetch, sleep }) -> { listDomains, findDomain, createDomain, getDomain, verifyDomain, listApiKeys, createSendingKey, deleteApiKey } */
export function createResend({ key, fetch: doFetch = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = RESEND_BASE }) {
  if (!key) throw new ResendError(0, 'No Resend key. Run "/shipyard:setup" and finish the "email" step.');

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'shipyard-launch', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if (method === 'GET' && attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new ResendError(0, 'Could not reach Resend. Check your internet connection and try again.');
      }
      const text = await res.text();
      if (res.ok) {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          throw new ResendError(res.status, 'Resend sent back something unexpected.');
        }
      }
      if ((res.status === 429 || (method === 'GET' && res.status >= 500)) && attempt < 3) {
        const wait = Number(res.headers?.get?.('retry-after'));
        await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000 * 2 ** attempt, 15_000));
        continue;
      }
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = typeof parsed?.message === 'string' ? parsed.message : '';
      } catch {
        // not JSON
      }
      detail = scrub(detail, [key]).replace(/\s+/g, ' ').trim().slice(0, 200);
      const base_ = HELP[res.status] ?? (res.status >= 500 ? 'Resend is having trouble right now. Try again in a few minutes.' : 'Resend refused the request.');
      throw new ResendError(res.status, detail ? `${base_} (HTTP ${res.status}: ${detail})` : `${base_} (HTTP ${res.status})`);
    }
  }

  const api = {
    /** All domains, following pages of 100. */
    async listDomains() {
      const out = [];
      let after = '';
      for (let page = 0; page < 20; page++) {
        const body = await request('GET', `/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        const data = Array.isArray(body?.data) ? body.data : [];
        out.push(...data);
        if (!body?.has_more || data.length === 0) break;
        after = data.at(-1).id;
      }
      return out;
    },
    async findDomain(name) {
      const want = String(name).toLowerCase();
      return (await api.listDomains()).find((d) => String(d.name).toLowerCase() === want) ?? null;
    },
    createDomain: ({ name, region }) => request('POST', '/domains', { name, ...(region ? { region } : {}) }),
    getDomain: (id) => request('GET', `/domains/${encodeURIComponent(id)}`),
    verifyDomain: (id) => request('POST', `/domains/${encodeURIComponent(id)}/verify`),
    async listApiKeys() {
      const body = await request('GET', '/api-keys');
      return Array.isArray(body?.data) ? body.data : [];
    },
    /** A key that can only send email from one domain. The secret value (`token`) is in this answer and nowhere else. */
    async createSendingKey({ name, domainId }) {
      const body = await request('POST', '/api-keys', { name, permission: 'sending_access', ...(domainId ? { domain_id: domainId } : {}) });
      if (!body || typeof body.token !== 'string' || !body.token) throw new ResendError(0, 'Resend did not give back the new key.');
      return { id: String(body.id ?? ''), token: body.token };
    },
    deleteApiKey: (id) => request('DELETE', `/api-keys/${encodeURIComponent(id)}`),
  };
  return api;
}
