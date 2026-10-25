#!/usr/bin/env node
// Is this Supabase project's database actually answering?
//
//   node supabase-health.mjs <project-ref>
//   node supabase-health.mjs <project-ref> --restart
//
// Uses the access token from the Shipyard keys file and never prints it.
// Checks the database, sign-in and the data API together. Supabase's /auth/v1/health
// can say OK while the database is stuck, so this does not call that.
// --restart asks Supabase to restart the project. That takes about 5 minutes and does
// not refill a used-up disk IO budget. Only pass it after the owner has said yes.
import { startedAs } from './agents/entry.mjs';
import { getSecret as realGetSecret } from './lib/secrets.mjs';
import * as api from './lib/supabase-api.mjs';

const USAGE = `Usage: node supabase-health.mjs <project-ref> [--restart]

Checks whether the database, sign-in and data API are up.
--restart restarts the project (about 5 minutes). The disk IO budget does not refill.`;

/** @param {unknown} body */
export function healthyLines(body) {
  const rows = Array.isArray(body) ? body : [];
  return rows.map((row) => {
    const item = row && typeof row === 'object' ? row : {};
    return {
      name: typeof item.name === 'string' && item.name ? item.name : 'unknown',
      healthy: item.healthy === true,
      status: typeof item.status === 'string' ? item.status : '',
    };
  });
}

/**
 * @param {string[]} argv
 * @param {{ say?: (line: string) => void, getSecret?: typeof realGetSecret, projectHealth?: typeof api.projectHealth, restartProject?: typeof api.restartProject, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [deps]
 */
export async function run(argv, deps = {}) {
  const say = deps.say ?? ((line) => console.log(line));
  if (argv.includes('--help') || argv.includes('-h')) {
    say(USAGE);
    return 0;
  }
  const restart = argv.includes('--restart');
  const ref = argv.find((arg) => arg !== '--restart' && !arg.startsWith('-'));
  if (!ref) {
    say(USAGE);
    return 2;
  }
  const getSecret = deps.getSecret ?? realGetSecret;
  const projectHealth = deps.projectHealth ?? api.projectHealth;
  const restartProject = deps.restartProject ?? api.restartProject;
  let token;
  try {
    token = await getSecret('SUPABASE_ACCESS_TOKEN');
  } catch (err) {
    say(err instanceof Error ? err.message : 'No Supabase access token.');
    return 1;
  }
  const auth = { token, fetch: deps.fetch, sleep: deps.sleep };
  try {
    if (restart) {
      await restartProject(auth, ref);
      say(`Restart requested for ${ref}. It takes about 5 minutes. The disk IO budget does not refill, so cut load once it is back.`);
      return 0;
    }
    const lines = healthyLines(await projectHealth(auth, ref));
    if (lines.length === 0) {
      say('Supabase did not say whether the database, sign-in or data API is up.');
      return 1;
    }
    let bad = false;
    for (const line of lines) {
      say(`${line.name}: ${line.healthy ? 'up' : 'DOWN'}${line.status ? ` (${line.status})` : ''}`);
      if (!line.healthy) bad = true;
    }
    return bad ? 1 : 0;
  } catch (err) {
    say(err instanceof Error ? err.message : 'Could not check the project.');
    return 1;
  }
}

if (startedAs(import.meta.url, 'supabase-health.mjs')) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
