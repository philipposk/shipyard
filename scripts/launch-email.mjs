#!/usr/bin/env node
// Real emails for the app: a verified sending domain at Resend, Supabase sign-up emails, the app's own emails.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { launchEmail } from './launch/email-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Set up real emails for your app (sign-up confirmation, password reset, newsletter).

Usage:
  node launch-email.mjs <app-folder> [--domain <sending-domain>] [--check] [--switch-to-verified] [--json]

  --domain <name>        where emails come from (default: send.<your domain>, for example send.example.com)
  --region <code>        Resend region: eu-west-1, us-east-1, sa-east-1 or ap-northeast-1
                         (default: eu-west-1 if you are based in Europe, else Resend's default)
  --check                ask Resend to check the DNS records and wait until they work (up to 10 minutes)
  --timeout-min N        how long --check waits (default 10)
  --switch-to-verified   also turn on confirmed sign-ups (Supabase email confirmation on, a confirmation email that
                         works on any device, NEXT_PUBLIC_SIGNUP_MODE=verified on Vercel)
  --json                 print the result as JSON
  --help                 show this text

First run: creates the domain at Resend and prints the DNS records to add where you bought your domain.
With --check: waits for Resend to confirm. When it is verified: Supabase sends its emails through Resend, and the app
gets RESEND_API_KEY and RESEND_FROM on Vercel. Deploy again afterwards (deploy.mjs). You can run it again safely.
Needs: RESEND_API_KEY and SUPABASE_ACCESS_TOKEN in your Shipyard keys file, a Supabase project and a Vercel project.
Keys are never printed.
Exit code: 0 done, 1 could not do it or not verified yet, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node launch-email.mjs ./recipe-box --domain send.example.com');
  const appDir = await resolveAppDir(args._[0]);
  const timeoutMin = args['timeout-min'] === undefined ? 10 : Number(args['timeout-min']);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin > 120) throw new log.UsageError('--timeout-min must be a number of minutes between 1 and 120.');
  const result = await launchEmail({
    appDir,
    domain: args.domain,
    region: args.region,
    check: args.check,
    timeoutMin,
    switchToVerified: args['switch-to-verified'],
  });
  if (result.next) log.info(result.next);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['domain', 'region', 'timeout-min'], boolean: ['check', 'switch-to-verified'] }, help: HELP, main });
}
