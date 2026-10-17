// Put the app online (Vercel production), check the public site really opens,
// then tell Supabase the app's real address.
import path from 'node:path';
import { existsSync } from 'node:fs';
import * as realVercel from '../lib/vercel.mjs';
import { run as realRun } from '../lib/run.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { ProvisionError, readAppConfig, updateAppConfig, git, originOf } from './common.mjs';
import { setAuthUrlsForApp } from './supabase-core.mjs';

const SITE_URL_NAME = 'NEXT_PUBLIC_SITE_URL';
const LOGIN_PAGE = /vercel\.com\/(?:sso|login)|_vercel\/sso|Authentication Required/i;

/** Refuse to deploy unless everything is saved to GitHub. Throws a plain-English error. */
export async function checkSavedAndPushed(run, appDir) {
  const status = await git(run, appDir, ['status', '--porcelain', '--', '.', `:(exclude).shipyard-app.json`]);
  if (status.code !== 0) {
    throw new ProvisionError('This folder is not a git repository, so Shipyard can not tell what is saved. Commit and push first.');
  }
  if (status.out !== '') {
    throw new ProvisionError('You have changes that are not saved yet. Commit and push first, so the version online matches GitHub.');
  }
  const heads = await git(run, appDir, ['rev-parse', 'HEAD', 'refs/remotes/origin/main']);
  const [local, remote] = heads.out.split(/\r?\n/);
  if (heads.code !== 0 || !local || !remote) {
    throw new ProvisionError('The main branch is not on GitHub yet. Commit and push first (git push -u origin main).');
  }
  if (local !== remote) {
    throw new ProvisionError('Your latest saved version is not on GitHub yet (or you are not on the main branch). Commit and push first.');
  }
}

/**
 * Run the app's own key scan. Throws if it finds a key (shows file:line only) or if it did
 * not really run: the scan must print a JSON report, silence is treated as a failure.
 */
export async function secretScan(run, appDir) {
  const script = path.join(appDir, 'scripts', 'secret-scan.mjs');
  if (!existsSync(script)) {
    throw new ProvisionError('This app has no scripts/secret-scan.mjs, so Shipyard can not check for leaked keys. Restore it from the template before deploying.');
  }
  const r = await run(process.execPath, [script, '--json'], { cwd: appDir });
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    // handled below
  }
  if (!report || typeof report.ok !== 'boolean') {
    throw new ProvisionError('The key check did not run properly (it printed no report), so nothing was deployed. Run "node scripts/secret-scan.mjs" inside the app folder to see why.', { reason: 'secret-scan' });
  }
  if (report.ok && r.code === 0) return;
  if (Array.isArray(report.findings) && report.findings.length > 0) {
    const lines = report.findings.slice(0, 10).map((f) => `  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.pattern}`).join('\n');
    throw new ProvisionError(
      `A key or password was found in your files, so nothing was deployed. Remove it (and change the key, it may be exposed), then try again.\n${lines}`,
      { reason: 'secret-scan', findings: report.findings.map(({ file, line, pattern }) => ({ file, line, pattern })) },
    );
  }
  throw new ProvisionError(`The key check could not run, so nothing was deployed. ${report.error ?? ''}`.trim(), { reason: 'secret-scan' });
}

/**
 * Open the public address and look at what comes back.
 * -> { ok, status, reason?: 'protected' | 'status' | 'unreachable' }
 */
export async function checkSite(url, { fetch: doFetch = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 5, delayMs = 3000 } = {}) {
  let last = { ok: false, status: 0, reason: 'unreachable' };
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await doFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'shipyard-deploy-check' } });
      const text = (await res.text()).slice(0, 200_000);
      if (res.status === 401 || res.status === 403 || LOGIN_PAGE.test(String(res.url ?? '')) || (res.status !== 200 && LOGIN_PAGE.test(text))) {
        return { ok: false, status: res.status, reason: 'protected' };
      }
      if (res.status === 200 && !LOGIN_PAGE.test(text.slice(0, 5000))) return { ok: true, status: 200 };
      last = res.status === 200 ? { ok: false, status: 200, reason: 'protected' } : { ok: false, status: res.status, reason: 'status' };
      if (last.reason === 'protected') return last;
    } catch {
      last = { ok: false, status: 0, reason: 'unreachable' };
    }
    if (attempt < tries) await sleep(delayMs);
  }
  return last;
}

const MANUAL_PROTECTION = 'In the Vercel dashboard open the project > Settings > Deployment Protection, turn "Vercel Authentication" off and save. Then run deploy.mjs again.';

/**
 * opts: { appDir }
 * deps: { run, vercel, fetch, sleep, profile, setAuthUrls } (all optional, for tests)
 */
