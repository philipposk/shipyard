// Checks that create test users or write rows must not run against the wrong place when the app shares its Supabase
// project with other apps:
//  - the app's schema setting in .env.local must be the app's own schema (otherwise every call goes to `public`, which
//    in a shared project belongs to another app), and
//  - making a test user fires the sign-up triggers of the other apps in the project, so it only happens when the
//    person asks for it (--allow-test-users).
import { failed, skip } from './util.mjs';
import { getSecret as realGetSecret } from '../lib/secrets.mjs';
import * as api from '../lib/supabase-api.mjs';
import { Q_AUTH_TRIGGERS } from '../provision/shared-snapshot.mjs';

export function schemaMismatchMessage(schema) {
  return `NEXT_PUBLIC_SUPABASE_SCHEMA in .env.local must be ${schema || 'this app\'s schema'} for this app (it shares its project). Run provision-supabase.mjs again.`;
}

/** Is this app in a Supabase project that other apps use? (a schema of its own, or the older shared public schema) */
export const isSharedApp = (app) => Boolean(app?.shared || app?.supabaseShared);

/**
 * How many triggers on auth.users (the shared login table) will run for a test user. null = could not find out.
 * Reads through the Management API with the owner's access token.
 */
export async function countAuthTriggers(app, { getSecret = realGetSecret, fetch, sleep } = {}) {
  try {
    const ref = app?.supabaseRef;
    if (!ref) return null;
    const token = await getSecret('SUPABASE_ACCESS_TOKEN');
    const rows = await api.runSql({ token, fetch, sleep }, ref, Q_AUTH_TRIGGERS);
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

/**
 * Called by the checks that make test users. Returns { stop: <check result> } when the check must not run, or
 * { warnings: [...] } (possibly empty) when it may.
 *   ctx.allowTestUsers      the person passed --allow-test-users
 *   ctx.countAuthTriggers   () => number | null   (tests replace it)
 */
export async function sharedProjectGate(ctx, env, name) {
  if (!isSharedApp(ctx.app)) return { warnings: [] };
  if (ctx.app.shared && env.schema !== ctx.app.schema) {
    return { stop: failed(name, 'the app is pointed at the wrong database schema', [schemaMismatchMessage(ctx.app.schema)]) };
  }
  if (!ctx.allowTestUsers) {
    return {
      stop: skip(name, 'this app shares its Supabase project with other apps, and a test user would run their sign-up triggers (they may leave rows behind or send mail). Run verify again with --allow-test-users to do it anyway'),
    };
  }
  const count = await (ctx.countAuthTriggers ?? (() => countAuthTriggers(ctx.app)))();
  const triggers = count === null || count === undefined ? 'other apps\' sign-up triggers' : `${count} sign-up trigger${count === 1 ? '' : 's'} from the apps in this project`;
  return {
    warnings: [`This app shares its Supabase project, so the throwaway test users also run ${triggers} (on auth.users). The users are deleted again, but a trigger of another app may leave a row behind.`],
  };
}
