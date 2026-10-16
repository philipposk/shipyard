// Shared fixtures for the launch tests: an app folder with the payments module, a fake Stripe, fake Vercel, fake profile.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Keys are put together at run time so no key-shaped text sits in the repo.
export const KEYS = {
  test: `sk_${'test'}_${'a1'.repeat(14)}`,
  live: `sk_${'live'}_${'b2'.repeat(14)}`,
  testPk: `pk_${'test'}_${'c3'.repeat(14)}`,
  livePk: `pk_${'live'}_${'d4'.repeat(14)}`,
};
export const SECRET_VALUES = Object.values(KEYS);

export async function tempApp(extraConfig = {}, { withPlans = true } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'shipyard-launch-'));
  const dir = path.join(parent, 'tea-shop');
  await mkdir(path.join(dir, 'src', 'lib', 'billing'), { recursive: true });
  const config = {
    slug: 'tea-shop', name: 'Tea Shop', modules: ['billing'], vercelProject: 'tea-shop',
    siteUrl: 'https://tea-shop.vercel.app', url: 'https://tea-shop.vercel.app', env: ['NEXT_PUBLIC_SITE_URL'], ...extraConfig,
  };
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify(config, null, 2));
  if (withPlans) await writeFile(path.join(dir, 'src', 'lib', 'billing', 'plans.ts'), await readFile(path.join(ROOT, 'modules', 'billing', 'files', 'src', 'lib', 'billing', 'plans.ts'), 'utf8'));
  return { dir, parent, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

export const readConfig = async (dir) => JSON.parse(await readFile(path.join(dir, '.shipyard-app.json'), 'utf8'));

export function fakeProfile(initial = {}) {
  const profile = {
    owner: { country: 'GR' }, accounts: { vercel: { scope: 'team', plan: 'pro' }, stripe: {} }, company: { legalName: 'Tea Ltd', address: '1 Tea St, Athens', contactEmail: 'hi@tea.example', phone: '+30 210 0000000' },
    apps: [], ...initial,
  };
  return {
    profile,
    loadProfile: async () => structuredClone(profile),
    saveProfile: async (p) => { Object.assign(profile, structuredClone(p)); },
    upsertApp: async (app) => {
      const i = profile.apps.findIndex((a) => a.slug === app.slug);
      if (i === -1) profile.apps.push({ ...app }); else profile.apps[i] = { ...profile.apps[i], ...app };
    },
  };
}

/** a[b][0]=x&c=y -> { a: { b: ['x'] }, c: 'y' } */
export function decodeForm(text) {
  const out = {};
  for (const pair of String(text).split('&').filter(Boolean)) {
    const [rawKey, rawValue = ''] = pair.split('=');
    const key = decodeURIComponent(rawKey);
    const value = decodeURIComponent(rawValue);
    const parts = key.replace(/\]/g, '').split('[');
    let node = out;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value;
      else node = node[part] ??= {};
    });
  }
  const fix = (v) => {
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      const asArray = keys.length > 0 && keys.every((k, i) => k === String(i));
      const mapped = Object.fromEntries(keys.map((k) => [k, fix(v[k])]));
      return asArray ? keys.map((k) => mapped[k]) : mapped;
    }
    return v;
  };
  return fix(out);
}

