// ops-setup: put the health check, code review, auto-merge and Dependabot files into an app, and set up the
// GitHub and Vercel side (labels, the SITE_URL variable, the CRON_SECRET password, repository settings).
// Safe to run again. Nothing here prints a secret; the generated CRON_SECRET only travels through stdin.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run as realRun } from '../lib/run.mjs';
import * as realVercel from '../lib/vercel.mjs';
import * as realProfile from '../lib/profile.mjs';
import * as log from '../lib/log.mjs';
import { readAppConfig } from '../provision/common.mjs';
import { appUrlOf } from '../launch/common.mjs';
import { planAddModule, applyAddModule } from '../modules/core.mjs';
import {
  PARTS, PART_NAMES, readTemplate, installFile, appRepo, makeGh, recordOps, opsSummary,
} from './common.mjs';
import { reviewHint } from '../lib/agent.mjs';

export const SECRET_NAME = 'CRON_SECRET';
export const VARIABLE_NAME = 'SITE_URL';
export const RULESET_NAME = 'Shipyard: tests must pass before merging';

export const LABELS = {
  'ops-alert': { color: 'D93F0B', description: 'Opened by the scheduled health check' },
  'needs-review': { color: 'FBCA04', description: 'A person must look at this before it merges' },
  automerge: { color: '0E8A16', description: 'Merge this by itself once the tests pass (if it is small and low-risk)' },
};

/** The name GitHub gives the test job's check, read from the app's test workflow (job name, else job id). */
export function testCheckName(workflowText) {
  const lines = String(workflowText ?? '').split(/\r?\n/);
  const jobs = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobs === -1) return 'test';
  for (let i = jobs + 1; i < lines.length; i++) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (!id) continue;
    for (let j = i + 1; j < lines.length && !/^ {2}\S/.test(lines[j]); j++) {
      const name = /^ {4}name:\s*(.+?)\s*$/.exec(lines[j]);
      if (name && !name[1].includes('${{')) return name[1].replace(/^["']|["']$/g, '');
    }
    return id[1];
  }
  return 'test';
}

/** Parse "--only health,review" style values. Returns the part names in a fixed order, or throws a usage error. */
export function parseOnly(values) {
  const list = (values ?? []).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
  if (list.length === 0) return [...PART_NAMES];
  const unknown = list.filter((n) => !PART_NAMES.includes(n));
  if (unknown.length > 0) throw new log.UsageError(`--only knows ${PART_NAMES.join(', ')}. "${unknown[0]}" is not one of them.`);
  return PART_NAMES.filter((n) => list.includes(n));
}

/**
 * opts: { appDir, only: [part], forceFiles: [rel], applySettings, rotateSecret }
 * deps: { run, vercel, profile, modulesDir, randomSecret }
 */
