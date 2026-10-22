#!/usr/bin/env node
// Checks the keys in ~/.shipyard/secrets.env: are they there, do they look right,
// and (with --live) does the provider accept them. Never prints a key.
import { readSecrets, KNOWN_SECRETS } from './lib/secrets.mjs';
import { loadProfile, saveProfile } from './lib/profile.mjs';
import { listOrganizations, orgSlug, ApiError } from './lib/supabase-api.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, fail, warn, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const HELP = `Usage: secrets-check.mjs [--live] [--json]

Checks each key in ~/.shipyard/secrets.env: present, and in the right format.
  --live   also make one small read-only request per key to the provider
           (Supabase, OpenRouter, OpenAI, Groq, Deepgram, Resend, Stripe,
           ElevenLabs, Routeway, Brave, Serper, SerpAPI, Upstash). NVIDIA is format-only.
           Brave and Serper use one search credit each.
           A key whose format looks wrong is never sent anywhere.
  --json   machine-readable output (never contains key values)
Exit code: 0 = all good, 1 = a needed key is missing or was rejected, 2 = bad usage.
`;

const TIMEOUT_MS = 20_000;

// Which profile account each key proves.
const ACCOUNT_OF = {
  SUPABASE_ACCESS_TOKEN: 'supabase',
  OPENROUTER_API_KEY: 'openrouter',
  OPENAI_API_KEY: 'openai',
  RESEND_API_KEY: 'resend',
  STRIPE_SECRET_KEY: 'stripe',
};

const SERVICE = {
  SUPABASE_ACCESS_TOKEN: 'Supabase',
  OPENROUTER_API_KEY: 'OpenRouter',
  OPENAI_API_KEY: 'OpenAI',
  GROQ_API_KEY: 'Groq',
  DEEPGRAM_API_KEY: 'Deepgram',
  RESEND_API_KEY: 'Resend',
  STRIPE_SECRET_KEY: 'Stripe',
  ELEVENLABS_API_KEY: 'ElevenLabs',
  ROUTEWAY_API_KEY: 'Routeway',
  BRAVE_API_KEY: 'Brave Search',
  SERPER_API_KEY: 'Serper',
  SERPAPI_API_KEY: 'SerpAPI',
  UPSTASH_REDIS_REST_TOKEN: 'Upstash',
};

/**
 * Keys that are not tested with a plain "Authorization: Bearer" GET. Each returns the request to make.
 * All are free or cost at most one search credit. NVIDIA_API_KEY has no free authenticated
 * read-only call we could verify, so it is checked by format only.
 */
export const PROBE = {
  ELEVENLABS_API_KEY: (v) => ({ url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': v } }),
  ROUTEWAY_API_KEY: (v) => ({ url: 'https://api.routeway.ai/v1/models', headers: { Authorization: `Bearer ${v}` } }),
  // Brave: one search counts against the free monthly quota.
  BRAVE_API_KEY: (v) => ({ url: 'https://api.search.brave.com/res/v1/web/search?q=test&count=1', headers: { 'X-Subscription-Token': v } }),
  // Serper: one search uses one credit.
  SERPER_API_KEY: (v) => ({
    url: 'https://google.serper.dev/search',
    method: 'POST',
    headers: { 'X-API-KEY': v, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: 'test', num: 1 }),
  }),
  // SerpAPI: the account endpoint is free (no search credit).
  SERPAPI_API_KEY: (v) => ({ url: `https://serpapi.com/account.json?api_key=${encodeURIComponent(v)}` }),
  // Upstash: PING the database named in UPSTASH_REDIS_REST_URL (only when that URL is a real Upstash address).
  UPSTASH_REDIS_REST_TOKEN: (v, all) => {
    const base = String(all?.get?.('UPSTASH_REDIS_REST_URL') ?? '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.upstash\.io$/i.test(base)) return null;
    return { url: `${base}/ping`, headers: { Authorization: `Bearer ${v}` } };
  },
};

