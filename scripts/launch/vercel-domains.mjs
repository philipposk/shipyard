// `vercel domains ...` through the pinned Vercel CLI. Same rules as lib/vercel.mjs: never throws, returns { ok, ... }.
import { run as realRun, npx } from '../lib/run.mjs';
import { VERCEL_CLI } from '../lib/vercel.mjs';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const clean = (s) => String(s ?? '').replace(ANSI, '');

async function vercel(args, { cwd, scope, run = realRun, timeoutMs = 180_000 } = {}) {
  const [cmd, cmdArgs] = npx([VERCEL_CLI, ...args, ...(scope ? ['--scope', scope] : [])]);
  return run(cmd, cmdArgs, { cwd, timeoutMs, env: { NO_COLOR: '1', FORCE_COLOR: '0', NO_UPDATE_NOTIFIER: '1' } });
}

const tail = (r) => {
  const lines = clean(r.stderr || r.stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Vercel CLI \d/.test(l) && !/EBADENGINE/.test(l));
  return lines.slice(-3).join(' ').slice(0, 300);
};

/** Add a domain to the project. "Already added" counts as success, so a re-run is safe. */
export async function domainsAdd({ cwd, domain, project, scope, run } = {}) {
  const r = await vercel(['domains', 'add', domain, project], { cwd, scope, run });
  const text = clean(`${r.stdout}\n${r.stderr}`);
  if (r.code === 0) return { ok: true, already: /already (?:added|assigned|exists|in use by this|on this)/i.test(text) };
  if (/already (?:added|assigned|exists|in use by this|on this)|is already assigned to this project/i.test(text)) return { ok: true, already: true };
  if (/verif/i.test(text) && /(another|different) (?:account|team|project)|TXT/i.test(text)) {
    return { ok: false, needsVerification: true, error: 'Vercel says this domain is used by another Vercel account or project, and wants a proof of ownership (a TXT record). Open the project in the Vercel dashboard > Settings > Domains and follow the steps it shows.' };
  }
  return { ok: false, error: tail(r) || `Vercel stopped with code ${r.code}.` };
}

/** Find the first JSON object in CLI output. */
export function extractJson(text) {
  const t = clean(text);
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const asRecords = (list) => (Array.isArray(list) ? list : [])
  .map((r) => ({ type: String(r?.type ?? '').toUpperCase(), name: String(r?.name ?? r?.host ?? '@'), value: String(r?.value ?? '') }))
  .filter((r) => r.type && r.value);

/**
 * Ask Vercel what DNS the domain needs (`vercel domains verify <domain> --project <p> --format=json`).
 * -> { ok (DNS already right), parsed, records, nameservers, conflicts, message }
 * Checked against the Vercel CLI docs and changelog (Oct 2026): the JSON holds `ok`, `status`, `reason`, `message`,
 * `recommended.records[{type,name,value}]`, `recommended.nameservers[]`, `conflicts[]`.
 */
export async function domainsVerify({ cwd, domain, project, scope, run } = {}) {
  const r = await vercel(['domains', 'verify', domain, '--project', project, '--format=json'], { cwd, scope, run });
  const json = extractJson(r.stdout) ?? extractJson(r.stderr);
  if (!json || typeof json !== 'object') {
    return { ok: false, parsed: false, records: [], nameservers: [], conflicts: [], message: tail(r) };
  }
  return {
    ok: json.ok === true,
    parsed: true,
    records: asRecords(json.recommended?.records),
    nameservers: (Array.isArray(json.recommended?.nameservers) ? json.recommended.nameservers : []).map(String),
    conflicts: Array.isArray(json.conflicts) ? json.conflicts : [],
    message: typeof json.message === 'string' ? json.message : '',
  };
}