export async function opsSetup(opts, deps = {}) {
  const { appDir } = opts;
  const run = deps.run ?? realRun;
  const vercel = deps.vercel ?? realVercel;
  const profileApi = deps.profile ?? realProfile;
  const parts = opts.only?.length ? opts.only : [...PART_NAMES];
  const force = new Set((opts.forceFiles ?? []).map((f) => f.replace(/\\/g, '/')));
  const allFiles = new Set(parts.flatMap((p) => PARTS[p]));
  for (const f of force) {
    if (!allFiles.has(f)) throw new log.UsageError(`--force-file ${f}: ops setup only writes ${[...allFiles].join(', ')}.`);
  }

  const config = await readAppConfig(appDir);
  const slug = config.slug;
  const profile = await profileApi.loadProfile();
  const profileApp = (profile.apps ?? []).find((a) => a.slug === slug) ?? null;
  const scope = profile.accounts?.vercel?.scope || undefined;
  const siteUrl = appUrlOf(config, profileApp);

  const result = {
    ok: true, complete: true, slug, parts, errorsModule: null, files: [], github: null, repository: null,
    labels: [], variable: null, cronSecret: null, settings: null, pending: [], problems: [], next: [],
  };
  const problem = (msg) => {
    result.problems.push(msg);
    log.fail(msg);
  };
  const pending = (msg) => {
    result.pending.push(msg);
    log.warn(msg);
  };

  const wantsGithub = parts.includes('health') || parts.includes('automerge');
  const repo = await appRepo(run, appDir);
  result.repository = repo.slug;
  let step = 0;
  const total = 2 + (parts.includes('health') ? 1 : 0) + (wantsGithub ? 2 : 0) + (parts.includes('automerge') ? 1 : 0);

  // 1. The errors module: the health check reads its /api/ops/summary page.
  let healthBlocked = false;
  if (parts.includes('health')) {
    log.step(++step, total, 'Checking the error log module (the health check reads it)');
    const plan = await planAddModule({ appDir, name: 'errors' }, { modulesDir: deps.modulesDir });
    if (plan.alreadyAdded) {
      result.errorsModule = { status: 'present' };
      log.ok('The error log module is already in the app.');
    } else if (plan.blockers.length > 0) {
      healthBlocked = true;
      result.errorsModule = { status: 'blocked', blockers: plan.blockers };
      for (const b of plan.blockers) problem(b);
      log.warn('The health check was skipped, because it needs the error log module. The other parts continue.');
    } else {
      await applyAddModule(plan, { profile: profileApi });
      result.errorsModule = { status: 'added', files: plan.files.create.length, migrations: plan.migrations.map((m) => m.to) };
      log.ok(`Added the error log module (${plan.files.create.length} files). Its admin page is /admin/logs.`);
      if (plan.migrations.some((m) => m.status === 'create')) {
        result.next.push(`Create the error_log table in your database: node provision-supabase.mjs ${appDir}  (then deploy). Error emails also need ADMIN_EMAIL and RESEND_API_KEY; without them problems are logged but not mailed.`);
      }
    }
  }

  // 2. The files.
  log.step(++step, total, 'Writing the files into your app');
  const recorded = (await readAppConfig(appDir)).ops?.files ?? {};
  const hashes = {};
  for (const part of parts) {
    if (part === 'health' && healthBlocked) continue;
    for (const rel of PARTS[part]) {
      const wanted = await readTemplate(rel);
      const r = await installFile({ appDir, rel, wanted, recorded: recorded[rel], force: force.has(rel) });
      result.files.push({ path: r.path, status: r.status, ...(r.diff ? { diff: r.diff } : {}), ...(r.reason ? { reason: r.reason } : {}) });
      if (r.hash) hashes[rel] = r.hash;
      if (r.status === 'created') log.ok(`Created ${rel}`);
      else if (r.status === 'updated') log.ok(`Updated ${rel} to the newest Shipyard version (you had not changed it).`);
      else if (r.status === 'replaced') log.ok(`Replaced ${rel} with the Shipyard version.`);
      else if (r.status === 'unchanged') log.ok(`${rel} is already up to date.`);
      else if (r.status === 'refused') problem(r.reason);
      else {
        log.warn(`${rel} was changed by you, so it was left as it is. Lines that differ (- yours, + Shipyard's version):`);
        for (const d of r.diff.lines) log.info(`  ${d.type} ${String(d.line).padStart(3)}  ${d.text}`);
        if (r.diff.more > 0) log.info(`  ... and ${r.diff.more} more`);
        log.info(`  To use the Shipyard version instead: add  --force-file ${rel}`);
      }
    }
  }
  await recordOps(appDir, { setupAt: new Date().toISOString(), files: hashes }, { profile: profileApi });

  // 3. GitHub and Vercel.
  let gh = null;
  if (wantsGithub) {
    log.step(++step, total, 'Checking GitHub');
    if (!repo.slug) {
      pending(`${repo.reason} Save the app to GitHub first, then run this again to finish the GitHub part.`);
    } else {
      gh = makeGh(run, { cwd: appDir, repo: repo.slug });
      const auth = await gh.text(['auth', 'status']);
      if (!auth.ok) {
        pending(auth.missing || auth.notLoggedIn ? auth.error : `Could not talk to GitHub (${auth.error}). Run: gh auth login`);
        gh = null;
      } else {
        log.ok(`Using GitHub repository ${repo.slug}.`);
      }
    }
  }

  if (gh) {
    log.step(++step, total, 'Labels, the site address and the private password');
    const wantedLabels = [
      ...(parts.includes('health') ? ['ops-alert'] : []),
      ...(parts.includes('automerge') ? ['needs-review', 'automerge'] : []),
    ];
    for (const name of wantedLabels) {
      const l = LABELS[name];
      const r = await gh.text(['label', 'create', name, '--repo', repo.slug, '--color', l.color, '--description', l.description, '--force']);
      if (r.ok) {
        result.labels.push(name);
        log.ok(`Label "${name}" is ready.`);
      } else pending(`Could not make the label "${name}": ${r.error}`);
    }

    if (parts.includes('health') && !healthBlocked) {
      const info = await gh.json(['api', `repos/${repo.slug}`]);
      if (info.ok && info.data?.has_issues === false) {
        pending('Issues are switched off for this GitHub repository, so the health check can not open alerts. Turn them on: GitHub > Settings > General > Features > Issues.');
      }
      // The address the checker visits.
      if (!siteUrl) {
        result.variable = { name: VARIABLE_NAME, status: 'missing' };
        pending('The app has no live address yet, so the SITE_URL variable was not set. Deploy first (deploy.mjs), then run this again.');
      } else {
        const current = await gh.text(['variable', 'get', VARIABLE_NAME, '--repo', repo.slug]);
        if (current.ok && current.out.trim() === siteUrl) {
          result.variable = { name: VARIABLE_NAME, status: 'unchanged', value: siteUrl };
          log.ok(`${VARIABLE_NAME} is already ${siteUrl}.`);
        } else {
          const set = await gh.text(['variable', 'set', VARIABLE_NAME, '--repo', repo.slug, '--body', siteUrl]);
          if (set.ok) {
            result.variable = { name: VARIABLE_NAME, status: current.ok ? 'updated' : 'created', value: siteUrl };
            log.ok(`${VARIABLE_NAME} is set to ${siteUrl}.`);
          } else problem(`Could not set the ${VARIABLE_NAME} variable on GitHub: ${set.error}`);
        }
      }
      await cronSecret({ opts, deps, vercel, run, gh, repo, appDir, scope, result, problem, profileApi });
    }

    if (parts.includes('automerge')) {
      log.step(++step, total, 'Repository settings for auto-merge');
      let checkName = 'test';
      try {
        checkName = testCheckName(await readFile(path.join(appDir, '.github', 'workflows', 'test.yml'), 'utf8'));
      } catch {
        pending('The app has no .github/workflows/test.yml, so the name of the test check is guessed ("test").');
      }
      result.settings = await repoSettings({ gh, repo: repo.slug, checkName, apply: Boolean(opts.applySettings), problem });
      reportSettings(result.settings, Boolean(opts.applySettings), pending);
    }
  }

  // 4. What to do next.
  if (parts.includes('review')) {
    result.next.push(`Code review: install the CodeRabbit GitHub App on this repository: https://github.com/apps/coderabbitai . It is free for public repositories; private ones need a paid plan or the 14-day trial. Free alternative: ${reviewHint()}. Until the app is installed, .coderabbit.yaml does nothing.`);
  }
  const wroteNew = result.files.some((f) => ['created', 'updated', 'replaced'].includes(f.status));
  if (wroteNew) {
    result.next.push('The new files are in your app folder but not on GitHub yet. Save them on a new branch and open a pull request, then merge it once the Tests check is green. The health check starts running once it is on the main branch. If GitHub refuses the push because of "workflow" permission, run: gh auth refresh -h github.com -s workflow');
  }
  if (result.cronSecret?.status === 'set' || result.cronSecret?.status === 'rotated') {
    result.next.push('CRON_SECRET is new on Vercel. It only reaches your live app with the next deploy, so run deploy.mjs. Until then the health check reports "the page is closed".');
  }

  result.ok = result.problems.length === 0;
  result.complete = result.ok && result.pending.length === 0;
  await recordOps(appDir, {}, { profile: profileApi }); // refreshes the short summary for the settings page
  result.summary = opsSummary((await readAppConfig(appDir)).ops);
  return result;
}

