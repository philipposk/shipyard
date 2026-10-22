// Vercel helpers. Always the CLI through `npx --yes <VERCEL_CLI>` (no global install).
// Every function takes an options object and returns a plain result:
//   { ok: boolean, error?: string, ...data }
// A failing command never throws. Tests pass a fake `run` in the options.
//
// The subcommands below were checked against Vercel CLI 64.2 (Oct 2026):
//  - `vercel teams list`, `vercel whoami [--json]`, `vercel link --yes --project X --scope Y`
//  - `vercel env add <name> <environment> [--force] [--sensitive|--no-sensitive] [--yes]`
//    reads the value from stdin when it isn't a terminal. One environment per call
//    here (older CLIs only accept one). `preview` needs a git branch, so it is skipped.
//    Sensitive variables are not allowed in `development`.
//  - `vercel env list`, `vercel deploy --prod --yes` (prints the deployment URL on stdout)
//  - `vercel project protection disable <name> --sso`  (exists in 64.x)
//  - `vercel git connect --yes`
import { run as realRun, npx } from './run.mjs';
import { skillHint } from './agent.mjs';

// The one place that says which Vercel CLI version Shipyard runs. An exact version, not `latest`,
// so a new Vercel release can never change what a student's setup does overnight.
// Bump it on purpose, after a test run: log in, link, set a variable and deploy a test app with the new version.
export const VERCEL_CLI = 'vercel@64.3.1';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const clean = (s) => String(s ?? '').replace(ANSI, '');

/** Short, safe text from CLI output for error messages. */
function tail(text, value) {
  let t = clean(text).replace(/<\/?[A-Za-z][^>]*>/g, '').trim();
  if (value) t = t.split(value).join('***');
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !/^Vercel CLI \d/.test(l.trim()) && !/EBADENGINE/.test(l));
  return lines.slice(-4).join(' ').slice(0, 400);
}

async function vercel(args, { cwd, scope, input, run = realRun, timeoutMs = 300_000 } = {}) {
  const [cmd, cmdArgs] = npx([VERCEL_CLI, ...args, ...(scope ? ['--scope', scope] : [])]);
  return run(cmd, cmdArgs, {
    cwd,
    input,
    timeoutMs,
    env: { NO_COLOR: '1', FORCE_COLOR: '0', NO_UPDATE_NOTIFIER: '1' },
  });
}

const failure = (r, value) => ({
  ok: false,
  error: r.code === 127
    ? `Node.js tools (npx) were not found. Run ${skillHint('setup')} to check your tools.`
    : tail(r.stderr || r.stdout, value) || `Vercel stopped with code ${r.code}.`,
});

