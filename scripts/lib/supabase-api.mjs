// Thin client for the Supabase Management API (https://api.supabase.com/v1).
//
// Every function takes an auth object first: { token, fetch?, baseUrl?, sleep? }.
// `fetch`/`sleep` can be swapped in tests. Errors are ApiError with a plain-English,
// secret-free message. Response bodies are never copied into errors for the
// api-keys endpoint, and anything that looks like a key is masked everywhere else.
//
// Checked against the live OpenAPI spec (api.supabase.com/api/v1-json, Oct 2026).
// Differences from the original plan:
//  - POST /projects now REQUIRES `organization_slug`; `organization_id` is deprecated.
//    createProject accepts either name and always sends `organization_slug`
//    (an organization's old `id` equals its slug, so the value is the same).
//  - `region` is deprecated in favour of `region_selection: { type: 'specific', code }`.
//  - GET /projects/{ref}/api-keys?reveal=true returns items with type
//    'publishable' | 'secret' | 'legacy' (legacy ones are named `anon` / `service_role`).
//  - POST /projects/{ref}/database/query also accepts `parameters` and `read_only`.
//  - Project status values: ACTIVE_HEALTHY, COMING_UP, INACTIVE (paused), INIT_FAILED, ...
import { randomBytes } from 'node:crypto';

export const API_BASE = 'https://api.supabase.com/v1';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const REDACT = [
  /sbp_[A-Za-z0-9_]{10,}/g,
  /sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /Bearer\s+\S+/gi,
];

/** Mask anything that looks like a key. */
export function redact(text) {
  return REDACT.reduce((t, re) => t.replace(re, '[hidden]'), String(text));
}

const STATUS_HELP = {
  401: 'Supabase did not accept your access token. Make a new one at supabase.com/dashboard/account/tokens and paste it into your Shipyard keys file.',
  403: 'Your Supabase token is not allowed to do that. Check that it belongs to the right account and organization.',
  404: 'Supabase could not find that project or organization.',
  429: 'Supabase says we are going too fast. Wait a minute and run it again.',
};

