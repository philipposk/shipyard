// The student's keys live in ~/.shipyard/secrets.env (KEY=value lines).
// Rules: values are only ever read by code that needs to call a provider.
// They are never printed, logged or put on a command line.
import { readFile, writeFile, appendFile, chmod } from 'node:fs/promises';
import { SECRETS_PATH, ensureHomeDir } from './paths.mjs';
import { skillHint } from './agent.mjs';

const hasPrefix = (...prefixes) => (v) => prefixes.some((p) => v.startsWith(p)) && v.length >= 20;

/** Known keys, in file order. `step` = the setup step that explains how to get it. */
export const KNOWN_SECRETS = [
  {
    name: 'SUPABASE_ACCESS_TOKEN', required: true, step: 'supabase',
    hint: 'Required. Supabase: dashboard > Account > Access Tokens > Generate new token (starts with sbp_).',
    check: hasPrefix('sbp_'),
  },
  {
    name: 'OPENROUTER_API_KEY', required: false, step: 'ai-keys',
    hint: 'Optional (AI features). openrouter.ai > Keys > Create key (starts with sk-or-).',
    check: hasPrefix('sk-or-'),
  },
  {
    name: 'OPENAI_API_KEY', required: false, step: 'ai-keys',
    hint: 'Optional (AI features). platform.openai.com > API keys > Create new secret key (starts with sk-).',
    check: (v) => v.startsWith('sk-') && !v.startsWith('sk-or-') && v.length >= 20,
  },
  {
    name: 'GROQ_API_KEY', required: false, step: 'ai-keys',
    hint: 'Optional (fast AI and speech-to-text, has a free tier). console.groq.com > API Keys > Create API key (starts with gsk_).',
    check: hasPrefix('gsk_'),
  },
  {
    name: 'DEEPGRAM_API_KEY', required: false, step: 'ai-keys',
    hint: 'Optional (speech-to-text, free starting credit). console.deepgram.com > API Keys > Create a new API key (40 letters and numbers).',
    check: (v) => /^[A-Za-z0-9]{32,}$/.test(v),
  },
  {
    name: 'RESEND_API_KEY', required: false, step: 'email',
    hint: 'Optional (sending email). resend.com > API Keys > Create API key (starts with re_).',
    check: (v) => v.startsWith('re_') && v.length >= 10,
  },
  {
    name: 'STRIPE_SECRET_KEY', required: false, step: 'stripe',
    hint: 'Optional (payments). Stripe dashboard in Test mode > Developers > API keys > Secret key (starts with sk_test_). Test keys only: real-money keys go in STRIPE_LIVE_SECRET_KEY.',
    check: hasPrefix('sk_test_', 'rk_test_'),
  },
  {
    name: 'STRIPE_PUBLISHABLE_KEY', required: false, step: 'stripe',
    hint: 'Optional (payments). Stripe dashboard in Test mode > Developers > API keys > Publishable key (starts with pk_test_).',
    check: hasPrefix('pk_test_'),
  },
  {
    name: 'STRIPE_LIVE_SECRET_KEY', required: false, step: 'stripe',
    hint: 'Only when you take real payments. Stripe dashboard with Test mode OFF > Developers > API keys > Secret key (starts with sk_live_). Only the go-live step uses it.',
    check: hasPrefix('sk_live_', 'rk_live_'),
  },
  {
    name: 'STRIPE_LIVE_PUBLISHABLE_KEY', required: false, step: 'stripe',
    hint: 'Only when you take real payments. Same page as the live secret key (starts with pk_live_).',
    check: hasPrefix('pk_live_'),
  },
  {
    name: 'GOOGLE_CLIENT_ID', required: false, step: 'domain',
    hint: 'Optional ("Sign in with Google"). console.cloud.google.com > APIs & Services > Credentials > OAuth client ID.',
    check: (v) => v.endsWith('.apps.googleusercontent.com'),
  },
  {
    name: 'GOOGLE_CLIENT_SECRET', required: false, step: 'domain',
    hint: 'Optional ("Sign in with Google"). Same page as the client ID (starts with GOCSPX-).',
    check: (v) => v.startsWith('GOCSPX-') && v.length >= 20,
  },
];

/**
 * Keys that control a whole account, not one app. They must never be copied into an app's
 * hosting settings: anyone who can read that app's settings (or any code in it) would get them.
 */
