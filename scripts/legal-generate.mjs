#!/usr/bin/env node
// Write the app's privacy policy and terms (src/lib/legal-content.ts) from the student's details and the services the app uses.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { generateLegal, printResult } from './launch/legal-run.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Write the app's privacy policy and terms of use.

Usage:
  node legal-generate.mjs <app-folder> [--country <code>] [--json]

  --country <code>         country of the person or company running the app (default: owner.country in your profile)
  --min-age <years>        youngest allowed age, 13 to 21 (default 16)
  --supabase-region <code> where the database is, for example eu-central-1 (default: your profile, else eu-central-1)
  --governing-law <place>  whose law and courts the terms name, for example "the State of Texas" (default: your country)
  --also <ids>             also list these services, separated by commas (for example posthog,sentry)
  --without <ids>          leave these services out
  --dry-run                show what would change, write nothing
  --json                   print the result as JSON
  --help                   show this text

What it uses: your company details (profile.mjs set company.legalName / company.address / company.contactEmail),
your country (profile.mjs set owner.country, for example GR; company.country is not used), a phone number people
can call about a purchase (company.phone, needed only when the payments module is on), the modules
in .shipyard-app.json, the settings names the app uses, and the prices in plans.ts when payments are on.
If something is missing it stops and lists exactly what to ask for. Running it again with the same input changes nothing.
The text is a clear draft, not legal advice: have it checked before you take payments.
Exit code: 0 done, 1 could not do it (missing details), 2 wrong options.
`;

const ids = (v) => (v ? String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node legal-generate.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const minAge = args['min-age'] === undefined ? undefined : Number(args['min-age']);
  const result = await generateLegal({
    appDir,
    country: args.country,
    minAge,
    supabaseRegion: args['supabase-region'],
    governingLaw: args['governing-law'],
    also: ids(args.also),
    without: ids(args.without),
    dryRun: args['dry-run'],
  });
  printResult(result);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['country', 'min-age', 'supabase-region', 'governing-law', 'also', 'without'], boolean: ['dry-run'] }, help: HELP, main });
}
