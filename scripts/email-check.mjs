#!/usr/bin/env node
// Checks a domain's email DNS: receiving (MX, e.g. ImprovMX), SPF, DMARC and the Resend
// sending subdomain (DKIM + SPF on send.<domain>). Read-only DNS lookups, no keys.
// Generalised from 6x7-app-factory's verify-dns.sh and the real 6x7.gr setup
// (ImprovMX MX + SPF at Papaki, Resend on send.6x7.gr).
import { Resolver } from 'node:dns/promises';
import { isMainModule } from './lib/paths.mjs';
import { ok, fail, warn, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const HELP = `Usage: email-check.mjs <domain> [--send-subdomain send] [--gmail-send-as] [--json]

Looks up the email records of <domain> on public DNS (Google's DNS over HTTPS, falling
back to this computer's resolver; only the domain name is sent) and says
what is right and what to add at the registrar (Papaki, Cloudflare, Namecheap, ...).
  --send-subdomain <name>  Resend sending subdomain (default "send"; "" to skip)
  --gmail-send-as          you send as @<domain> from Gmail ("Send mail as"): SPF must
                           include _spf.google.com (warns if it does not)
  --json                   machine-readable output
Exit code: 0 = receiving, SPF and DMARC are fine, 1 = something to fix, 2 = bad usage.
`;

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const joinTxt = (records) => (records ?? []).map((r) => (Array.isArray(r) ? r.join('') : String(r)));

/** Pure: turn looked-up records into checks. */
export function analyse(domain, rec, sendSub = 'send', opts = {}) {
  const gmail = Boolean(opts.gmailSendAs);
  const checks = [];
  const mx = (rec.mx ?? []).map((m) => String(m.exchange).toLowerCase()).filter(Boolean);
  const improv = mx.some((h) => h.endsWith('improvmx.com'));
  checks.push(mx.length
    ? { id: 'mx', ok: true, text: `Receiving: mail for @${domain} goes to ${mx.join(', ')}${improv ? ' (ImprovMX forwarding)' : ''}` }
    : { id: 'mx', ok: false, text: `Receiving: no MX records, so mail to @${domain} bounces`, fix: 'For free forwarding to Gmail with ImprovMX add: MX @ mx1.improvmx.com (priority 10) and MX @ mx2.improvmx.com (priority 20).' });

  const spf = joinTxt(rec.txt).filter((t) => /^v=spf1\b/i.test(t));
  if (spf.length === 0) {
    checks.push({ id: 'spf', ok: false, text: 'SPF: missing on the main domain', fix: `TXT @ "v=spf1${improv ? ' include:spf.improvmx.com' : ''}${gmail ? ' include:_spf.google.com' : ''} ~all" (one SPF line only; add include: entries for every service that sends as @${domain})` });
  } else if (spf.length > 1) {
    checks.push({ id: 'spf', ok: false, text: 'SPF: more than one SPF record (both are then ignored)', fix: 'Merge them into one TXT line starting v=spf1.' });
  } else if (improv && !/include:spf\.improvmx\.com/i.test(spf[0])) {
    checks.push({ id: 'spf', ok: false, text: `SPF: "${spf[0]}" does not include ImprovMX`, fix: 'Add include:spf.improvmx.com to that same line.' });
  } else {
    checks.push({ id: 'spf', ok: true, text: `SPF: ${spf[0]}` });
  }
  // Gmail "Send mail as" sends from Google's servers, so the one SPF line must list Google.
  if (gmail && spf.length === 1 && !/include:_spf\.google\.com/i.test(spf[0])) {
    const merged = spf[0].replace(/\s+([~?+-]all)\b/i, ' include:_spf.google.com $1');
    checks.push({ id: 'spf-gmail', ok: false, optional: true,
      text: `SPF: you send from Gmail as @${domain}, but "${spf[0]}" does not include Google, so that mail often lands in spam`,
      fix: `Edit the existing SPF line (keep exactly one): "${merged === spf[0] ? `${spf[0]} include:_spf.google.com` : merged}"` });
  }

  const dmarc = joinTxt(rec.dmarc).find((t) => /^v=DMARC1\b/i.test(t));
  checks.push(dmarc
    ? { id: 'dmarc', ok: true, text: `DMARC: ${dmarc}` }
    : { id: 'dmarc', ok: false, text: 'DMARC: missing (Gmail and Outlook often junk new domains without it)', fix: `TXT _dmarc "v=DMARC1; p=none; rua=mailto:dmarc@${domain}"  (move to p=quarantine after two clean weeks)` });

  if (sendSub) {
    const host = `${sendSub}.${domain}`;
    const dkim = joinTxt(rec.dkim).some((t) => /p=/.test(t));
    const sendSpf = joinTxt(rec.sendTxt).some((t) => /^v=spf1\b/i.test(t));
    const sendMx = (rec.sendMx ?? []).length > 0;
    const found = sendSpf || sendMx;
    checks.push({
      id: 'send', ok: dkim && sendSpf && sendMx, optional: true,
      text: dkim && sendSpf && sendMx
        ? `Sending (Resend) on ${host}: DKIM, SPF and return path found`
        : `Sending (Resend) on ${host}: ${[!dkim && 'DKIM', !sendSpf && 'SPF', !sendMx && 'MX (return path)'].filter(Boolean).join(', ')} not found`,
      // Report only. Records that are already there belong to a working setup; never suggest replacing them.
      fix: dkim && sendSpf && sendMx
        ? undefined
        : found
          ? `${host} already has sending records. If email from it arrives fine, leave them as they are; only report this.`
          : `Only if this domain should send app email through Resend and nothing sends from ${host} yet: launch-email.mjs <appDir> --domain ${host} prints the exact records.`,
    });
  }
  const needed = checks.filter((c) => !c.optional);
  return { domain, ok: needed.every((c) => c.ok), checks };
}

// "No such record" is an answer; anything else (timeout, refused) means this resolver is unusable.
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'ENONAME']);
async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    if (NO_RECORD.has(err?.code)) return [];
    throw err;
  }
}

