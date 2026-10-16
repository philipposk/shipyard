// Talks to the app's own Supabase project for the auth and isolation checks.
// Keys come from the app's .env.local (read by verify.mjs into ctx.secrets). They are only ever sent to
// the project's own address, never printed, and every message is run through the redactor.
import { randomBytes } from 'node:crypto';
import { request, makeRedactor, errorText } from './util.mjs';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isIdentifier = (s) => typeof s === 'string' && IDENT.test(s);

const looksLikeJwt = (key) => /^eyJ/.test(key);

/** Pull the three Supabase values out of the app's env (a Map). Returns { ok, ...values } or { ok:false, reason }. */
export function supabaseFromEnv(env) {
  const get = (k) => (env?.get?.(k) ?? '').trim();
  const rawUrl = get('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, '');
  const anonKey = get('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serverKey = get('SUPABASE_SERVICE_ROLE_KEY');
  const missing = [];
  if (!rawUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!serverKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    return { ok: false, reason: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from .env.local (run provision-supabase first)` };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'NEXT_PUBLIC_SUPABASE_URL in .env.local is not a web address' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'NEXT_PUBLIC_SUPABASE_URL in .env.local is not a web address' };
  }
  return { ok: true, url: rawUrl, anonKey, serverKey };
}

/** A password with letters, digits and the awkward characters ($ and !) that break sloppy shell quoting. */
export function randomPassword() {
  return `Sy-${randomBytes(18).toString('base64url')}$!9a`;
}

export function randomTestEmail() {
  return `shipyard-test-${randomBytes(6).toString('hex')}@example.com`;
}

/**
 * Small client over the Supabase HTTP API.
 * `redact` hides the keys in any message built from a response.
 */
export function createSupabase({ url, anonKey, serverKey, extraSecrets = [] }) {
  const redact = makeRedactor([anonKey, serverKey, ...extraSecrets]);

  // New-style keys (sb_secret_..., sb_publishable_...) go in `apikey` only. Old JWT keys also go in Authorization.
  const keyHeaders = (key, bearer) => {
    const h = { apikey: key, 'content-type': 'application/json' };
    const token = bearer ?? (looksLikeJwt(key) ? key : null);
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  };
  const json = (res) => {
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  };
  const describe = (res) => errorText(res, redact);

  return {
    redact,
    describe,
    json,

    async createUser(email, password) {
      const res = await request(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers: keyHeaders(serverKey),
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const body = json(res);
      if (res.status >= 200 && res.status < 300 && body?.id) return { ok: true, id: body.id };
      return { ok: false, error: describe(res) };
    },

    /** The user's id from the app's own lookup function (migration 0003; only the server key may call it). */
    async userIdByEmail(email) {
      const res = await request(`${url}/rest/v1/rpc/auth_user_id_by_email`, {
        method: 'POST',
        headers: keyHeaders(serverKey),
        body: JSON.stringify({ email }),
      });
      const body = json(res);
      if (res.status >= 200 && res.status < 300) return { ok: true, id: typeof body === 'string' && body ? body : null };
      return { ok: false, error: describe(res) };
    },

    /** A one-time sign-in token for an existing user. Returns { ok, tokenHash }. Treat tokenHash like a password. */
    async generateMagicLink(email) {
      const res = await request(`${url}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: keyHeaders(serverKey),
        body: JSON.stringify({ type: 'magiclink', email }),
      });
      const body = json(res);
      const tokenHash = body?.hashed_token ?? body?.properties?.hashed_token;
      if (res.status >= 200 && res.status < 300 && typeof tokenHash === 'string' && tokenHash) return { ok: true, tokenHash };
      return { ok: false, error: describe(res) };
    },

    async setPassword(id, password) {
      const res = await request(`${url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: keyHeaders(serverKey),
        body: JSON.stringify({ password }),
      });
      return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, error: describe(res) };
    },

    async deleteUser(id) {
      const res = await request(`${url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: keyHeaders(serverKey),
      });
      return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, error: describe(res) };
    },

    async signIn(email, password) {
      const res = await request(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = json(res);
      if (res.status === 200 && body?.access_token) {
        return { ok: true, accessToken: body.access_token, userId: body.user?.id ?? null };
      }
      return { ok: false, error: describe(res) };
    },

    async signOut(accessToken) {
      const res = await request(`${url}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      });
      return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, error: describe(res) };
    },

    /**
     * One call to the database API (PostgREST).
     * as: { token } = a signed-in user, { server: true } = the secret key (skips privacy rules), {} = anonymous.
     * Returns { status, rows (array, or [] when the answer was an error), error }.
     */
    async rest(table, { method = 'GET', query = '', body, as = {}, prefer } = {}) {
      const headers = as.server
        ? keyHeaders(serverKey)
        : { apikey: anonKey, 'content-type': 'application/json', ...(as.token ? { authorization: `Bearer ${as.token}` } : {}) };
      if (prefer) headers.prefer = prefer;
      const res = await request(`${url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed = json(res);
      const good = res.status >= 200 && res.status < 300;
      const rows = good && Array.isArray(parsed) ? parsed : good && parsed && typeof parsed === 'object' ? [parsed] : [];
      return { status: res.status, rows, error: good ? null : describe(res), ok: good };
    },
  };
}
