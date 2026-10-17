// Is the app's own code ready for a shared Supabase project?
//
// In shared mode the app's tables live in their own schema, and every Supabase client in the app must be told so
// (`db: { schema: SUPABASE_SCHEMA }`). An app built from an older template talks to the `public` schema instead, which in
// a shared project belongs to other apps. Provisioning such an app in shared mode would make the deployed app read and
// write another app's tables with the server key. So shared mode refuses to start until the code is current.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProvisionError } from './common.mjs';

export const SCHEMA_HELPER = 'src/lib/supabase/schema.mjs';
/** The places every app creates a Supabase client. Each must exist and pass the schema. */
export const REQUIRED_CLIENT_FILES = [
  'src/lib/supabase/client.ts',
  'src/lib/supabase/server.ts',
  'src/lib/admin.ts',
  'src/proxy.ts',
];

const PASSES_SCHEMA = /\bdb\s*:\s*\{\s*schema\s*:\s*SUPABASE_SCHEMA\s*\}/;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

/** The text of each call to a Supabase client factory, from the name to the matching closing parenthesis. */
export function clientCalls(code) {
  const calls = [];
  for (const m of code.matchAll(/\b(createClient|createServerClient|createBrowserClient)\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) break;
    }
    calls.push({ name: m[1], text: code.slice(m.index, i + 1) });
  }
  return calls;
}

async function walk(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (/\.(?:ts|tsx|mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * What is wrong with the app's code for shared mode: a list of plain sentences (empty = fine).
 * Reads files only.
 */
export async function schemaAwareProblems(appDir) {
  const problems = [];
  try {
    await readFile(path.join(appDir, SCHEMA_HELPER), 'utf8');
  } catch {
    problems.push(`${SCHEMA_HELPER} is missing`);
  }
  for (const rel of REQUIRED_CLIENT_FILES) {
    let code;
    try {
      code = stripComments(await readFile(path.join(appDir, rel), 'utf8'));
    } catch {
      problems.push(`${rel} is missing`);
      continue;
    }
    const calls = clientCalls(code);
    if (calls.length === 0 || !PASSES_SCHEMA.test(code)) problems.push(`${rel} does not pass the schema to its Supabase client`);
  }
  // Any other file that creates a client must pass the schema too.
  for (const file of await walk(path.join(appDir, 'src'))) {
    const rel = path.relative(appDir, file).split(path.sep).join('/');
    if (REQUIRED_CLIENT_FILES.includes(rel)) continue;
    const code = stripComments(await readFile(file, 'utf8'));
    for (const call of clientCalls(code)) {
      if (!PASSES_SCHEMA.test(call.text)) problems.push(`${rel}: ${call.name}(...) does not pass the schema`);
    }
  }
  return problems;
}

/** Throws a plain error unless the app's code passes the schema to every Supabase client. */
export async function assertSchemaAware(appDir) {
  const problems = await schemaAwareProblems(appDir);
  if (problems.length > 0) {
    throw new ProvisionError(
      'This app\'s code is not ready for a shared Supabase project yet, so Shipyard stopped before asking Supabase anything.\n'
      + `${problems.slice(0, 8).map((p) => `  - ${p}`).join('\n')}${problems.length > 8 ? `\n  ... and ${problems.length - 8} more` : ''}\n`
      + 'Without this the finished app would use the "public" schema, which in a shared project belongs to the other apps. '
      + 'Update the app to the current template first, then run this again.',
      { reason: 'app-not-schema-aware', problems },
    );
  }
}