/** Who is logged in? -> { ok, user } (user is null when logged out). */
export async function whoami(opts = {}) {
  const r = await vercel(['whoami'], { ...opts, timeoutMs: 120_000 });
  if (r.code !== 0) return { ...failure(r), user: null };
  const lines = clean(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const user = lines.at(-1) ?? null;
  return user ? { ok: true, user } : { ok: false, user: null, error: 'Not logged in to Vercel.' };
}

/** Teams the user belongs to -> { ok, teams: [{ id, name }] } (best-effort table parse). */
export async function teams(opts = {}) {
  const r = await vercel(['teams', 'list'], { ...opts, timeoutMs: 120_000 });
  if (r.code !== 0) return { ...failure(r), teams: [] };
  const rows = [];
  for (const raw of clean(r.stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('>') || /^(id|slug|name|team)\b/i.test(line) || /teams? found/i.test(line)) continue;
    const m = /^(\S+)\s*(.*)$/.exec(line);
    if (m) rows.push({ id: m[1], name: m[2].trim() || m[1] });
  }
  return { ok: true, teams: rows };
}

/** Link `cwd` to a project (creates it if it doesn't exist yet). */
export async function link({ cwd, project, scope, run } = {}) {
  if (!project) return { ok: false, error: 'link needs a project name.' };
  const r = await vercel(['link', '--yes', '--project', project], { cwd, scope, run });
  return r.code === 0 ? { ok: true } : failure(r);
}

/**
 * Add or overwrite one environment variable. The value goes in through stdin, so it
 * never appears in the process list or in our output.
 * target: 'production' | 'development' | an array of them (default both).
 * sensitive: 'auto' (default) hides production values in the Vercel dashboard for
 * everything except NEXT_PUBLIC_*; true/false forces it. If the CLI refuses the
 * flag we retry without it.
 */
export async function envAdd({ cwd, name, value, target = ['production', 'development'], scope, sensitive = 'auto', run } = {}) {
  if (!name || typeof value !== 'string' || value === '') return { ok: false, error: 'envAdd needs a name and a value.' };
  if (/[\r\n]/.test(value)) return { ok: false, error: `${name} contains a line break, which Vercel env vars can't hold from the CLI.` };
  const targets = (Array.isArray(target) ? target : [target]).filter((t) => t !== 'preview');
  const wantSensitive = sensitive === 'auto' ? !name.startsWith('NEXT_PUBLIC_') : Boolean(sensitive);
  const done = [];
  for (const t of targets) {
    const base = ['env', 'add', name, t, '--force', '--yes'];
    const useFlag = t === 'development' ? ['--no-sensitive'] : [wantSensitive ? '--sensitive' : '--no-sensitive'];
    let r = await vercel([...base, ...useFlag], { cwd, scope, input: value, run });
    if (r.code !== 0 && t !== 'development' && wantSensitive) {
      r = await vercel([...base, '--no-sensitive'], { cwd, scope, input: value, run });
    }
    if (r.code !== 0) return { ...failure(r, value), done };
    done.push(t);
  }
  return { ok: true, done };
}

/** Variable names set on the linked project -> { ok, names, envs: [{ name, targets }] }. */
export async function envLs({ cwd, scope, run } = {}) {
  const r = await vercel(['env', 'list'], { cwd, scope, run });
  if (r.code !== 0) return { ...failure(r), names: [], envs: [] };
  const envs = [];
  for (const raw of clean(r.stdout).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(raw);
    if (!m || m[1] === 'name') continue;
    const targets = ['production', 'preview', 'development'].filter((t) => new RegExp(t, 'i').test(m[2]));
    if (targets.length > 0) envs.push({ name: m[1], targets });
  }
  return { ok: true, names: [...new Set(envs.map((e) => e.name))], envs };
}

const URL_RE = /https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}[^\s"')]*/g;

/**
 * Deploy the linked project to production -> { ok, url, aliasUrl }.
 * url = the deployment's own address (stdout). aliasUrl = the short production
 * address if the CLI printed one.
 */
export async function deployProd({ cwd, scope, run } = {}) {
  const r = await vercel(['deploy', '--prod', '--yes'], { cwd, scope, run, timeoutMs: 900_000 });
  if (r.code !== 0) return { ...failure(r), url: null, aliasUrl: null };
  const out = clean(r.stdout).match(URL_RE) ?? [];
  const aliasLine = clean(r.stderr).split(/\r?\n/).find((l) => /\baliased:/i.test(l));
  const aliasUrl = aliasLine?.match(URL_RE)?.[0] ?? null;
  const url = out.at(-1) ?? aliasUrl;
  return url ? { ok: true, url, aliasUrl } : { ok: false, url: null, aliasUrl: null, error: 'Vercel finished but did not print the address.' };
}

const MANUAL_PROTECTION =
  'In the Vercel dashboard open your project > Settings > Deployment Protection, turn "Vercel Authentication" off, and save.';

/**
 * Turn off "Vercel Authentication" so visitors can open the site.
 * -> { ok: true } or { ok: false, manual: true, instruction } when the CLI can't do it.
 */
export async function protectionDisable({ cwd, project, scope, run } = {}) {
  const args = ['project', 'protection', 'disable', ...(project ? [project] : []), '--sso'];
  const r = await vercel(args, { cwd, scope, run });
  if (r.code === 0) return { ok: true };
  return { ok: false, manual: true, instruction: MANUAL_PROTECTION, error: failure(r).error };
}

/** Connect the linked project to its GitHub repo (deploys on push). */
export async function gitConnect({ cwd, scope, run } = {}) {
  const r = await vercel(['git', 'connect', '--yes'], { cwd, scope, run });
  if (r.code === 0) return { ok: true };
  if (/already connected/i.test(`${clean(r.stdout)}\n${clean(r.stderr)}`)) return { ok: true, already: true };
  return failure(r);
}
