// Helper for the `secrets` check: find code that uses the secret server key (the one that skips every
// privacy rule) outside the few files that are allowed to.
//
// The most common leak in apps built with AI is not a missing privacy rule. It is a route or server action
// that uses createSupabaseAdmin() and runs `select *` without filtering by user: the database rules are
// never consulted, so the route hands out everyone's rows. The database test cannot see that, so this reads the code.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripComments } from './util.mjs';

/** Files (relative to src/, with forward slashes) that may use the server key. A trailing / means the whole folder. */
export const SERVER_KEY_ALLOWED = [
  'lib/admin.ts',
  'lib/auth/',
  'app/api/auth/signup/',
  'app/api/auth/forgot-password/',
  // Added by the payments and email-list modules. Each is the only place that module touches the database with the secret key.
  'lib/billing/store.ts',
  'lib/newsletter/store.ts',
  // Added by the errors module: the only file that reads and writes the error log.
  'lib/errors/store.ts',
];

const USES_SERVER_KEY = /@\/lib\/admin\b|\blib\/admin["'`]|\bSUPABASE_SERVICE_ROLE_KEY\b|\bcreateSupabaseAdmin\b/;
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), out);
    } else if (CODE_FILE.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

export const isAllowedForServerKey = (relativeToSrc) =>
  SERVER_KEY_ALLOWED.some((a) => (a.endsWith('/') ? relativeToSrc.startsWith(a) : relativeToSrc === a));

/** Returns the files under src/ that use the server key but are not allowed to, as paths relative to the app. */
export async function findServerKeyMisuse(appDir) {
  const src = path.join(appDir, 'src');
  if (!(await stat(src).then((s) => s.isDirectory(), () => false))) return { checked: false, files: [] };
  const files = [];
  for (const file of await walk(src)) {
    const rel = path.relative(src, file).split(path.sep).join('/');
    if (isAllowedForServerKey(rel)) continue;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (USES_SERVER_KEY.test(stripComments(text))) files.push(`src/${rel}`);
  }
  return { checked: true, files };
}