/**
 * DNS over HTTPS (Google's public JSON API). Works on networks that block plain DNS
 * (some sandboxes answer "no record" for everything) and gives fresh, uncached answers.
 */
export function dohResolver(fetchImpl = fetch) {
  const ask = async (name, type) => {
    const res = await fetchImpl(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw Object.assign(new Error(`DNS over HTTPS answered ${res.status}`), { code: 'EDOH' });
    const body = await res.json();
    if (body.Status === 3) throw Object.assign(new Error('no such name'), { code: 'ENOTFOUND' });
    const want = type === 'MX' ? 15 : 16;
    return (body.Answer ?? []).filter((a) => a.type === want).map((a) => String(a.data));
  };
  return {
    resolveMx: async (n) => (await ask(n, 'MX')).map((d) => {
      const [priority, exchange] = d.split(/\s+/);
      return { priority: Number(priority), exchange: String(exchange ?? '').replace(/\.$/, '') };
    }),
    // TXT data arrives quoted, possibly in several quoted chunks.
    resolveTxt: async (n) => (await ask(n, 'TXT')).map((d) => [d.replace(/^"|"$/g, '').replace(/"\s*"/g, '')]),
  };
}

/** DNS over HTTPS first; the computer's own resolver if HTTPS lookups fail. */
export async function lookup(domain, sendSub = 'send', resolver) {
  if (resolver) return lookupWith(resolver, domain, sendSub);
  try {
    return await lookupWith(dohResolver(), domain, sendSub);
  } catch {
    return lookupWith(new Resolver({ timeout: 5000, tries: 2 }), domain, sendSub);
  }
}

async function lookupWith(r, domain, sendSub) {
  const send = sendSub ? `${sendSub}.${domain}` : null;
  const [mx, txt, dmarc, dkim, rootDkim, sendTxt, sendMx] = await Promise.all([
    safe(() => r.resolveMx(domain)),
    safe(() => r.resolveTxt(domain)),
    safe(() => r.resolveTxt(`_dmarc.${domain}`)),
    send ? safe(() => r.resolveTxt(`resend._domainkey.${send}`)) : [],
    // A Resend domain added as the main domain keeps DKIM here and uses send.<domain> as return path.
    safe(() => r.resolveTxt(`resend._domainkey.${domain}`)),
    send ? safe(() => r.resolveTxt(send)) : [],
    send ? safe(() => r.resolveMx(send)) : [],
  ]);
  return { mx, txt, dmarc, dkim: [...dkim, ...rootDkim], sendTxt, sendMx };
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv, { boolean: ['json', 'help', 'gmail-send-as'], string: ['send-subdomain'], alias: { h: 'help' } });
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const domain = String(args._[0] ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(domain)) throw new UsageError('Give a domain like example.com. Run with --help for details.');
  const sendSub = args['send-subdomain'] ?? 'send';
  if (args.json) setQuiet(true);
  const result = analyse(domain, await lookup(domain, sendSub, deps.resolver), sendSub, { gmailSendAs: args['gmail-send-as'] });
  if (args.json) {
    json(result);
  } else {
    for (const c of result.checks) {
      if (c.ok) ok(c.text);
      else {
        (c.optional ? warn : fail)(c.text);
        if (c.fix) info(`  Add: ${c.fix}`);
      }
    }
    if (result.ok) ok('Email DNS looks right. Last step: send a real test (see the email skill).');
  }
  return result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = err instanceof UsageError ? 2 : 1;
    },
  );
}
