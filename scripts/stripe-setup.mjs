#!/usr/bin/env node
// Payments in Stripe: products, prices, customer portal and webhook, and the app's settings on Vercel.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { stripeSetup } from './launch/stripe-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Set up payments in Stripe for your app.

Usage:
  node stripe-setup.mjs <app-folder> [--live] [--json]

  (no flag)  test mode: fake cards, nobody is charged. Uses STRIPE_SECRET_KEY (a test key, sk_test_).
  --live     real money. Uses STRIPE_LIVE_SECRET_KEY (a live key, sk_live_). It refuses to start, and does not touch
             your live Stripe account, until all of this is true: the app is on your own domain, the legal pages are made and
             name you, sign-ups need a confirmed email, Vercel Pro is confirmed, test mode worked, and launch-check passes
             (that check only reads: it asks Stripe in test mode, and Resend if email is set up).
  --json     print the result as JSON
  --help     show this text

What it does (safe to run again): makes or updates one product and price per paid plan in src/lib/billing/plans.ts
(a changed price makes a new price and moves the lookup key to it), a customer portal (cancel at period end,
update card, invoices), and a webhook at <your site>/api/billing/webhook. The webhook's signing secret goes straight
to Vercel and is never shown. Keys are read from your Shipyard keys file and never printed.
After a live setup, test values only ever go to Vercel's development environment, never production.
Exit code: 0 done, 1 could not do it or not ready, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node stripe-setup.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const result = await stripeSetup({ appDir, live: args.live });
  for (const m of result.manual) log.warn(m);
  log.info(result.next);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { boolean: ['live'] }, help: HELP, main });
}