export async function deploy(opts, deps = {}) {
  const { appDir } = opts;
  const run = deps.run ?? realRun;
  const vercel = deps.vercel ?? realVercel;
  const profileApi = deps.profile ?? realProfile;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const setAuthUrls = deps.setAuthUrls ?? ((o) => setAuthUrlsForApp(o, deps.supabase ?? {}));
  const total = 5;

  const config = await readAppConfig(appDir);
  const slug = config.slug;
  const profile = await profileApi.loadProfile();
  const scope = profile.accounts?.vercel?.scope || undefined;
  const project = config.vercelProject || (profile.apps ?? []).find((a) => a.slug === slug)?.vercelProject;
  if (!project) {
    throw new ProvisionError('This app has no Vercel project yet. Run provision-vercel.mjs on the app folder first.');
  }

  log.step(1, total, 'Checking everything is saved to GitHub');
  await checkSavedAndPushed(run, appDir);
  log.ok('Your files match what is on GitHub.');

  log.step(2, total, 'Checking your files for leaked keys');
  await secretScan(run, appDir);
  log.ok('No keys found in your files.');

  const publish = async () => {
    const d = await vercel.deployProd({ cwd: appDir, scope, run });
    if (!d.ok) throw new ProvisionError(`Vercel could not deploy. ${d.error}`);
    return d;
  };

  log.step(3, total, 'Deploying to Vercel (this takes a minute or two)');
  let deployment = await publish();
  log.ok('Deployed.');

  // Which address do visitors use? Prefer the short production address.
  const recorded = config.siteUrl || `https://${project}.vercel.app`;
  const pickCandidates = (d) => {
    const list = [];
    const add = (url, kind) => {
      if (!url) return;
      const origin = originOf(url);
      if (!list.some((c) => c.url === origin)) list.push({ url: origin, kind });
    };
    add(d.aliasUrl, 'production');
    add(recorded, 'production');
    add(d.url, 'deployment');
    return list;
  };

  log.step(4, total, 'Checking the public site opens');
  const tryOpen = async (d) => {
    const attempts = [];
    for (const candidate of pickCandidates(d)) {
      const r = await checkSite(candidate.url, { fetch: deps.fetch, sleep, tries: deps.checkTries ?? 5, delayMs: deps.checkDelayMs ?? 3000 });
      attempts.push({ ...candidate, ...r });
      if (r.ok) return { chosen: { ...candidate, ...r }, attempts };
    }
    return { chosen: null, attempts };
  };
  let { chosen, attempts } = await tryOpen(deployment);
  if (!chosen) {
    const protectedOnes = attempts.filter((a) => a.reason === 'protected');
    const lines = attempts.map((a) => `${a.url}: ${a.reason === 'protected' ? 'asks visitors to log in to Vercel' : a.status ? `answered ${a.status}` : 'did not answer'}`).join('\n  ');
    await updateAppConfig(appDir, { lastDeployUrl: deployment.url });
    throw new ProvisionError(
      protectedOnes.length > 0
        ? `The app is deployed, but visitors are asked to log in to Vercel.\n  ${lines}\n${MANUAL_PROTECTION}`
        : `The app is deployed, but the public address did not open correctly.\n  ${lines}\nWait a minute and run deploy.mjs again; if it keeps failing, open the Vercel dashboard > Deployments and read the build log.`,
      { deploymentUrl: deployment.url, attempts: attempts.map(({ url, status, reason }) => ({ url, status, reason })), reason: protectedOnes.length > 0 ? 'protected' : 'unreachable' },
    );
  }
  log.ok(`${chosen.url} opens (HTTP ${chosen.status}).`);

  // NEXT_PUBLIC_SITE_URL is baked into the build. If Vercel's address differs from the guess, fix it and build once more.
  const warnings = [];
  const guessed = originOf(recorded);
  if (chosen.kind === 'production' && chosen.url !== guessed) {
    log.info(`The real address is ${chosen.url}, not ${guessed}. Updating the setting and deploying once more...`);
    const set = await vercel.envAdd({ cwd: appDir, name: SITE_URL_NAME, value: chosen.url, target: ['production'], scope, run });
    if (!set.ok) {
      warnings.push(`Could not update ${SITE_URL_NAME} on Vercel (${set.error}). Some links may point to ${guessed}.`);
      log.warn(warnings.at(-1));
    } else {
      deployment = await publish();
      const again = await tryOpen(deployment);
      if (again.chosen) chosen = again.chosen;
      else {
        warnings.push('The second deploy did not open yet. Check the site in a minute.');
        log.warn(warnings.at(-1));
      }
    }
  } else if (chosen.kind !== 'production') {
    warnings.push('Vercel did not tell us the short address, so the long deployment address is saved. Links inside the app may use a different address until you run deploy.mjs again.');
    log.warn(warnings.at(-1));
  }

  const finalUrl = chosen.url;
  await updateAppConfig(appDir, { url: finalUrl, siteUrl: finalUrl, lastDeployUrl: deployment.url });
  await profileApi.upsertApp({ slug, url: finalUrl, status: 'live', step: 'deployed' });

  log.step(5, total, 'Telling Supabase the real address (so sign-in works)');
  let authUrls;
  try {
    const r = await setAuthUrls({ appDir, url: finalUrl });
    authUrls = { ok: true, changed: r.changed };
    log.ok(r.changed ? 'Sign-in addresses updated.' : 'Sign-in addresses were already up to date.');
  } catch (err) {
    authUrls = { ok: false, error: err.message };
    log.fail(`The site is live, but sign-in will not work until the address is added in Supabase. ${err.message}`);
    log.info(`Fix it, then run: node provision-supabase.mjs <app-folder> --url ${finalUrl}`);
  }

  return {
    ok: authUrls.ok,
    url: finalUrl,
    deploymentUrl: deployment.url,
    status: chosen.status,
    authUrls,
    warnings,
    ...(authUrls.ok ? {} : { error: `The site is live at ${finalUrl}, but the sign-in addresses in Supabase were not updated: ${authUrls.error}` }),
  };
}