const ENDPOINT = {
  OPENROUTER_API_KEY: 'https://openrouter.ai/api/v1/key',
  OPENAI_API_KEY: 'https://api.openai.com/v1/models',
  GROQ_API_KEY: 'https://api.groq.com/openai/v1/models',
  DEEPGRAM_API_KEY: 'https://api.deepgram.com/v1/projects',
  RESEND_API_KEY: 'https://api.resend.com/domains',
  STRIPE_SECRET_KEY: 'https://api.stripe.com/v1/balance',
};

/** Turn an HTTP status into a plain-English result. `inconclusive` = say nothing about the key. */
export function interpretStatus(service, status) {
  if (status >= 200 && status < 300) return { ok: true, reason: `${service} accepted it` };
  if (status === 401 || status === 403) {
    return { ok: false, reason: `${service} did not accept this key. Make a new one and paste it into the keys file.` };
  }
  if (status === 429) return { ok: false, inconclusive: true, reason: `${service} says too many requests. Try again in a minute.` };
  if (status >= 500) return { ok: false, inconclusive: true, reason: `${service} is having trouble right now. Try again later.` };
  return { ok: false, inconclusive: true, reason: `${service} answered in an unexpected way (HTTP ${status}).` };
}

// Deepgram wants "Token <key>"; the others take "Bearer <key>".
const AUTH_SCHEME = { DEEPGRAM_API_KEY: 'Token' };

