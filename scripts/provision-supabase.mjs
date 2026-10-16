#!/usr/bin/env node
// Create the app's Supabase project, build its database and save its keys.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { provisionSupabase } from './provision/supabase-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Set up Supabase (the database and sign-in) for an app made with Shipyard.

Usage:
  node provision-supabase.mjs <app-folder> [--reuse <project-id>] [--region <region>] [--json]
  node provision-supabase.mjs <app-folder> --url https://my-app.vercel.app

  --reuse   share an existing Supabase project instead of making a new one
  --region  where the database lives (default eu-central-1; pick one near your users)
  --url     only add the app's real web address to the sign-in settings (used after deploying)
  --json    print the result as JSON
  --help    show this text

What it does: makes a project named after the app (the free plan allows 2 active ones),
builds the tables from supabase/migrations, allows sign-in from the right addresses and
saves the project keys in .env.local. You can run it again safely.
Needs your Supabase key from the setup step. Keys are never printed.
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) {
    throw new log.UsageError('Give the app folder, for example: node provision-supabase.mjs ./recipe-box');
  }
  const appDir = await resolveAppDir(args._[0]);
  const result = await provisionSupabase({ appDir, reuse: args.reuse, region: args.region, url: args.url });
  if (!args.url) {
    log.ok(`Supabase is ready: ${result.url}`);
    log.info('Next: build locally with npm run build, then save to GitHub and run provision-vercel.mjs.');
  }
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['reuse', 'region', 'url'] },
    help: HELP,
    main,
  });
}
