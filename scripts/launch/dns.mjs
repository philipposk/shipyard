// DNS checks through public resolvers (1.1.1.1 and 8.8.8.8), so the answer is what the whole internet sees,
// not what this computer remembers. Resolvers are objects, so tests can pass fakes.
import { Resolver } from 'node:dns/promises';

export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

const strip = (s) => String(s).trim().toLowerCase().replace(/\.$/, '');

/** A real resolver that asks one public server. Never throws: "no answer" is an empty list. */
export function createResolver(server, { timeoutMs = 4000 } = {}) {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  r.setServers([server]);
  const safe = async (fn) => {
    try {
      return (await fn()).map(strip);
    } catch {
      return [];
    }
  };
  return {
    name: server,
    resolve4: (host) => safe(() => r.resolve4(host)),
    resolveCname: (host) => safe(() => r.resolveCname(host)),
    resolveNs: (host) => safe(() => r.resolveNs(host)),
  };
}

export const defaultResolvers = () => PUBLIC_RESOLVERS.map((s) => createResolver(s));

/** Vercel's own CNAME targets: cname.vercel-dns.com and the per-project ones like abc123.vercel-dns-017.com. */
export const isVercelDnsTarget = (target) => /(?:^|\.)vercel-dns(?:-\d+)?\.com$/.test(strip(target));

const VERCEL_APEX_A = '76.76.21.21';
/** Vercel's address blocks. A registrar that flattens an apex CNAME answers with an address from here, not 76.76.21.21. */
export const isVercelAddress = (ip) => /^(?:76\.76\.21|66\.33\.60)\.\d{1,3}$/.test(String(ip).trim());

/**
 * Does one resolver see the records we asked the student to add for `host`?
 * records: [{ type: 'A'|'CNAME', name, value }], nameservers: ['ns1.vercel-dns.com', ...]
 * -> { ok, found: [...], via: 'A' | 'CNAME' | 'NS' | null }
 */
export async function hostResolvesToVercel(resolver, host, { records = [], nameservers = [] } = {}) {
  const wantA = new Set([VERCEL_APEX_A, ...records.filter((r) => r.type === 'A').map((r) => r.value)]);
  const wantCname = records.filter((r) => r.type === 'CNAME').map((r) => strip(r.value));
  const cnames = await resolver.resolveCname(host);
  if (cnames.length > 0) {
    const good = cnames.some((c) => wantCname.includes(c) || isVercelDnsTarget(c));
    return { ok: good, found: cnames, via: 'CNAME' };
  }
  const as = await resolver.resolve4(host);
  if (as.some((a) => wantA.has(a) || isVercelAddress(a))) return { ok: true, found: as, via: 'A' };
  if (nameservers.length > 0) {
    const labels = host.split('.');
    // The name servers live on the registered domain; try from the host upwards.
    for (let i = 0; i <= labels.length - 2; i++) {
      const zone = labels.slice(i).join('.');
      const ns = await resolver.resolveNs(zone);
      if (ns.length > 0) {
        const want = nameservers.map(strip);
        if (ns.some((n) => want.includes(n))) return { ok: true, found: ns, via: 'NS' };
        break;
      }
    }
  }
  return { ok: false, found: [...cnames, ...as], via: null };
}

/** Every public resolver must agree. -> { ok, perResolver: [{ resolver, ok, found, via }] } */
export async function checkDns(resolvers, host, expected) {
  const perResolver = [];
  for (const r of resolvers) {
    const res = await hostResolvesToVercel(r, host, expected);
    perResolver.push({ resolver: r.name, ...res });
  }
  return { ok: perResolver.length > 0 && perResolver.every((p) => p.ok), perResolver };
}

/**
 * Does https://<host>/ answer the way Vercel answers? Vercel adds an `x-vercel-id` header to every answer (and says
 * `server: Vercel`). This works when the address lists look wrong but the site is fine: a registrar that flattens an apex
 * CNAME, or Cloudflare's orange-cloud proxy, which answers with Cloudflare's own addresses.
 * Never throws. -> { ok, status }
 */
export async function answeredByVercel(host, { fetch: doFetch = fetch } = {}) {
  try {
    const res = await doFetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'shipyard-domain-check' } });
    const header = (name) => String(res.headers?.get?.(name) ?? '');
    return { ok: Boolean(header('x-vercel-id')) || /^vercel$/i.test(header('server').trim()), status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