async function bearerGet(url, value, fetchImpl, scheme = 'Bearer') {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `${scheme} ${value}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: fine
  }
  return { status: res.status, body };
}

/**
 * One cheap read-only request for one key.
 * Returns { ok, reason, inconclusive?, details? } and never includes the key.
 */
export async function liveCheck(name, value, fetchImpl = fetch, all = new Map()) {
  const service = SERVICE[name];
  if (!service) return null;
  if (/[\s\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, reason: 'The key has spaces or line breaks in it. Re-copy it on a single line.' };
  }
  try {
    if (name === 'SUPABASE_ACCESS_TOKEN') {
      const orgs = await listOrganizations({ token: value, fetch: fetchImpl });
      return {
        ok: true,
        reason: 'Supabase accepted it',
        details: { orgs: (Array.isArray(orgs) ? orgs : []).map((o) => ({ slug: orgSlug(o), name: String(o?.name ?? '') })) },
      };
    }
    if (PROBE[name]) {
      const req = PROBE[name](value, all);
      if (!req) return { ok: false, inconclusive: true, reason: 'UPSTASH_REDIS_REST_URL is missing or not an Upstash address, so the token was not sent' };
      const res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers: { Accept: 'application/json', ...req.headers },
        body: req.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return interpretStatus(service, res.status);
    }
    const { status, body } = await bearerGet(ENDPOINT[name], value, fetchImpl, AUTH_SCHEME[name]);
    if (name === 'RESEND_API_KEY' && status === 401 && body?.name === 'restricted_api_key') {
      return { ok: true, reason: 'Resend accepted it (it can send email but not list domains)', details: { domains: [] } };
    }
    const result = interpretStatus(service, status);
    if (result.ok && name === 'RESEND_API_KEY') {
      const list = Array.isArray(body?.data) ? body.data : [];
      result.details = { domains: list.map((d) => ({ name: String(d?.name ?? ''), status: String(d?.status ?? '') })) };
    }
    if (result.ok && name === 'STRIPE_SECRET_KEY') {
      result.details = { mode: /^(sk|rk)_live_/.test(value) ? 'live' : 'test' };
    }
    return result;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) return { ok: false, reason: err.message };
      return { ok: false, inconclusive: true, reason: err.message };
    }
    return { ok: false, inconclusive: true, reason: `Could not reach ${service}. Check your internet connection.` };
  }
}

/**
 * Check every known key. With live:true, also ask the providers and save the
 * result to the profile. Returns { ok, live, keys: [...], orgs? } with no values in it.
 */
export async function checkSecrets({ live = false, fetchImpl = fetch, save = true } = {}) {
  const values = await readSecrets();
  const keys = [];
  const profile = live ? await loadProfile() : null;
  let profileChanged = false;
  let orgs;

  for (const def of KNOWN_SECRETS) {
    const value = values.get(def.name);
    const present = value !== undefined;
    const looksValid = present && !/\s/.test(value) && def.check(value);
    const entry = { name: def.name, required: def.required, present, looksValid, ok: false, hint: def.hint };

    if (live && present && SERVICE[def.name] && !looksValid) {
      // Never send a key to a service when it does not look like that service's key
      // (for example a Supabase token pasted on the OpenAI line).
      entry.live = {
        ok: false,
        inconclusive: true,
        skipped: true,
        reason: `format looks wrong for ${def.name}, not sent to ${SERVICE[def.name]}`,
      };
    } else if (live && present && SERVICE[def.name]) {
      entry.live = await liveCheck(def.name, value, fetchImpl, values);
      const acct = ACCOUNT_OF[def.name];
      if (entry.live && !entry.live.inconclusive && profile.accounts?.[acct]) {
        // Supabase counts as connected only once an organization is chosen (the setup step saves it).
        const needsOrg = acct === 'supabase' && !profile.accounts.supabase.orgId;
        const newOk = entry.live.ok && !needsOrg;
        profile.accounts[acct].ok = newOk;
        profileChanged = true;
        if (entry.live.ok && acct === 'stripe' && entry.live.details?.mode) profile.accounts.stripe.mode = entry.live.details.mode;
        if (entry.live.ok && acct === 'resend' && !profile.accounts.resend.domain) {
          const d = entry.live.details?.domains?.find((x) => x.name);
          if (d) profile.accounts.resend.domain = d.name;
        }
      }
      if (entry.live?.details?.orgs) orgs = entry.live.details.orgs;
    }

    const liveSaysNo = entry.live && !entry.live.inconclusive && entry.live.ok === false;
    entry.ok = present && !liveSaysNo && (entry.live && entry.live.ok ? true : looksValid);
    keys.push(entry);
  }

  if (profileChanged && save) await saveProfile(profile);

  const failing = keys.some((k) => (k.required && !k.ok) || (k.present && k.live && !k.live.inconclusive && k.live.ok === false));
  const result = { ok: !failing, live, keys };
  if (orgs) result.orgs = orgs;
  return result;
}

/** One plain line naming each Supabase organization and its slug (the short id to save). */
export const orgsLine = (orgs) => `Supabase organizations (save the slug as the organization id): ${orgs.map((o) => `${o.name}: slug=${o.slug}`).join('; ')}`;

function printHuman(result) {
  for (const k of result.keys) {
    const live = k.live;
    if (!k.present) {
      if (k.required) {
        fail(`${k.name}: missing (needed)`);
        info(`  ${k.hint}`);
      } else {
        info(`- ${k.name}: not set (optional)`);
      }
      continue;
    }
    if (live?.skipped) {
      const text = `${live.reason.charAt(0).toUpperCase()}${live.reason.slice(1)}. Copy the whole key again, with no spaces.`;
      (k.required ? fail : warn)(text);
    } else if (live && !live.inconclusive && live.ok === false) {
      fail(`${k.name}: ${live.reason}`);
    } else if (live && live.inconclusive) {
      warn(`${k.name}: saved, but could not be checked. ${live.reason}`);
    } else if (!k.looksValid && !(live && live.ok)) {
      (k.required ? fail : warn)(`${k.name}: saved, but the format looks wrong. Copy the whole key again, with no spaces.`);
    } else if (live && live.ok) {
      ok(`${k.name}: saved and works. ${live.reason}.`);
    } else {
      ok(`${k.name}: saved and the format looks right${result.live ? '' : ' (not tested; add --live to test)'}`);
    }
  }
  if (result.orgs) {
    if (result.orgs.length === 0) warn('Your Supabase account has no organization yet. Create one in the Supabase dashboard.');
    else info(orgsLine(result.orgs));
  }
  if (result.ok) ok('Keys look good.');
  else fail('Fix the keys above in your keys file, then run this again.');
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { boolean: ['json', 'help', 'live'], alias: { h: 'help' } });
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
  const result = await checkSecrets({ live: args.live });
  if (args.json) {
    json({ ...result, keys: result.keys.map(({ hint, ...rest }) => rest) });
  } else {
    printHuman(result);
  }
  return result.ok ? 0 : 1;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Could not check your keys: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