// ---------------------------------------------------------------------------------------------
// CRON_SECRET: made here, sent to Vercel and GitHub through stdin, never printed or stored

async function cronSecret({ opts, deps, vercel, run, gh, repo, appDir, scope, result, problem, profileApi }) {
  const config = await readAppConfig(appDir);
  const [onVercel, onGithub] = await Promise.all([
    vercel.envLs({ cwd: appDir, scope, run }),
    gh.json(['secret', 'list', '--repo', repo.slug, '--app', 'actions', '--json', 'name']),
  ]);
  const vercelHas = onVercel.ok && onVercel.envs.some((e) => e.name === SECRET_NAME && e.targets.includes('production'));
  const githubHas = onGithub.ok && Array.isArray(onGithub.data) && onGithub.data.some((s) => s.name === SECRET_NAME);
  const known = typeof config.ops?.cronSecretAt === 'string';

  if (vercelHas && githubHas && known && !opts.rotateSecret) {
    result.cronSecret = { status: 'kept' };
    log.ok(`${SECRET_NAME} is already on Vercel and GitHub. Left as it is (add --rotate-secret to make a new one).`);
    return;
  }

  const value = (deps.randomSecret ?? (() => randomBytes(32).toString('hex')))();
  const v = await vercel.envAdd({ cwd: appDir, name: SECRET_NAME, value, target: ['production'], scope, run });
  if (!v.ok) {
    problem(`Could not send ${SECRET_NAME} to Vercel: ${v.error} Is the app linked to Vercel (provision-vercel.mjs)?`);
    result.cronSecret = { status: 'failed', where: 'vercel' };
    return;
  }
  const g = await gh.text(['secret', 'set', SECRET_NAME, '--repo', repo.slug, '--app', 'actions'], { input: value });
  if (!g.ok) {
    problem(`${SECRET_NAME} is on Vercel but GitHub did not accept it: ${g.error} Run this again: the password is replaced on both sides.`);
    result.cronSecret = { status: 'failed', where: 'github' };
    return;
  }
  await recordOps(appDir, { cronSecretAt: new Date().toISOString() }, { profile: profileApi });
  const rotated = vercelHas || githubHas;
  result.cronSecret = { status: rotated ? 'rotated' : 'set' };
  log.ok(`${SECRET_NAME} was ${rotated ? 'replaced' : 'made'} and sent to Vercel and GitHub (not shown, not saved anywhere else).`);
}