/** A tiny in-memory Stripe. `calls` lists every request (with the key used). */
export function fakeStripe({ pageSize } = {}) {
  const s = { prices: [], products: [], portals: [], hooks: [], calls: [], seq: 0, secretsMade: [], pageSize };
  const id = (p) => `${p}_${++s.seq}`;
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), headers: new Map() });
  // Like Stripe: `limit` (or the forced page size) items per page, `starting_after` continues, `has_more` says if there is more.
  const list = (data, params = {}) => {
    const size = s.pageSize ?? Math.min(Number(params.limit ?? 10), 100);
    const start = params.starting_after ? data.findIndex((x) => x.id === params.starting_after) + 1 : 0;
    const page = data.slice(start, start + size);
    return reply(200, { object: 'list', data: page, has_more: start + size < data.length });
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const route = u.pathname.replace(/^\/v1/, '');
    const params = method === 'GET' ? decodeForm(u.search.slice(1)) : decodeForm(init.body ?? '');
    s.calls.push({ method, route, params, auth: init.headers?.Authorization ?? '' });
    let m;
    if (route === '/prices' && method === 'GET') return list(s.prices.filter((p) => !params.lookup_keys || params.lookup_keys.includes(p.lookup_key)), params);
    if (route === '/prices' && method === 'POST') {
      if (params.transfer_lookup_key === 'true') s.prices.filter((p) => p.lookup_key === params.lookup_key).forEach((p) => { p.lookup_key = null; });
      const price = { id: id('price'), product: params.product, unit_amount: Number(params.unit_amount), currency: params.currency, recurring: { interval: params.recurring.interval, interval_count: 1 }, lookup_key: params.lookup_key, active: true };
      s.prices.push(price);
      return reply(200, price);
    }
    if (route === '/products' && method === 'GET') return list(s.products, params);
    if (route === '/products' && method === 'POST') { const p = { id: id('prod'), name: params.name, active: true, metadata: params.metadata }; s.products.push(p); return reply(200, p); }
    if ((m = /^\/products\/(.+)$/.exec(route))) {
      const p = s.products.find((x) => x.id === m[1]);
      if (!p) return reply(404, { error: { message: 'No such product' } });
      if (method === 'POST') Object.assign(p, params, { active: true });
      return reply(200, p);
    }
    if (route === '/billing_portal/configurations' && method === 'GET') return list(s.portals, params);
    if (route === '/billing_portal/configurations' && method === 'POST') { const c = { id: id('bpc'), active: true, metadata: params.metadata, params }; s.portals.push(c); return reply(200, c); }
    if ((m = /^\/billing_portal\/configurations\/(.+)$/.exec(route))) { const c = s.portals.find((x) => x.id === m[1]); Object.assign(c, { params }); return reply(200, c); }
    if (route === '/webhook_endpoints' && method === 'GET') return list(s.hooks.map(({ secret, ...rest }) => rest), params);
    if (route === '/webhook_endpoints' && method === 'POST') {
      const secret = `whsec_${'z9'.repeat(12)}${s.seq}`;
      s.secretsMade.push(secret);
      const h = { id: id('we'), url: params.url, enabled_events: params.enabled_events, status: 'enabled', metadata: params.metadata ?? {}, secret };
      s.hooks.push(h);
      return reply(200, h);
    }
    if ((m = /^\/webhook_endpoints\/(.+)$/.exec(route))) {
      const i = s.hooks.findIndex((x) => x.id === m[1]);
      if (i === -1) return reply(404, { error: { message: 'No such webhook' } });
      if (method === 'DELETE') { s.hooks.splice(i, 1); return reply(200, { deleted: true }); }
      if (params.enabled_events) s.hooks[i].enabled_events = params.enabled_events;
      if (params.url) s.hooks[i].url = params.url;
      if (params.metadata) s.hooks[i].metadata = params.metadata;
      if (params.disabled === 'false') s.hooks[i].status = 'enabled';
      return reply(200, s.hooks[i]);
    }
    return reply(404, { error: { message: `unknown route ${route}` } });
  };
  return { state: s, fetch };
}

/** Fake Vercel: remembers what was set, per environment. */
export function fakeVercel({ failOn = [] } = {}) {
  const set = [];
  return {
    set,
    envAdd: async ({ name, value, target = ['production', 'development'] }) => {
      if (failOn.includes(name)) return { ok: false, error: `Vercel refused ${name}=${value}` };
      set.push({ name, value, target });
      return { ok: true, done: target };
    },
    // Like the real Vercel CLI: one row for every variable in every environment (a value set again replaces the old row).
    envLs: async () => {
      const rows = new Map();
      for (const e of set) for (const t of e.target) rows.set(`${e.name}|${t}`, { name: e.name, targets: [t] });
      return { ok: true, names: [...new Set(set.map((e) => e.name))], envs: [...rows.values()] };
    },
  };
}
