#!/usr/bin/env node
// Send one short email to the owner through Resend, with the app's name as the sender
// and a first line that says why the reader got it. Ported from 6x7-app-factory's
// notify-ready.ts (PR #3), which is what sends the "<App> is live" email in production.
// Never prints a key.
import { readSecrets } from './lib/secrets.mjs';
import { loadProfile } from './lib/profile.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, fail, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const HELP = `Usage: notify.mjs <app-name-or-slug> --url <https://...> [options]

Sends one email to you (the app owner) through Resend. Default: "<App> is live".
  --url <url>        the address the email is about (required)
  --kind live|custom live (default) = "<App> is live on <host>"; custom = use --subject and --message
  --subject <text>   subject for --kind custom
  --message <text>   body sentence for --kind custom
  --reason <text>    the "why you got this" first line (default: you deployed <App> to <host>)
  --to <email>       default: owner.email from your Shipyard profile
  --from <address>   sending address; default noreply@<your verified Resend domain>
  --dry-run          print the email (JSON) and send nothing
  --json             machine-readable output
Uses RESEND_API_KEY from ~/.shipyard/secrets.env. Exit 0 = sent (or dry run), 1 = failed, 2 = bad usage.
`;

/** "ballpark" -> "Ballpark", "journal-find" -> "Journal Find"; empty -> fallback. Names with capitals or spaces are kept. */
export function appDisplayName(slugOrName, fallback = 'Shipyard') {
  const raw = String(slugOrName ?? '').trim();
  if (!raw) return fallback;
  if (/[A-Z ]/.test(raw)) return raw;
  const out = raw.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return out || fallback;
}

/** "Name <addr>" with the app name as display name; strips characters that could break the header. */
export function senderFor(appName, address) {
  const m = String(address ?? '').match(/<([^>]+)>/);
  const addr = (m ? m[1] : String(address ?? '').trim()) || 'onboarding@resend.dev';
  const safe = String(appName).replace(/["<>\r\n]/g, '').trim() || 'Shipyard';
  return `${safe} <${addr}>`;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Build the email. Pure: no network, no files. */
export function buildEmail({ app, url, kind = 'live', subject, message, reason, to, from }) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    throw new UsageError(`--url must be a full address like https://myapp.com (got "${url}")`);
  }
  if (!/^https?:$/.test(new URL(url).protocol)) throw new UsageError('--url must start with https:// or http://');
  const name = appDisplayName(app);
  const why = reason || `You're receiving this because you deployed ${name} to ${host}.`;
  let subj;
  let body;
  if (kind === 'live') {
    subj = `${name} is live on ${host}`;
    body = 'It is live and verified.';
  } else if (kind === 'custom') {
    if (!subject || !message) throw new UsageError('--kind custom needs --subject and --message');
    subj = subject;
    body = message;
  } else {
    throw new UsageError('--kind must be live or custom');
  }
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.5">` +
    `<p style="color:#666;font-size:13px">${escapeHtml(why)}</p>` +
    `<p>${escapeHtml(body)}</p>` +
    `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p></div>`;
  const text = `${why}\n\n${body}\n${url}`;
  return { from: senderFor(name, from), to, subject: subj, html, text };
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv, {
    boolean: ['json', 'help', 'dry-run'],
    string: ['url', 'kind', 'subject', 'message', 'reason', 'to', 'from'],
    alias: { h: 'help' },
  });
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.json) setQuiet(true);
  const app = args._[0];
  if (!app || !args.url) throw new UsageError('Give the app name and --url. Run with --help for details.');
  const profile = await (deps.loadProfile ?? loadProfile)();
  const to = args.to || profile?.owner?.email;
  const domain = profile?.accounts?.resend?.domain;
  const from = args.from || (domain ? `noreply@${domain}` : '');
  const email = buildEmail({ app, url: args.url, kind: args.kind || 'live', subject: args.subject, message: args.message, reason: args.reason, to, from });

  if (args['dry-run']) {
    if (args.json) json({ ok: true, dryRun: true, email });
    else process.stdout.write(`${JSON.stringify(email, null, 2)}\n`);
    return 0;
  }
  if (!to) {
    fail('No recipient. Set your email in the profile (profile.mjs set owner.email you@example.com) or pass --to.');
    return 1;
  }
  if (!from) info('No verified Resend domain in your profile, so this sends from onboarding@resend.dev (it only reaches your own Resend address).');
  const key = (await (deps.readSecrets ?? readSecrets)()).get('RESEND_API_KEY');
  if (!key) {
    fail('RESEND_API_KEY is missing from your Shipyard keys file. Add it with secrets-init.mjs.');
    return 1;
  }
  const res = await (deps.fetch ?? fetch)('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(email),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    if (args.json) json({ ok: false, status: res.status });
    else fail(`Resend did not send it (HTTP ${res.status}). Check the sending domain is verified in Resend.`);
    return 1;
  }
  if (args.json) json({ ok: true, to, subject: email.subject });
  else ok(`Sent "${email.subject}" to ${to}`);
  return 0;
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
