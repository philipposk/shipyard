#!/usr/bin/env node
// Make the owner's account for an app and switch on its admin flag.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { makeOwner } from './provision/owner-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Make the owner account (admin) for an app made with Shipyard.

Usage:
  node make-owner.mjs <app-folder> [--email you@example.com] [--url https://my-app.vercel.app] [--no-open] [--reset-password] [--json]

  --email    the owner's email (default: ADMIN_EMAIL in the app's .env.local)
  --url      the address to sign in on (default: the app's web address, or http://localhost:3000)
  --no-open  make the account but do not open a sign-in window
  --reset-password  if the account already existed, replace its password with a random one (use this if you did not make that account yourself)
  --json     print the result as JSON
  --help     show this text

Why: the app never treats an email as proof of who you are, and it refuses sign-ups with the owner's
email. This script makes the owner account with the app's secret key and marks it as admin. It then opens
a one-time sign-in link in your browser. Nothing secret is printed. Run it again any time you need a fresh link.
Needs the app's .env.local from provision-supabase.mjs. For http://localhost:3000, start the app first (npm run dev).
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node make-owner.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const result = await makeOwner({ appDir, email: args.email, url: args.url, open: !args['no-open'], resetPassword: args['reset-password'] });
  log.ok(result.created ? `Made the owner account for ${result.email}` : `Found the owner account for ${result.email}`);
  log.ok('Admin is switched on for that account');
  if (result.passwordReset) log.ok('Its old password no longer works. Use the sign-in link, or "Forgot password" once email sending is set up.');
  else if (!result.created) log.info('That account already existed. If you did not make it yourself, run this again with --reset-password.');
  if (result.signInLink === 'opened') log.info(`A sign-in window is opening on ${result.site}. If it shows an error, start the app and run this again.`);
  else if (result.signInLink === 'not-opened') log.warn('Could not open your browser. Run this again, or sign in with the owner email.');
  else log.info('No sign-in link was made.');
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['email', 'url'], boolean: ['no-open', 'reset-password'] },
    help: HELP,
    main,
  });
}
