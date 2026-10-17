// Create (or find) the app's Vercel project, copy its settings over, open the site to
// visitors and connect it to GitHub. Safe to run again.
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import * as realVercel from '../lib/vercel.mjs';
import { readSecrets as realReadSecrets, parseEnv, ACCOUNT_LEVEL_SECRETS, LIVE_ONLY_SECRETS, PER_APP_SECRETS } from '../lib/secrets.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import {
  APP_CONFIG_FILE, ProvisionError, readAppConfig, updateAppConfig, appEnvNames, git, repoDisplay,
} from './common.mjs';
import { readEnvText } from './envfile.mjs';

const REQUIRED_SUPABASE = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const SITE_URL_NAME = 'NEXT_PUBLIC_SITE_URL';
const SCHEMA_ENV_NAME = 'NEXT_PUBLIC_SUPABASE_SCHEMA';
// Once the app takes real payments, production holds the live Stripe values. A later run of this script must not put
// the test ones back over them, so these names are only refreshed in the development environment from then on.
const PAYMENT_NAMES = new Set(['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PORTAL_CONFIGURATION']);

/**
 * 'vercel link' appends a bare '.env*' line to .gitignore, which would also hide .env.example-style files.
 * Replace it with '.env*.local' (what the app needs) unless the file already keeps .env.example visible.
 */
export async function fixGitignore(appDir) {
  const file = path.join(appDir, '.gitignore');
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return false; }
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => l.trim() === '.env*')) return false;
  if (lines.some((l) => l.trim() === '!.env.example')) return false;
  const out = [];
  for (const l of lines) {
    if (l.trim() !== '.env*') { out.push(l); continue; }
    if (!lines.some((x) => x.trim() === '.env*.local') && !out.some((x) => x.trim() === '.env*.local')) out.push('.env*.local');
  }
  await writeFile(file, out.join('\n'));
  return true;
}

