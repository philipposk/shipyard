#!/usr/bin/env node
// Add an optional feature (a "module") to an app made with Shipyard: payments, an email list, and so on.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { planAddModule, applyAddModule, publicPlan, listModules, loadModule, MODULES_DIR } from './modules/core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Add a feature to an app made with Shipyard.

Usage:
  node add-module.mjs <app-folder> <module> [--dry-run] [--force-file <path>] [--json]
  node add-module.mjs --list

Modules:
  billing     Payments with Stripe: pricing page, plans, subscriptions, a billing section in Settings.
  errors      An error log: crashed pages say sorry, you get an email, and an admin page shows what happened.
  newsletter  An email list: opt-in boxes, one-click unsubscribe, and a page where you write and send updates.

  --dry-run          show what would change and change nothing
  --force-file PATH  replace one existing file with the module's version (use only when you mean it; repeat for more)
  --list             show the modules you can add
  --json             print the result as JSON
  --help             show this text

Adding a module copies its files into the app, adds its database file to supabase/migrations (numbered to
fit), lists its tables in supabase/isolation.json so the privacy test covers them, and writes it down in
.shipyard-app.json. It never overwrites a file you changed: it stops and tells you which ones. Running it
twice is safe: the second run does nothing.
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

function sentence(parts) {
  return parts.filter(Boolean).join(', ');
}

export async function main(args, deps = {}) {
  if (args.list) {
    const modulesDir = deps.modulesDir ?? args['modules-dir'] ?? MODULES_DIR;
    const names = await listModules(modulesDir);
    const modules = [];
    for (const name of names) {
      const { manifest } = await loadModule(name, modulesDir);
      modules.push({ name, description: manifest.description });
      log.info(`${name}: ${manifest.description}`);
    }
    return { ok: true, modules };
  }
  if (args._.length !== 2) {
    throw new log.UsageError('Give the app folder and the module, for example: node add-module.mjs ./recipe-box billing  (see --list for the modules)');
  }
  const appDir = await resolveAppDir(args._[0]);
  const modulesDir = deps.modulesDir ?? args['modules-dir'] ?? MODULES_DIR;
  const plan = await planAddModule({ appDir, name: args._[1], forceFiles: args['force-file'] }, { modulesDir });

  if (plan.alreadyAdded) {
    log.ok(`The "${plan.module}" module is already in this app. Nothing changed.`);
    return { ...publicPlan(plan, { dryRun: args['dry-run'] }), changed: false };
  }

  const dry = Boolean(args['dry-run']);
  if (plan.blockers.length > 0) {
    for (const b of plan.blockers) log.fail(b);
    return { ...publicPlan(plan, { dryRun: dry }), error: plan.blockers[0], changed: false };
  }

  if (!dry) await applyAddModule(plan, deps);

  const verb = dry ? 'Would add' : 'Added';
  log.ok(`${dry ? 'Dry run for' : 'Module'} "${plan.module}": ${plan.description}`);
  const created = [...plan.files.create, ...plan.files.overwrite];
  if (created.length > 0) log.info(`${verb} ${created.length} file${created.length === 1 ? '' : 's'}${plan.files.same.length ? ` (${plan.files.same.length} already there)` : ''}.`);
  for (const f of plan.files.overwrite) log.warn(`${dry ? 'Would replace' : 'Replaced'} ${f} with the module's version.`);
  for (const mg of plan.migrations) {
    if (mg.status === 'create') log.info(`${verb} database file ${mg.to}`);
    else log.info(`Database file already in the app: ${mg.to}`);
  }
  if (plan.isolation.added.length > 0) log.info(`${verb} ${sentence(plan.isolation.added)} to supabase/isolation.json (the privacy test will cover ${plan.isolation.added.length === 1 ? 'it' : 'them'}).`);
  if (plan.nav.added.length > 0) log.info(`${verb} ${plan.nav.added.join(', ')} to the menu (src/lib/nav.ts).`);
  if (plan.proxy.added.length > 0) log.info(`${verb} ${plan.proxy.added.join(', ')} as pages visitors can open without signing in (src/proxy.ts).`);
  for (const p of plan.patches) {
    if (p.status === 'apply') log.info(`${dry ? 'Would edit' : 'Edited'} ${p.file}`);
  }
  if (plan.packages.added.length > 0) log.info(`${verb} to package.json: ${plan.packages.added.join(', ')}`);
  for (const k of plan.packages.kept) log.warn(`package.json already has ${k}; kept as it is.`);
  if (plan.env.generated.length > 0) log.info(`${dry ? 'Would make' : 'Made'} a private random value for ${plan.env.generated.join(', ')} in .env.local (not shown, not committed).`);
  for (const w of plan.warnings) log.warn(w);
  for (const m of plan.manual) log.warn(`Do this by hand: ${m}`);
  if (plan.next.length > 0) {
    log.info('Next:');
    plan.next.forEach((n, i) => log.info(`  ${i + 1}. ${n}`));
  }
  return { ...publicPlan(plan, { dryRun: dry }), changed: !dry };
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['modules-dir', 'force-file'], boolean: ['dry-run', 'list'], multiple: ['force-file'] },
    help: HELP,
    main,
  });
}
