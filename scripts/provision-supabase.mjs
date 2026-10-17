#!/usr/bin/env node
// Create the app's Supabase project, build its database and save its keys.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { provisionSupabase } from './provision/supabase-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Set up Supabase (the database and sign-in) for an app made with Shipyard.

Usage:
  node provision-supabase.mjs <app-folder> [--region <region>] [--json]
  node provision-supabase.mjs <app-folder> --shared <project-id> [--schema <name>] [--dry-run] [--json]
  node provision-supabase.mjs <app-folder> --url https://my-app.vercel.app

  --shared   put the app in an existing Supabase project, in its own schema (its own space).
             Safe for the other apps there: nothing of theirs is changed (see below)
  --schema   the app's space inside that project (default app_<app name>, for example app_recipe_box)
  --dry-run  with --shared: look at the project and show what would change, change nothing
  --region   where a new project's database lives (default eu-central-1; pick one near your users)
  --url      only add the app's real web address to the sign-in settings (used after deploying)
  --json     print the result as JSON
  --help     show this text

What it does: makes a project named after the app (the free plan allows 2 active ones), builds
the tables from supabase/migrations, allows sign-in from the right addresses and saves the
project keys in .env.local. You can run it again safely.

With --shared it only adds: a new schema, the app's tables in it, the schema in the API's
list, and the app's addresses in the redirect list. It first saves how the project looks
(.shipyard/shared-snapshot-*.json), checks afterwards that nothing else changed, and prints
the commands to put things back if it did. The main sign-in address, email settings, the
public schema and the sign-up trigger are never touched.
Apps in one project share one list of sign-in accounts.

Needs your Supabase key from the setup step. Keys are never printed.
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) {
    throw new log.UsageError('Give the app folder, for example: node provision-supabase.mjs ./recipe-box');
  }
  if (args.reuse !== undefined) {
    throw new log.UsageError('--reuse was removed because it shared the other app\'s tables and sign-up trigger. Use --shared <project id> instead (the app gets its own space and does not touch the other apps).');
  }
  if (args.url && (args.shared || args.schema || args['dry-run'])) {
    throw new log.UsageError('--url is used on its own, after deploying. Run it without --shared, --schema and --dry-run.');
  }
  if ((args.schema || args['dry-run']) && !args.shared) {
    throw new log.UsageError('--schema and --dry-run need --shared <project id>.');
  }
  const appDir = await resolveAppDir(args._[0]);
  const result = await provisionSupabase({
    appDir, shared: args.shared, schema: args.schema, dryRun: args['dry-run'], region: args.region, url: args.url, reuse: args.reuse,
  });
  if (!args.url) {
    if (result.dryRun) log.ok('Dry run done. Nothing was changed.');
    else {
      log.ok(`Supabase is ready: ${result.url}${result.schema ? ` (schema ${result.schema})` : ''}`);
      log.info('Next: build locally with npm run build, then save to GitHub and run provision-vercel.mjs.');
    }
  }
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['reuse', 'region', 'url', 'shared', 'schema'], boolean: ['dry-run'] },
    help: HELP,
    main,
  });
}