export const ACCOUNT_LEVEL_SECRETS = new Set(['SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);

/**
 * Real-money keys. They are never copied to an app automatically (not by provision-vercel, not into .env.local).
 * Only the go-live step (stripe-setup.mjs --live) sends the live key, to production only, under the app's normal name.
 */
export const LIVE_ONLY_SECRETS = new Set(['STRIPE_LIVE_SECRET_KEY', 'STRIPE_LIVE_PUBLISHABLE_KEY']);

/**
 * The Resend key in the keys file can make and delete domains and read every email sent, so it stays on this computer.
 * An app is only given its own sending-only key (launch-email.mjs makes it and puts it in the app's .env.local and on Vercel).
 */
export const FULL_ACCESS_SECRETS = new Set(['RESEND_API_KEY']);

/** Keys in the Shipyard keys file that a single app may be given (a copy goes into that app's settings). */
export const PER_APP_SECRETS = new Set(
  KNOWN_SECRETS.map((k) => k.name).filter((n) => !ACCOUNT_LEVEL_SECRETS.has(n) && !LIVE_ONLY_SECRETS.has(n) && !FULL_ACCESS_SECRETS.has(n)),
);

const FILE_HEADER = [
  '# Shipyard keys. This file stays on your computer. Never paste its contents into a chat.',
  '# Put each key after the = sign, with no spaces or quotes. Save the file when you are done.',
  '',
].join('\n');

/** Parse KEY=value text. Handles comments, blank lines, `export `, quotes and CRLF. */
export function parseEnv(text) {
  const out = new Map();
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out.set(m[1], value);
  }
  return out;
}

async function readText() {
  try {
    return await readFile(SECRETS_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Map of name -> value for keys that have a value. INTERNAL USE ONLY: never log it. */
export async function readSecrets() {
  const text = await readText();
  const all = text === null ? new Map() : parseEnv(text);
  for (const [k, v] of all) if (v === '') all.delete(k);
  return all;
}

/** What's in the file, without the values: [{ name, present, looksValid, required }]. */
export async function listSecrets() {
  const secrets = await readSecrets();
  return KNOWN_SECRETS.map(({ name, required, check }) => {
    const value = secrets.get(name);
    const present = value !== undefined;
    return { name, present, looksValid: present && !/\s/.test(value) && check(value), required };
  });
}

const block = (k) => `# ${k.hint}\n${k.name}=\n`;

/**
 * Create the file (mode 600) with every known key, or append the keys that are
 * missing. Existing text and values are never changed.
 * Returns { path, created, added: [names] }.
 */
export async function ensureSecretsFile() {
  await ensureHomeDir();
  const existing = await readText();
  if (existing === null) {
    await writeFile(SECRETS_PATH, `${FILE_HEADER}\n${KNOWN_SECRETS.map(block).join('\n')}`, { mode: 0o600 });
    await lockDown();
    return { path: SECRETS_PATH, created: true, added: KNOWN_SECRETS.map((k) => k.name) };
  }
  const have = new Set(parseEnv(existing).keys());
  const missing = KNOWN_SECRETS.filter((k) => !have.has(k.name));
  if (missing.length > 0) {
    const lead = existing === '' || existing.endsWith('\n') ? '' : '\n';
    await appendFile(SECRETS_PATH, `${lead}\n${missing.map(block).join('\n')}`);
  }
  await lockDown();
  return { path: SECRETS_PATH, created: false, added: missing.map((k) => k.name) };
}

async function lockDown() {
  if (process.platform === 'win32') return;
  try {
    await chmod(SECRETS_PATH, 0o600);
  } catch {
    // not fatal
  }
}

/** Error for a key that isn't set yet. Says which setup step fixes it. Never holds a value. */
export class MissingSecretError extends Error {
  constructor(name, step) {
    const where = step
      ? `Run "${skillHint('setup')}" and finish the "${step}" step, or add it to ${SECRETS_PATH}.`
      : `Add it to ${SECRETS_PATH}.`;
    super(`${name} is missing. ${where}`);
    this.name = 'MissingSecretError';
    this.secretName = name;
    this.step = step ?? null;
  }
}

/** One value, or a MissingSecretError. Use only to call that provider. */
export async function getSecret(name) {
  const secrets = await readSecrets();
  const value = secrets.get(name);
  if (value === undefined) {
    throw new MissingSecretError(name, KNOWN_SECRETS.find((k) => k.name === name)?.step);
  }
  return value;
}