// ---------------------------------------------------------------------------------------------
// Repository settings: look first, change only when the student said yes (--apply-settings)

async function branchProtected(gh, repo, branch) {
  const ref = encodeURIComponent(branch);
  const b = await gh.json(['api', `repos/${repo}/branches/${ref}`]);
  const req = b.ok ? b.data?.protection?.required_status_checks : null;
  if (req && req.enforcement_level !== 'off' && ((req.contexts?.length ?? 0) > 0 || (req.checks?.length ?? 0) > 0)) return true;
  const rules = await gh.json(['api', `repos/${repo}/rules/branches/${ref}`]);
  return rules.ok && Array.isArray(rules.data) && rules.data.some((r) => r?.type === 'required_status_checks');
}

/** The id of the GitHub Actions app on GitHub. A required check pinned to it can only come from a workflow. */
export const GITHUB_ACTIONS_APP_ID = 15368;

export async function repoSettings({ gh, repo, checkName, apply, problem }) {
  const info = await gh.json(['api', `repos/${repo}`]);
  if (!info.ok) {
    return { checked: false, error: info.error, proposals: [], applied: [] };
  }
  const data = info.data ?? {};
  const branch = data.default_branch || 'main';
  const enforced = await branchProtected(gh, repo, branch);
  const state = {
    checked: true,
    visibility: data.private ? 'private' : 'public',
    branch,
    checkName,
    allowAutoMerge: data.allow_auto_merge === true,
    deleteBranchOnMerge: data.delete_branch_on_merge === true,
    checksRequired: enforced,
    proposals: [],
    applied: [],
    failed: [],
  };
  if (!state.allowAutoMerge) state.proposals.push({ id: 'allow_auto_merge', say: 'Turn on "Allow auto-merge" (so a pull request can merge itself once the tests pass).' });
  if (!state.deleteBranchOnMerge) state.proposals.push({ id: 'delete_branch_on_merge', say: 'Turn on "Automatically delete head branches" (tidies up after each merge).' });
  if (!enforced) {
    state.proposals.push({
      id: 'require_checks',
      say: `Make GitHub wait for the "${checkName}" check before anything merges into ${branch}. That also means nothing can be pushed straight to ${branch}: changes go through a pull request.`,
    });
  }
  if (!apply || state.proposals.length === 0) return state;

  const patch = state.proposals.filter((p) => p.id !== 'require_checks').map((p) => `${p.id}=true`);
  if (patch.length > 0) {
    const r = await gh.text(['api', '-X', 'PATCH', `repos/${repo}`, ...patch.flatMap((f) => ['-F', f])]);
    if (r.ok) state.applied.push(...state.proposals.filter((p) => p.id !== 'require_checks').map((p) => p.id));
    else {
      state.failed.push({ id: 'repo_settings', error: r.error });
      problem(`Could not change the repository settings: ${r.error} (you need to be the owner or an admin of ${repo}).`);
    }
  }
  if (!enforced) {
    const existing = await gh.json(['api', `repos/${repo}/rulesets`]);
    const already = existing.ok && Array.isArray(existing.data) && existing.data.some((x) => x?.name === RULESET_NAME);
    if (already) state.applied.push('require_checks');
    else {
      const body = {
        name: RULESET_NAME,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            // 15368 = the GitHub Actions app. Only a check run by Actions counts, so a check with the same name from
            // anywhere else can not satisfy the rule.
            required_status_checks: [{ context: checkName, integration_id: GITHUB_ACTIONS_APP_ID }],
          },
        }],
      };
      const r = await gh.text(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], { input: JSON.stringify(body) });
      if (r.ok) state.applied.push('require_checks');
      else {
        const planLimit = /upgrade to github|HTTP 403|HTTP 404/i.test(r.error);
        state.failed.push({ id: 'require_checks', error: r.error, planLimit });
        if (!planLimit) problem(`Could not make GitHub wait for the tests: ${r.error}`);
      }
    }
  }
  return state;
}

function reportSettings(s, applied, pending) {
  if (!s.checked) {
    pending(`Could not read the repository settings (${s.error}).`);
    return;
  }
  log.info(`Repository ${s.visibility}, main branch "${s.branch}". Auto-merge allowed: ${s.allowAutoMerge ? 'yes' : 'no'}. Branches deleted after merge: ${s.deleteBranchOnMerge ? 'yes' : 'no'}. Tests required before merging: ${s.checksRequired ? 'yes' : 'no'}.`);
  if (s.proposals.length === 0) {
    log.ok('The repository settings are already right for auto-merge.');
    return;
  }
  if (!applied) {
    pending('These GitHub settings are still off, so auto-merge can not work yet. If you want them on, say yes and run this again with --apply-settings:');
    for (const p of s.proposals) log.info(`  - ${p.say}`);
    return;
  }
  for (const id of s.applied) log.ok(`Done: ${s.proposals.find((p) => p.id === id)?.say ?? id}`);
  for (const f of s.failed) {
    if (f.planLimit) {
      pending(`GitHub would not make the tests mandatory (${f.error}). On a private repository this needs a paid GitHub plan, or make the repository public. Until then auto-merge stays off: the robot explains and you merge by hand when the Tests check is green.`);
    }
  }
}
