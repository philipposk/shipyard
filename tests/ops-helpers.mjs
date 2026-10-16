// Shared fixtures for the ops tests: a scaffolded app with a fake GitHub remote, a fake `gh`, a fake Vercel.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const TEMPLATES = path.join(ROOT, 'ops', 'templates');

// A key-shaped value assembled at run time, so no key-like text sits in the repo.
export const FAKE_SECRET = `${'f'.repeat(32)}${'0123456789abcdef'.repeat(2)}`;

export const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
export const bad = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

/** A temp folder with SHIPYARD_HOME inside it. Call cleanup() when done. */
export async function tempHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-ops-'));
  return { dir, home: path.join(dir, 'home'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A fake GitHub. State lives in `gh.state`; every call is recorded in `gh.calls`.
 * Pass { git: realRun } to let git calls through to the real program.
 */
export function makeFakes({ gitRun, repo = 'test-user/tea-shop', overrides = {}, repoInfo = {}, vercelEnv = [] } = {}) {
  const state = {
    vars: {}, secrets: [], labels: [], rulesets: [], protectedChecks: false, ruleChecks: false,
    repo: { private: false, default_branch: 'main', allow_auto_merge: false, delete_branch_on_merge: false, ...repoInfo },
    runs: [], issues: [], loggedIn: true, patched: null, postedRuleset: null,
  };
  const calls = [];
  const gh = async (args, opts = {}) => {
    const key = args.join(' ');
    calls.push({ cmd: 'gh', args, input: opts.input });
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (key.startsWith(prefix)) return typeof handler === 'function' ? handler(args, opts) : handler;
    }
    if (!state.loggedIn) return bad('You are not logged into any GitHub hosts. Run gh auth login to authenticate.');
    if (key === 'auth status') return ok('Logged in');
    if (args[0] === 'label' && args[1] === 'create') {
      state.labels.push(args[2]);
      return ok();
    }
    if (key.startsWith('variable get')) return state.vars[args[2]] ? ok(`${state.vars[args[2]]}\n`) : bad('variable not found (HTTP 404)');
    if (key.startsWith('variable set')) {
      state.vars[args[2]] = args[args.indexOf('--body') + 1];
      return ok();
    }
    if (key.startsWith('secret list')) return ok(JSON.stringify(state.secrets.map((name) => ({ name }))));
    if (key.startsWith('secret set')) {
      if (!state.secrets.includes(args[2])) state.secrets.push(args[2]);
      state.lastSecretInput = opts.input;
      return ok();
    }
    if (key === `api repos/${repo}`) return ok(JSON.stringify(state.repo));
    if (key.startsWith(`api repos/${repo}/branches/`)) {
      return ok(JSON.stringify(state.protectedChecks
        ? { protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['test'], checks: [] } } }
        : { protected: false }));
    }
    if (key.startsWith(`api repos/${repo}/rules/branches/`)) return ok(JSON.stringify(state.ruleChecks ? [{ type: 'required_status_checks' }] : []));
    if (key === `api repos/${repo}/rulesets`) return ok(JSON.stringify(state.rulesets.map((name) => ({ name }))));
    if (key.startsWith('api -X PATCH')) {
      state.patched = args.slice(3);
      for (let i = 0; i < args.length; i++) if (args[i] === '-F') state.repo[args[i + 1].split('=')[0]] = true;
      return ok();
    }
    if (key.startsWith(`api -X POST repos/${repo}/rulesets`)) {
      state.postedRuleset = JSON.parse(opts.input);
      state.rulesets.push(state.postedRuleset.name);
      state.ruleChecks = true;
      return ok('{}');
    }
    if (key.startsWith('run list')) return ok(JSON.stringify(state.runs));
    if (key.startsWith('issue list')) return ok(JSON.stringify(state.issues));
    return ok();
  };
  const run = async (cmd, args, opts = {}) => {
    if (cmd === 'git') {
      if (!gitRun) return ok();
      return gitRun(cmd, args, opts);
    }
    if (cmd === 'gh') return gh(args, opts);
    calls.push({ cmd, args, input: opts.input });
    return ok();
  };
  const vercelCalls = [];
  const vercelState = { env: vercelEnv.map((name) => ({ name, targets: ['production'] })), failAdd: false };
  const vercel = {
    envLs: async (o) => {
      vercelCalls.push({ fn: 'envLs', cwd: o.cwd });
      return { ok: true, names: vercelState.env.map((e) => e.name), envs: vercelState.env };
    },
    envAdd: async (o) => {
      vercelCalls.push({ fn: 'envAdd', name: o.name, target: o.target, value: o.value });
      if (vercelState.failAdd) return { ok: false, error: 'Vercel said no.' };
      if (!vercelState.env.some((e) => e.name === o.name)) vercelState.env.push({ name: o.name, targets: o.target });
      return { ok: true, done: o.target };
    },
  };
  return { run, calls, gh, state, vercel, vercelCalls, vercelState, repo };
}