function safeMessage(status, bodyText, path) {
  const base = STATUS_HELP[status] ?? (status >= 500
    ? 'Supabase is having trouble right now. Try again in a few minutes.'
    : 'Supabase refused the request.');
  if (path.includes('/api-keys')) return `${base} (HTTP ${status})`;
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed.message === 'string') detail = parsed.message;
  } catch {
    // body was not JSON
  }
  detail = redact(detail).replace(/\s+/g, ' ').trim().slice(0, 200);
  return detail ? `${base} (HTTP ${status}: ${detail})` : `${base} (HTTP ${status})`;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(auth, method, path, body) {
  if (!auth || typeof auth.token !== 'string' || auth.token === '') {
    throw new ApiError(0, 'No Supabase access token. Run "/shipyard:setup" and finish the "supabase" step.');
  }
  const doFetch = auth.fetch ?? fetch;
  const sleep = auth.sleep ?? defaultSleep;
  const url = `${auth.baseUrl ?? API_BASE}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  // Retry rate limits (any method) and server hiccups (reads only), up to 3 times.
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch {
      if (method === 'GET' && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new ApiError(0, 'Could not reach Supabase. Check your internet connection and try again.');
    }
    const text = await res.text();
    if (res.ok) {
      if (text === '') return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new ApiError(res.status, 'Supabase sent back something unexpected.');
      }
    }
    const retryable = res.status === 429 || (method === 'GET' && res.status >= 500);
    if (retryable && attempt < 3) {
      const wait = Number(res.headers?.get?.('retry-after'));
      await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000 * 2 ** attempt, 15_000));
      continue;
    }
    throw new ApiError(res.status, safeMessage(res.status, text, path));
  }
}

const seg = (ref) => encodeURIComponent(ref);

export const listOrganizations = (auth) => request(auth, 'GET', '/organizations');
export const listProjects = (auth) => request(auth, 'GET', '/projects');
export const getProject = (auth, ref) => request(auth, 'GET', `/projects/${seg(ref)}`);

/** The id to store for an organization: its slug (older responses only have `id`). */
export const orgSlug = (org) => org?.slug ?? org?.id ?? '';

/** 32-character letters+digits password (safe to use anywhere). */
export function generateDbPassword() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < 32) {
    for (const byte of randomBytes(48)) {
      if (byte < 248 && out.length < 32) out += alphabet[byte % alphabet.length]; // 248 = 62 * 4: no bias
    }
  }
  return out;
}

/**
 * Create a project. Returns the parsed project. The generated database password is
 * attached as a NON-enumerable `db_pass` property so it can't end up in JSON output
 * or logs by accident. Our flows never need it again; callers should drop it.
 */
export async function createProject(auth, { name, organization_slug, organization_id, region, db_pass }) {
  const slug = organization_slug ?? organization_id;
  if (!name || !slug) throw new ApiError(0, 'createProject needs a project name and an organization.');
  const password = db_pass ?? generateDbPassword();
  const body = {
    name,
    organization_slug: slug,
    db_pass: password,
    ...(region ? { region_selection: { type: 'specific', code: region } } : {}),
  };
  const project = await request(auth, 'POST', '/projects', body);
  Object.defineProperty(project, 'db_pass', { value: password, enumerable: false });
  return project;
}

const BAD_STATES = new Set(['INIT_FAILED', 'REMOVED', 'RESTORE_FAILED', 'PAUSE_FAILED']);

/** Poll until the project is ACTIVE_HEALTHY. Returns the project. */
export async function waitHealthy(auth, ref, { timeoutMs = 5 * 60_000, intervalMs = 5000 } = {}) {
  const sleep = auth.sleep ?? defaultSleep;
  const started = Date.now();
  for (;;) {
    let project = null;
    try {
      project = await getProject(auth, ref);
    } catch (err) {
      // A brand-new project can answer 404 for a moment. Anything else is real.
      if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 0)) throw err;
    }
    if (project?.status === 'ACTIVE_HEALTHY') return project;
    if (project && BAD_STATES.has(project.status)) {
      throw new ApiError(0, `Supabase could not start the project (status ${project.status}). Delete it in the dashboard and try again.`);
    }
    if (Date.now() - started + intervalMs > timeoutMs) {
      throw new ApiError(0, `The Supabase project is still starting after ${Math.round(timeoutMs / 1000)} seconds. Wait a bit and run the step again.`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Project API keys -> { publicKey, serverKey, kind }.
 * kind 'publishable' = publishable + secret keys; 'legacy' = anon + service_role JWT keys.
 * The result holds real secrets: use it, never print it.
 */
export async function getApiKeys(auth, ref) {
  const keys = await request(auth, 'GET', `/projects/${seg(ref)}/api-keys?reveal=true`);
  const list = Array.isArray(keys) ? keys : [];
  const pick = (type) => {
    const withKey = list.filter((k) => k.type === type && typeof k.api_key === 'string' && k.api_key);
    return withKey.find((k) => k.name === 'default') ?? withKey[0];
  };
  const publishable = pick('publishable');
  const secret = pick('secret');
  if (publishable && secret) return { publicKey: publishable.api_key, serverKey: secret.api_key, kind: 'publishable' };
  const anon = list.find((k) => k.name === 'anon' && k.api_key);
  const service = list.find((k) => k.name === 'service_role' && k.api_key);
  if (anon && service) return { publicKey: anon.api_key, serverKey: service.api_key, kind: 'legacy' };
  throw new ApiError(0, 'Supabase did not return the project keys yet. Wait a minute and try again.');
}

/** Run SQL as the database owner. Resolves to the result rows (an array). */
export const runSql = (auth, ref, query) =>
  request(auth, 'POST', `/projects/${seg(ref)}/database/query`, { query });

/** Auth settings. The response can include provider secrets: don't print it whole. */
export const getAuthConfig = (auth, ref) => request(auth, 'GET', `/projects/${seg(ref)}/config/auth`);
export const patchAuthConfig = (auth, ref, patch) =>
  request(auth, 'PATCH', `/projects/${seg(ref)}/config/auth`, patch);

/** Merge redirect URLs into the comma-separated allow list: adds, never removes, no duplicates. */
export function mergeUriAllowList(current, additions) {
  const seen = new Set();
  const out = [];
  for (const item of [...String(current ?? '').split(','), ...additions]) {
    const url = String(item).trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out.join(',');
}
