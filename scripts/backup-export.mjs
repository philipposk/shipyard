#!/usr/bin/env node
// Copy an app's data out of Supabase onto this computer, as a backup.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { exportBackup } from './ops/backup-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Make a backup of an app's data. The copy stays on this computer.

Usage:
  node backup-export.mjs <app-folder> [--include-auth] [--all-tables] [--page-size N] [--json]

  --include-auth   also save the sign-in list (ids, emails, sign-up dates and whether the email was confirmed; never passwords, phone numbers or names)
  --all-tables     also save tables that are not on your privacy list (supabase/isolation.json)
  --page-size N    rows fetched at a time (default 1000, smaller if a table has very big rows)
  --json           print the result as JSON
  --help           show this text

What it does: saves every table on your privacy list, plus profiles and the tables of the modules you added, as
JSON files in ~/.shipyard/backups/<app>/<date and time>/ (only you can read that folder), with a manifest.json that
lists the row counts and which database files were applied. Needs your Supabase access token from the Shipyard keys
file (never shown). It never writes inside the app folder or inside a git repository (if your home folder is a git repository, it must ignore ~/.shipyard/).
The files contain your users' personal data: keep them private and delete old ones.
Supabase Pro keeps automatic daily backups; the free plan does not, so run this now and then.
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

export async function main(args, deps = {}) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node backup-export.mjs ./recipe-box');
  const pageSize = args['page-size'] === undefined ? undefined : Number(args['page-size']);
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 50 || pageSize > 5000)) {
    throw new log.UsageError('--page-size must be a whole number between 50 and 5000.');
  }
  const appDir = await resolveAppDir(args._[0]);
  const result = await exportBackup({ appDir, pageSize, allTables: args['all-tables'], includeAuth: args['include-auth'] }, deps);
  log.ok(`Backup saved: ${result.folder}`);
  log.info(`${result.rows} rows in ${result.tables.length} file${result.tables.length === 1 ? '' : 's'}.`);
  log.warn('This folder contains your users\' personal data. Keep it private, delete old copies, and never put it on GitHub.');
  for (const line of result.restore) log.info(line);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['page-size'], boolean: ['include-auth', 'all-tables'] }, help: HELP, main });
}
