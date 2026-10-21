#!/usr/bin/env node
// Shows how far the student is through setup and what is still missing.
// Reads ~/.shipyard/profile.json and which keys exist (never their values).
// Always exits 0 so a skill can call it without handling errors.
import { existsSync } from 'node:fs';
import { loadProfile, STEP_IDS } from './lib/profile.mjs';
import { listSecrets } from './lib/secrets.mjs';
import { PROFILE_PATH, SECRETS_PATH, isMainModule } from './lib/paths.mjs';
import { ok, fail, warn, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';
import { currentAgent, skillHint } from './lib/agent.mjs';

const HELP = `Usage: setup-status.mjs [--json]

Shows each setup step as done or next, and what is still missing.
Exit code is always 0 (2 for bad usage).
`;

export const STEP_INFO = {
  tools: { title: 'Install the basic tools', optional: false },
  github: { title: 'Connect GitHub', optional: false },
  vercel: { title: 'Connect Vercel (puts your app online)', optional: false },
  supabase: { title: 'Connect Supabase (your app\'s database and logins)', optional: false },
  'ai-keys': { title: 'AI keys (only for apps with AI features)', optional: true },
  email: { title: 'Email sending with Resend', optional: true },
  stripe: { title: 'Payments with Stripe (test mode)', optional: true },
  domain: { title: 'Your own web address', optional: true },
  profile: { title: 'About you', optional: false },
  habits: {
    get title() {
      return currentAgent() === 'claude' ? 'Good Claude habits' : 'Good habits for your coding agent';
    },
    optional: true,
  },
};

const keyState = (keys, name) => keys.find((k) => k.name === name) ?? { present: false, looksValid: false };

/** What is missing for each step, judged from the profile and the keys file. */
export function missingFor(stepId, profile, keys) {
  const acc = profile.accounts ?? {};
  const missing = [];
  switch (stepId) {
    case 'github':
      if (!acc.github?.ok) missing.push('GitHub is not connected yet');
      break;
    case 'vercel':
      if (!acc.vercel?.ok) missing.push('Vercel is not connected yet');
      break;
    case 'supabase': {
      const t = keyState(keys, 'SUPABASE_ACCESS_TOKEN');
      if (!t.present) missing.push('SUPABASE_ACCESS_TOKEN is not in your keys file');
      else if (!t.looksValid) missing.push('SUPABASE_ACCESS_TOKEN does not look right (it starts with sbp_)');
      if (!acc.supabase?.orgId) missing.push('no Supabase organization chosen yet');
      if (!acc.supabase?.ok) missing.push('Supabase key not checked yet (run secrets-check with --live)');
      break;
    }
    case 'ai-keys':
      if (!keyState(keys, 'OPENROUTER_API_KEY').present && !keyState(keys, 'OPENAI_API_KEY').present) {
        missing.push('no AI key saved (skip this if your apps will not use AI)');
      }
      break;
    case 'email':
      if (!keyState(keys, 'RESEND_API_KEY').present) missing.push('RESEND_API_KEY is not in your keys file');
      break;
    case 'stripe':
      if (!keyState(keys, 'STRIPE_SECRET_KEY').present) missing.push('STRIPE_SECRET_KEY is not in your keys file');
      break;
    case 'domain':
      if (profile.domain?.choice === 'buy' && !profile.domain?.name) missing.push('domain name not saved');
      break;
    case 'profile':
      if (!profile.owner?.name) missing.push('your name');
      if (!profile.owner?.email) missing.push('your email');
      if (!profile.owner?.country) missing.push('your country');
      break;
    default:
      break;
  }
  return missing;
}

/** Everything the status needs, as plain data. */
export function buildStatus(profile, keys, { profileExists = true } = {}) {
  const doneList = Array.isArray(profile.setup?.done) ? profile.setup.done : [];
  const nextId = STEP_IDS.find((id) => !doneList.includes(id)) ?? null;
  const steps = STEP_IDS.map((id) => {
    const done = doneList.includes(id);
    return {
      id,
      title: STEP_INFO[id].title,
      optional: STEP_INFO[id].optional,
      done,
      next: id === nextId,
      missing: missingFor(id, profile, keys),
    };
  });
  return {
    profileExists,
    doneCount: steps.filter((s) => s.done).length,
    total: STEP_IDS.length,
    nextStep: nextId,
    allDone: nextId === null,
    steps,
    keys: keys.map(({ name, present, looksValid, required }) => ({ name, present, looksValid, required })),
  };
}

function printHuman(status) {
  if (!status.profileExists) info('This looks like a first run. Nothing is set up yet.');
  info(`Setup: ${status.doneCount} of ${status.total} steps done.`);
  for (const s of status.steps) {
    const tag = s.optional ? ' (optional)' : '';
    if (s.done) {
      ok(`${s.title}${tag}`);
      if (s.missing.length > 0 && !s.optional) warn(`  Marked done, but: ${s.missing.join('; ')}`);
    } else if (s.next) {
      fail(`${s.title}${tag}: this is the next step`);
      for (const m of s.missing) info(`  Missing: ${m}`);
    } else {
      info(`- ${s.title}${tag}: not started`);
    }
  }
  if (status.allDone) ok(`Setup is finished. You can build your first app with ${skillHint('new-app')}.`);
  else info(`Next: ${STEP_INFO[status.nextStep].title}. Run ${skillHint('setup')} to continue.`);
  const missingRequired = status.keys.filter((k) => k.required && !k.present).map((k) => k.name);
  if (missingRequired.length > 0) warn(`Required key not saved yet: ${missingRequired.join(', ')} (file: ${SECRETS_PATH})`);
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { boolean: ['json', 'help'], alias: { h: 'help' } });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.json) setQuiet(true);
  const profile = await loadProfile();
  let keys = [];
  try {
    keys = await listSecrets();
  } catch {
    // an unreadable keys file just counts as "no keys"
  }
  const status = buildStatus(profile, keys, { profileExists: existsSync(PROFILE_PATH) });
  if (args.json) json(status);
  else printHuman(status);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Could not read your setup status: ${err.message}\n`);
      process.exitCode = 0;
    },
  );
}
