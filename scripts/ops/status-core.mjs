// ops-status: what is set up for an app, and is it working? Reads only. Names of secrets, never values.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { run as realRun } from '../lib/run.mjs';
import * as realVercel from '../lib/vercel.mjs';
import * as realProfile from '../lib/profile.mjs';
import { HOME_DIR } from '../lib/paths.mjs';
import * as log from '../lib/log.mjs';
import { readAppConfig } from '../provision/common.mjs';
import { appUrlOf } from '../launch/common.mjs';
import { appRepo, makeGh, latestBackup, PARTS } from './common.mjs';
import { SECRET_NAME, VARIABLE_NAME } from './setup-core.mjs';
import { reviewHint } from '../lib/agent.mjs';

const exists = (file) => stat(file).then((s) => s.isFile(), () => false);
const STALE_BACKUP_DAYS = 30;

/** "2026-10-16 14:03 UTC" from an ISO time, or '' */
export function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Item statuses: ok (works), fail (set up but broken), warn (set up but something is off or could not be checked),
 * off (not set up).
 */
export async function opsStatus({ appDir }, deps = {}) {
  const run = deps.run ?? realRun;
  const vercel = deps.vercel ?? realVercel;
  const profileApi = deps.profile ?? realProfile;
  const homeDir = deps.homeDir ?? HOME_DIR;
  const now = deps.now ? deps.now() : new Date();

  const config = await readAppConfig(appDir);
  const profile = await profileApi.loadProfile();
  const profileApp = (profile.apps ?? []).find((a) => a.slug === config.slug) ?? null;
  const scope = profile.accounts?.vercel?.scope || undefined;
  const siteUrl = appUrlOf(config, profileApp);
  const items = [];
  const add = (id, label, status, detail, next) => items.push({ id, label, status, detail, ...(next ? { next } : {}) });

  const has = {};
  for (const rel of Object.values(PARTS).flat()) has[rel] = await exists(path.join(appDir, ...rel.split('/')));
  const repo = await appRepo(run, appDir);
  const gh = repo.slug ? makeGh(run, { cwd: appDir, repo: repo.slug }) : null;
  const ghDown = !gh ? repo.reason : null;

  // Repository facts (one call each, shared by several items).
  let repoInfo = null;
  let checksRequired = null;
  if (gh) {
    const info = await gh.json(['api', `repos/${repo.slug}`]);
    if (info.ok) {
      repoInfo = info.data ?? {};
      const branch = encodeURIComponent(repoInfo.default_branch || 'main');
      const b = await gh.json(['api', `repos/${repo.slug}/branches/${branch}`]);
      const req = b.ok ? b.data?.protection?.required_status_checks : null;
      checksRequired = Boolean(req && req.enforcement_level !== 'off' && ((req.contexts?.length ?? 0) > 0 || (req.checks?.length ?? 0) > 0));
      if (!checksRequired) {
        const rules = await gh.json(['api', `repos/${repo.slug}/rules/branches/${branch}`]);
        checksRequired = rules.ok && Array.isArray(rules.data) && rules.data.some((r) => r?.type === 'required_status_checks');
      }
    }
  }

  // 1. Error log module
  const modules = Array.isArray(config.modules) ? config.modules : [];
  if (modules.includes('errors')) add('errors', 'Error log and alerts', 'ok', 'The error log module is in the app (admin page: /admin/logs).');
  else add('errors', 'Error log and alerts', 'off', 'Not added.', `node ops-setup.mjs ${appDir} --only health  (adds the error log module and the health check)`);

  // 2. Health workflow
  const healthFile = '.github/workflows/health.yml';
  if (!has[healthFile]) {
    add('health', 'Health checks', 'off', 'Not set up.', `node ops-setup.mjs ${appDir} --only health`);
  } else if (!gh) {
    add('health', 'Health checks', 'warn', `The workflow file is there, but GitHub could not be checked: ${ghDown}`);
  } else {
    const runs = await gh.json(['run', 'list', '--repo', repo.slug, '--workflow', 'health.yml', '-L', '1', '--json', 'status,conclusion,createdAt,url']);
    const alerts = await gh.json(['issue', 'list', '--repo', repo.slug, '--label', 'ops-alert', '--state', 'open', '--json', 'number,url']);
    const last = runs.ok && Array.isArray(runs.data) ? runs.data[0] : null;
    const open = alerts.ok && Array.isArray(alerts.data) ? alerts.data : [];
    if (!runs.ok) add('health', 'Health checks', 'warn', `The workflow file is there, but its runs could not be read: ${runs.error}`);
    else if (!last) add('health', 'Health checks', 'warn', 'It has not run yet. Merge the workflow to the main branch, then start it once: GitHub > Actions > Health check > Run workflow.');
    else if (open.length > 0) add('health', 'Health checks', 'fail', `${open.length} open alert${open.length === 1 ? '' : 's'} (issue${open.length === 1 ? '' : 's'} labelled ops-alert: ${open.map((i) => `#${i.number}`).join(', ')}). Last run ${when(last.createdAt)}.`);
    else if (last.status && last.status !== 'completed') add('health', 'Health checks', 'ok', `Running now (started ${when(last.createdAt)}).`);
    else if (last.conclusion === 'success') add('health', 'Health checks', 'ok', `Last run ${when(last.createdAt)}: all fine.`);
    else add('health', 'Health checks', 'fail', `The last run (${when(last.createdAt)}) ended with "${last.conclusion || 'unknown'}". Open it: ${last.url ?? 'GitHub > Actions'}`);
  }

  // 3. The password and the address the health check uses
  if (!has[healthFile]) {
    add('cron-secret', 'Health check password', 'off', 'Not needed until the health check is set up.');
    add('site-url', 'Health check address', 'off', 'Not needed until the health check is set up.');
  } else {
    const [onVercel, onGithub, variable] = await Promise.all([
      vercel.envLs({ cwd: appDir, scope, run }),
      gh ? gh.json(['secret', 'list', '--repo', repo.slug, '--app', 'actions', '--json', 'name']) : { ok: false, error: ghDown },
      gh ? gh.text(['variable', 'get', VARIABLE_NAME, '--repo', repo.slug]) : { ok: false, error: ghDown },
    ]);
    const vercelHas = onVercel.ok ? onVercel.envs.some((e) => e.name === SECRET_NAME && e.targets.includes('production')) : null;
    const githubHas = onGithub.ok && Array.isArray(onGithub.data) ? onGithub.data.some((s) => s.name === SECRET_NAME) : null;
    if (vercelHas === null || githubHas === null) {
      const why = [vercelHas === null ? `Vercel: ${onVercel.error}` : '', githubHas === null ? `GitHub: ${onGithub.error}` : ''].filter(Boolean).join(' ');
      add('cron-secret', 'Health check password', 'warn', `Could not check (${why}).`);
    } else if (vercelHas && githubHas) {
      add('cron-secret', 'Health check password', 'ok', `${SECRET_NAME} is set on Vercel and on GitHub (the values are not shown).`);
    } else {
      const missing = [!vercelHas ? 'Vercel' : '', !githubHas ? 'GitHub' : ''].filter(Boolean).join(' and ');
      add('cron-secret', 'Health check password', 'fail', `${SECRET_NAME} is missing on ${missing}.`, `node ops-setup.mjs ${appDir} --only health`);
    }
    const variableMissing = !variable.ok && gh && (variable.status === 404 || /not found|could not find/i.test(variable.error ?? ''));
    if (!variable.ok && !variableMissing) add('site-url', 'Health check address', 'warn', `Could not check (${variable.error}).`);
    else if (variableMissing) add('site-url', 'Health check address', 'fail', `The ${VARIABLE_NAME} variable is not set on GitHub.`, `node ops-setup.mjs ${appDir} --only health`);
    else if (siteUrl && variable.out.trim() !== siteUrl) add('site-url', 'Health check address', 'warn', `${VARIABLE_NAME} is ${variable.out.trim()}, but the app's address is ${siteUrl}.`, `node ops-setup.mjs ${appDir} --only health`);
    else add('site-url', 'Health check address', 'ok', `${VARIABLE_NAME} is ${variable.out.trim()}.`);
  }

  // 4. Code review
  if (has['.coderabbit.yaml']) add('review', 'Code review', 'ok', 'The CodeRabbit settings file is there. (Whether the CodeRabbit GitHub App is installed can only be seen on GitHub: github.com/apps/coderabbitai.)');
  else add('review', 'Code review', 'off', `Not set up. Free alternative: ${reviewHint()}.`, `node ops-setup.mjs ${appDir} --only review`);

  // 5. Auto-merge
  const autoFiles = PARTS.automerge;
  if (!autoFiles.every((f) => has[f])) {
    add('automerge', 'Auto-merge of small safe changes', has[autoFiles[0]] ? 'warn' : 'off', has[autoFiles[0]] ? 'The workflow is there but its rules file (.github/ops/automerge-check.mjs) is missing.' : 'Not set up.', `node ops-setup.mjs ${appDir} --only automerge`);
  } else if (!gh || !repoInfo) {
    add('automerge', 'Auto-merge of small safe changes', 'warn', `The files are there, but GitHub could not be checked: ${ghDown ?? 'the repository could not be read'}.`);
  } else {
    const problems = [];
    if (repoInfo.allow_auto_merge !== true) problems.push('"Allow auto-merge" is off in the repository settings');
    if (!checksRequired) problems.push(`GitHub does not wait for the tests before merging${repoInfo.private ? ' (on a private repository this needs a paid GitHub plan, or make the repository public)' : ''}`);
    if (problems.length > 0) add('automerge', 'Auto-merge of small safe changes', 'warn', `Set up, but it will not merge anything yet: ${problems.join('; ')}.`, `node ops-setup.mjs ${appDir} --only automerge --apply-settings  (after asking the student)`);
    else add('automerge', 'Auto-merge of small safe changes', 'ok', `On. The main branch waits for the tests (${repoInfo.visibility ?? (repoInfo.private ? 'private' : 'public')} repository).`);
  }

  // 6. Dependabot
  if (has['.github/dependabot.yml']) add('deps', 'Package updates (Dependabot)', 'ok', 'Update pull requests are set up (.github/dependabot.yml is there).');
  else add('deps', 'Package updates (Dependabot)', 'off', 'Not set up.', `node ops-setup.mjs ${appDir} --only deps`);

  // 7. Backups
  const backup = await latestBackup(homeDir, config.slug);
  if (!backup) add('backup', 'Backups', 'off', 'No backup yet. Supabase Pro has automatic daily backups; the free plan does not.', `node backup-export.mjs ${appDir}`);
  else {
    const days = Math.floor((now.getTime() - new Date(backup.at).getTime()) / 86_400_000);
    if (days > STALE_BACKUP_DAYS) add('backup', 'Backups', 'warn', `Last backup ${when(backup.at)} (${days} days ago).`, `node backup-export.mjs ${appDir}`);
    else add('backup', 'Backups', 'ok', `Last backup ${when(backup.at)}.`);
  }

  return {
    ok: !items.some((i) => i.status === 'fail'),
    app: config.slug,
    repository: repo.slug,
    visibility: repoInfo ? (repoInfo.private ? 'private' : 'public') : null,
    items,
  };
}

/** Print the items as ✓ / ✗ / ! lines. */
export function printStatus(result) {
  for (const i of result.items) {
    const line = `${i.label}: ${i.detail}`;
    if (i.status === 'ok') log.ok(line);
    else if (i.status === 'fail') log.fail(line);
    else log.warn(i.status === 'off' ? `${i.label}: ${i.detail}` : line);
    if (i.next && i.status !== 'ok') log.info(`  Fix: ${i.next}`);
  }
}
