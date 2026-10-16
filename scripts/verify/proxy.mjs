// Check (no network): the sign-in gate (src/proxy.ts) is set up so sign-up and password reset work.
// Next 16 calls this file proxy.ts; the old name middleware.ts must not be used any more.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripComments, readAppFile, pass, failed } from './util.mjs';

const exists = async (p) => stat(p).then(() => true, () => false);

async function firstExisting(candidates) {
  for (const p of candidates) if (await exists(p)) return p;
  return null;
}

/** Every route.* file below `dir`, as URL paths relative to the app's api/auth folder ("/signup", "/a/b"). */
async function routePaths(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      // (group) folders do not appear in the URL.
      const segment = /^\(.*\)$/.test(e.name) ? '' : `/${e.name}`;
      out.push(...(await routePaths(path.join(dir, e.name), prefix + segment)));
    } else if (/^route\.(?:ts|tsx|js|jsx|mjs)$/.test(e.name)) {
      out.push(prefix || '/');
    }
  }
  return out;
}

/** String literals inside `const NAME = [ ... ]`. Returns null if the list is not found. */
export function readStringList(code, listName) {
  const re = new RegExp(`\\b${listName}\\b\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`);
  const m = re.exec(code);
  if (!m) return null;
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$]*)`/g)].map((x) => x[1] ?? x[2] ?? x[3]);
}

const covers = (prefix, pathname) => pathname === prefix || pathname.startsWith(`${prefix.replace(/\/$/, '')}/`);

export async function check(ctx) {
  const name = 'proxy';
  const details = [];
  const problems = [];
  const srcDir = (await exists(path.join(ctx.appDir, 'src'))) ? path.join(ctx.appDir, 'src') : ctx.appDir;

  // 1. The file exists under the right name.
  const proxyPath = await firstExisting([path.join(srcDir, 'proxy.ts'), path.join(srcDir, 'proxy.js')]);
  const oldPath = await firstExisting([path.join(srcDir, 'middleware.ts'), path.join(srcDir, 'middleware.js')]);
  if (oldPath) problems.push(`${path.basename(oldPath)} still exists. Next 16 uses proxy.ts; having both stops the app from building. Delete ${path.basename(oldPath)}`);
  if (!proxyPath) {
    problems.push('src/proxy.ts is missing, so nothing protects private pages or refreshes logins');
    return failed(name, 'sign-in gate is missing', problems);
  }
  const code = stripComments(await readFile(proxyPath, 'utf8'));

  // 2. It exports `proxy` (Next only runs a function with this name or a default export).
  const exportsProxy =
    /export\s+(?:async\s+)?function\s+proxy\b/.test(code) ||
    /export\s+(?:const|let|var)\s+proxy\b/.test(code) ||
    /export\s*\{[^}]*\bproxy\b[^}]*\}/.test(code) ||
    /export\s+default\b/.test(code);
  if (!exportsProxy) problems.push('proxy.ts does not export a function called proxy');
  else details.push('proxy.ts exports proxy');

  // 3. Every sign-in route is public.
  const authDir = (await exists(path.join(srcDir, 'app', 'api', 'auth')))
    ? path.join(srcDir, 'app', 'api', 'auth')
    : path.join(ctx.appDir, 'app', 'api', 'auth');
  const routes = (await routePaths(authDir)).map((r) => `/api/auth${r === '/' ? '' : r}`);
  const publicList = readStringList(code, 'PUBLIC_PREFIXES');
  if (routes.length > 0) {
    if (!publicList) {
      problems.push('proxy.ts has no PUBLIC_PREFIXES list, so signed-out visitors cannot reach the sign-up and password routes');
    } else {
      const uncovered = routes.filter((r) => !publicList.some((p) => covers(p, r)));
      for (const r of uncovered) problems.push(`${r} is not in PUBLIC_PREFIXES in proxy.ts, so signed-out visitors get a 401 or a redirect there`);
      if (uncovered.length === 0) details.push(`${routes.length} sign-in route${routes.length === 1 ? '' : 's'} (${routes.map((r) => r.replace('/api/auth/', '')).join(', ')}) are public`);
    }
  } else {
    details.push('no routes under api/auth to check');
  }

  // 4. The login cookie name is set in one place and used everywhere.
  const cookiesPath = await firstExisting([
    path.join(srcDir, 'lib', 'supabase', 'cookies.ts'),
    path.join(srcDir, 'lib', 'supabase', 'cookies.js'),
  ]);
  if (!cookiesPath) {
    problems.push('src/lib/supabase/cookies.ts is missing, so the login cookie is not defined');
  } else {
    const cookieCode = stripComments(await readFile(cookiesPath, 'utf8'));
    const nameMatch = /AUTH_COOKIE_NAME\s*=\s*["'`]([^"'`]+)["'`]/.exec(cookieCode);
    const cookieName = nameMatch?.[1];
    if (!cookieName) {
      problems.push('cookies.ts has no AUTH_COOKIE_NAME');
    } else {
      const slug = (await readAppFile(ctx.appDir))?.slug ?? ctx.app?.slug;
      if (/[<>]/.test(cookieName)) problems.push(`the login cookie name "${cookieName}" still has a setup placeholder in it`);
      else if (!/^sb-.+-auth$/.test(cookieName)) problems.push(`the login cookie name "${cookieName}" should look like sb-<app>-auth`);
      else if (slug && cookieName !== `sb-${slug}-auth`) problems.push(`the login cookie name is "${cookieName}" but should be "sb-${slug}-auth" so apps do not share logins`);
      else details.push(`login cookie is ${cookieName}`);

      if (/\bdomain\s*:/.test(cookieCode)) problems.push('cookies.ts sets a cookie domain, which would share the login with other apps on the same site');
    }

    // Every Supabase client must use the shared cookie options, or sign-in "works" but the next page forgets you.
    const toCheck = [proxyPath];
    for (const f of ['client.ts', 'server.ts']) {
      const p = path.join(path.dirname(cookiesPath), f);
      if (await exists(p)) toCheck.push(p);
    }
    for (const file of toCheck) {
      const text = stripComments(await readFile(file, 'utf8'));
      const makesClient = /\bcreate(?:Server|Browser)Client\s*\(/.test(text);
      if (makesClient && !/\bauthCookieOptions\b/.test(text)) {
        problems.push(`${path.relative(ctx.appDir, file).split(path.sep).join('/')} creates a Supabase client without authCookieOptions (the cookie names would not match)`);
      }
      const literal = /["'`](sb-[^"'`\s]+-auth)["'`]/.exec(text);
      if (literal && cookieName && literal[1] !== cookieName) {
        problems.push(`${path.relative(ctx.appDir, file).split(path.sep).join('/')} uses its own cookie name "${literal[1]}" instead of the one in cookies.ts`);
      }
    }
    if (!problems.some((p) => p.includes('authCookieOptions') || p.includes('its own cookie name'))) {
      details.push('proxy and Supabase clients share one cookie setting');
    }
  }

  if (problems.length > 0) return failed(name, `${problems.length} problem${problems.length === 1 ? '' : 's'} in the sign-in gate`, problems, { details });
  return pass(name, 'sign-in gate looks right', details);
}