/** Check the app is a git repo with a GitHub remote and a pushed main branch. Returns the remote address. */
export async function checkPushed(run, appDir) {
  const inside = await git(run, appDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.out !== 'true') {
    throw new ProvisionError('This folder is not a git repository yet. Save it to GitHub first (the new-app steps do this), then run this again.');
  }
  const remote = await git(run, appDir, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0 || !remote.out) {
    throw new ProvisionError('Push first: this app is not on GitHub yet. Create the GitHub repository and push the main branch, then run this again.');
  }
  const pushed = await git(run, appDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  if (pushed.code !== 0) {
    throw new ProvisionError('Push first: the main branch is not on GitHub yet. Run "git push -u origin main", then run this again.');
  }
  return remote.out;
}

/**
 * The values to send to Vercel: names from .shipyard-app.json, values from .env.local first.
 * Only names on the per-app list (AI, email, payment and Google keys) may also come from the Shipyard keys
 * file; any other name is read from .env.local only. Account-level keys (like the Supabase access token,
 * which controls every project) are refused with an error, wherever they came from.
 * Returns { values: Map, missing: [names] } (never printed).
 */
export async function collectEnv({ appDir, config, readSecrets }) {
  const names = appEnvNames(config);
  // An app in its own schema inside a shared Supabase project needs the schema name in production too, or it would
  // read the public schema (which belongs to the other apps).
  if (config.shared && !names.includes(SCHEMA_ENV_NAME)) names.push(SCHEMA_ENV_NAME);
  const liveNames = names.filter((n) => LIVE_ONLY_SECRETS.has(n));
  if (liveNames.length > 0) {
    throw new ProvisionError(
      `${liveNames.join(', ')} can not be in "env" in ${APP_CONFIG_FILE}: real-money keys are only sent by the go-live step (stripe-setup.mjs --live), never copied with the other settings. `
      + `Remove ${liveNames.length === 1 ? 'it' : 'them'} from "env". Nothing was sent.`,
      { reason: 'live-key', names: liveNames },
    );
  }
  const forbidden = names.filter((n) => ACCOUNT_LEVEL_SECRETS.has(n));
  if (forbidden.length > 0) {
    throw new ProvisionError(
      `${forbidden.join(', ')} can not go into an app's settings: ${forbidden.length === 1 ? 'it controls' : 'they control'} your whole account, not just this app. `
      + `Remove ${forbidden.length === 1 ? 'it' : 'them'} from "env" in ${APP_CONFIG_FILE}. Nothing was sent.`,
      { reason: 'account-level-key', names: forbidden },
    );
  }
  const local = parseEnv(await readEnvText(path.join(appDir, '.env.local')));
  const secrets = await readSecrets();
  const values = new Map();
  const missing = [];
  for (const name of names) {
    if (name === SITE_URL_NAME) continue;
    const value = local.get(name) || (PER_APP_SECRETS.has(name) ? secrets.get(name) : '') || '';
    if (value) values.set(name, value);
    else missing.push(name);
  }
  return { values, missing };
}

/**
 * opts: { appDir }
 * deps: { run, vercel, readSecrets, profile } (all optional, for tests)
 */
export async function provisionVercel(opts, deps = {}) {
  const { appDir } = opts;
  const run = deps.run ?? realRun;
  const vercel = deps.vercel ?? realVercel;
  const profileApi = deps.profile ?? realProfile;
  const readSecrets = deps.readSecrets ?? realReadSecrets;
  const total = 6;

  const config = await readAppConfig(appDir);
  const slug = config.slug;
  const profile = await profileApi.loadProfile();
  const scope = profile.accounts?.vercel?.scope || undefined;
  const app = (profile.apps ?? []).find((a) => a.slug === slug) ?? null;

  log.step(1, total, 'Checking the app is on GitHub');
  const remote = await checkPushed(run, appDir);
  log.ok('The main branch is on GitHub.');

  const { values, missing } = await collectEnv({ appDir, config, readSecrets });
  const lacking = [...REQUIRED_SUPABASE, ...(config.shared ? [SCHEMA_ENV_NAME] : [])].filter((n) => !values.has(n));
  if (lacking.length > 0) {
    throw new ProvisionError(`The Supabase settings are not in .env.local yet (${lacking.join(', ')}). Run provision-supabase.mjs on this folder first.`);
  }

  log.step(2, total, 'Checking you are logged in to Vercel');
  const who = await vercel.whoami({ cwd: appDir, run });
  if (!who.ok) {
    throw new ProvisionError(`You are not logged in to Vercel. Run /shipyard:setup and finish the "vercel" step. (${who.error ?? 'no details'})`);
  }
  log.ok(`Logged in to Vercel as ${who.user}.`);

  log.step(3, total, `Creating the Vercel project "${slug}"`);
  const linked = await vercel.link({ cwd: appDir, project: slug, scope, run });
  if (!linked.ok) throw new ProvisionError(`Vercel could not create or link the project. ${linked.error}`);
  log.ok('Project linked.');
  await fixGitignore(appDir);

  // The address is only known after the first deploy. Vercel's usual one is <name>.vercel.app;
  // deploy.mjs corrects it if Vercel picked another.
  const siteUrl = config.url || config.siteUrl || `https://${slug}.vercel.app`;

  log.step(4, total, 'Copying the app settings to Vercel');
  const envSet = [];
  const failures = [];
  const paymentsLive = config.launch?.billing?.mode === 'live';
  for (const [name, value] of values) {
    const keepProduction = paymentsLive && PAYMENT_NAMES.has(name);
    const r = await vercel.envAdd({ cwd: appDir, name, value, scope, run, ...(keepProduction ? { target: ['development'] } : {}) });
    if (r.ok) envSet.push(name);
    else failures.push({ name, error: r.error });
  }
  const site = await vercel.envAdd({ cwd: appDir, name: SITE_URL_NAME, value: siteUrl, target: ['production'], scope, run });
  if (site.ok) envSet.push(SITE_URL_NAME);
  else failures.push({ name: SITE_URL_NAME, error: site.error });
  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.name}: ${f.error}`).join('; ');
    throw new ProvisionError(`Vercel did not accept ${failures.length} setting${failures.length === 1 ? '' : 's'} (${failures.map((f) => f.name).join(', ')}). ${detail}`, { envSet, envFailed: failures.map((f) => f.name) });
  }
  log.ok(`${envSet.length} settings copied.`);
  if (missing.length > 0) log.info(`Not set (no value found, fine if you do not use them): ${missing.join(', ')}`);

  log.step(5, total, 'Opening the site to visitors');
  const protection = await vercel.protectionDisable({ cwd: appDir, project: slug, scope, run });
  const protectionManual = !protection.ok;
  if (protection.ok) log.ok('Vercel Authentication is off, so anyone can open the site.');
  else log.warn(`Do this by hand: ${protection.instruction ?? 'In the Vercel dashboard turn off Vercel Authentication for this project.'}`);

  log.step(6, total, 'Connecting GitHub, so a push can deploy');
  const connected = await vercel.gitConnect({ cwd: appDir, scope, run });
  if (connected.ok) log.ok('GitHub is connected.');
  else log.warn(`Could not connect GitHub automatically (${connected.error}). Deploying with deploy.mjs still works.`);

  await updateAppConfig(appDir, { vercelProject: slug, siteUrl });
  await profileApi.upsertApp({
    slug,
    vercelProject: slug,
    repo: repoDisplay(remote),
    status: app?.status === 'live' ? 'live' : 'provisioned',
    step: 'vercel',
  });

  return {
    ok: true,
    project: slug,
    scope: scope ?? null,
    siteUrl,
    envSet,
    envMissing: missing,
    protection: protectionManual ? { ok: false, manual: true, instruction: protection.instruction } : { ok: true },
    gitConnected: connected.ok,
  };
}
