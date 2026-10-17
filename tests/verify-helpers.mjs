// Shared test fixtures for the verify tests: a fake app + fake Supabase on one local http server,
// and a helper that builds an app folder from the real template files. No network, no real keys.
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE = path.join(here, '..', 'template');

export const ANON = 'test-anon-key-aaaaaaaaaaaa';
export const SERVER = 'test-server-key-bbbbbbbbbbbb';
export const APP_NAME = 'Fake Planner & Co';

export async function tempDir(prefix = 'shipyard-verify-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
export const removeDir = (dir) => rm(dir, { recursive: true, force: true });

/** Copy the parts of the real template the static checks read, with placeholders filled in. */
export async function makeAppFromTemplate(dir, { slug = 'fake-planner', name = APP_NAME } = {}) {
  const files = [
    'src/proxy.ts',
    'src/lib/supabase/cookies.ts',
    'src/lib/supabase/client.ts',
    'src/lib/supabase/server.ts',
    'src/lib/constants.ts',
    'src/app/api/auth/signup/route.ts',
    'src/app/api/auth/forgot-password/route.ts',
    'supabase/isolation.json',
    'scripts/secret-scan.mjs',
    'scripts/design-check.mjs',
    '.gitignore',
  ];
  for (const rel of files) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    let text = await readFile(path.join(TEMPLATE, rel), 'utf8');
    text = text.replaceAll('<APP_SLUG>', slug).replaceAll('<APP_NAME>', name)
      .replaceAll('<APP_SHORT_NAME>', 'Planner').replaceAll('<APP_DESCRIPTION>', 'A planner').replaceAll('<APP_TAGLINE>', 'A planner')
      .replaceAll('<APP_LAYOUT>', 'bottom-nav');
    await writeFile(target, text);
  }
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug, name, layout: 'bottom-nav', modules: [] }));
  return dir;
}

export async function copyTemplateDir(dir) {
  await cp(TEMPLATE, dir, { recursive: true });
}

/**
 * Fake app + fake Supabase. `opts`:
 *   leak: array of 'read' | 'update' | 'delete' | 'anon' | 'spoof'  (turn privacy rules off)
 *   noProfileTrigger, failUserDelete, failCreateAfter (number of users that may exist before creating one fails), gate404, plain404, vercelWall, signupOptions (status), badPage / redirectPage / placeholderPage (path)
 * Returns { url, state, close }.
 */
export async function startFake(opts = {}) {
  const leak = new Set(opts.leak ?? []);
  const state = { users: new Map(), items: [], profiles: [], subs: [], requests: [], restHeaders: [] };
  const PROFILE_COLUMNS = new Set(['display_name', 'bio', 'onboarding_complete']);

  const send = (res, status, body, headers = {}) => {
    const isString = typeof body === 'string';
    res.writeHead(status, { 'content-type': isString ? 'text/html; charset=utf-8' : 'application/json', ...headers });
    res.end(body === undefined ? '' : isString ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); } });
  });
  const actor = (req) => {
    const bearer = /^Bearer (tok_.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer) {
      const id = bearer.slice(4);
      return state.users.has(id) ? { kind: 'user', id } : { kind: 'bad' };
    }
    if (req.headers.apikey === SERVER) return { kind: 'server' };
    return { kind: 'anon' };
  };
  // subs = a table only the server may write to (like the payments tables): people can read their own row and nothing else.
  const tableDef = { items: { owner: 'user_id', rows: () => state.items }, profiles: { owner: 'id', rows: () => state.profiles }, subs: { owner: 'user_id', rows: () => state.subs, serverOnly: true } };
  const matches = (row, params) => [...params.entries()].every(([k, v]) => {
    if (['select', 'limit', 'order'].includes(k)) return true;
    const m = /^eq\.(.*)$/.exec(v);
    return m ? String(row[k]) === m[1] : true;
  });
  const dropUserRows = (id) => {
    state.items = state.items.filter((r) => r.user_id !== id);
    state.profiles = state.profiles.filter((r) => r.id !== id);
    state.subs = state.subs.filter((r) => r.user_id !== id);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    state.requests.push(`${req.method} ${p}`);
    if (p.startsWith('/rest/v1/')) {
      state.restHeaders.push({ method: req.method, path: p, accept: req.headers['accept-profile'] ?? null, content: req.headers['content-profile'] ?? null });
    }

    // ----- Supabase auth -----
    if (p === '/auth/v1/admin/users' && req.method === 'POST') {
      if (req.headers.apikey !== SERVER) return send(res, 401, { msg: 'invalid key' });
      const body = await readBody(req);
      if (opts.failCreateAfter !== undefined && state.users.size >= opts.failCreateAfter) return send(res, 500, { msg: 'cannot create user' });
      const id = randomUUID();
      state.users.set(id, { id, email: body.email, password: body.password });
      if (!opts.noProfileTrigger) {
        state.profiles.push({ id, display_name: null, bio: null, onboarding_complete: false, is_admin: false, created_at: 'now' });
      }
      return send(res, 200, { id, email: body.email });
    }
    const del = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(p);
    if (del && req.method === 'DELETE') {
      if (opts.failUserDelete) return send(res, 500, { msg: 'nope' });
      state.users.delete(del[1]);
      dropUserRows(del[1]);
      return send(res, 200, {});
    }
    if (p === '/auth/v1/token') {
      const body = await readBody(req);
      const user = [...state.users.values()].find((x) => x.email === body?.email && x.password === body?.password);
      if (!user) return send(res, 400, { error_description: 'Invalid login credentials' });
      return send(res, 200, { access_token: `tok_${user.id}`, user: { id: user.id, email: user.email } });
    }
    if (p === '/auth/v1/logout') return send(res, 204, undefined);

    // ----- Supabase database API -----
    const rest = /^\/rest\/v1\/([a-z_]+)$/.exec(p);
    if (rest) {
      const def = tableDef[rest[1]];
      if (!def) return send(res, 404, { message: 'relation does not exist' });
      const who = actor(req);
      if (who.kind === 'bad') return send(res, 401, { message: 'JWT invalid' });
      const rows = def.rows();
      const canSee = (row) => who.kind === 'server' || (who.kind === 'user' && (row[def.owner] === who.id || leak.has('read'))) || (who.kind === 'anon' && leak.has('anon'));
      const wantRows = /return=representation/.test(req.headers.prefer ?? '');
      const project = (list) => {
        const sel = u.searchParams.get('select');
        if (!sel || sel === '*') return list;
        const cols = sel.split(',');
        return list.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      };

      if (req.method === 'GET') {
        if (who.kind === 'anon' && !leak.has('anon')) return send(res, 401, { message: 'permission denied for table' });
        let out = rows.filter((r) => canSee(r) && matches(r, u.searchParams));
        const lim = Number(u.searchParams.get('limit'));
        if (lim) out = out.slice(0, lim);
        return send(res, 200, project(out));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (who.kind === 'anon') return send(res, 401, { message: 'permission denied' });
        if (who.kind === 'user' && def.serverOnly && !leak.has('spoof')) return send(res, 403, { message: 'permission denied for table subs' });
        if (who.kind === 'user') {
          if (body[def.owner] === undefined && def.owner !== 'id') body[def.owner] = who.id;
          if (body[def.owner] !== who.id && !leak.has('spoof')) return send(res, 403, { message: 'new row violates row-level security policy' });
        }
        if (rest[1] === 'profiles' && rows.some((r) => r.id === body.id)) return send(res, 409, { message: 'duplicate key value' });
        if (rest[1] === 'items') {
          if (typeof body.title !== 'string') return send(res, 400, { message: 'null value in column "title"' });
          body.id = randomUUID();
        }
        rows.push(body);
        return send(res, 201, wantRows ? [body] : undefined);
      }
      if (req.method === 'PATCH' || req.method === 'DELETE') {
        if (who.kind === 'anon') return send(res, 401, { message: 'permission denied' });
        const body = req.method === 'PATCH' ? await readBody(req) : null;
        if (req.method === 'PATCH' && rest[1] === 'profiles' && Object.keys(body ?? {}).some((k) => !PROFILE_COLUMNS.has(k))) {
          return send(res, 403, { message: 'permission denied for table profiles' });
        }
        const allowAll = req.method === 'PATCH' ? leak.has('update') : leak.has('delete');
        const hit = rows.filter((r) => matches(r, u.searchParams) && (who.kind === 'server' || (who.kind === 'user' && ((!def.serverOnly && r[def.owner] === who.id) || allowAll))));
        if (req.method === 'DELETE' && rest[1] === 'profiles' && who.kind !== 'server') return send(res, 200, wantRows ? [] : undefined);
        if (req.method === 'PATCH') hit.forEach((r) => Object.assign(r, body));
        else hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return send(res, 200, wantRows ? hit : undefined);
      }
    }

    // ----- The app -----
    if (p === '/api/profile' && req.method === 'GET') {
      const who = actor(req);
      if (who.kind !== 'user') return send(res, 401, { error: 'Unauthorized' });
      const user = state.users.get(who.id);
      return send(res, 200, { profile: state.profiles.find((r) => r.id === who.id) ?? null, user: { id: user.id, email: user.email } });
    }
    if (opts.vercelWall) {
      return send(res, 401, '<html><title>Authentication Required</title><a href="https://vercel.com/sso-api?url=x">log in</a></html>', { 'set-cookie': '_vercel_sso_nonce=abc; Path=/' });
    }
    if (p === '/api/auth/signup' && req.method === 'OPTIONS') return send(res, opts.signupOptions ?? 204, undefined);

    const pages = ['/', '/about', '/help', '/privacy', '/terms', '/sign-in', '/robots.txt', '/sitemap.xml', '/llms.txt', '/icon.svg'];
    if (opts.badPage === p) return send(res, 500, 'boom');
    if (opts.redirectPage === p) return send(res, 307, undefined, { location: '/sign-in?next=%2Fprivate' });
    if (p === '/manifest.webmanifest') return send(res, 200, JSON.stringify({ name: APP_NAME }), { 'content-type': 'application/manifest+json' });
    if (opts.placeholderPage === p) return send(res, 200, '<html>Welcome to &lt;APP_NAME&gt;</html>');
    if (pages.includes(p)) return send(res, 200, `<html><body>${APP_NAME.replace('&', '&amp;')}</body></html>`);
    if (opts.gate404 && !/\.(txt|svg|png)$/.test(p)) {
      return send(res, 307, undefined, { location: `/sign-in?next=${encodeURIComponent(p)}` });
    }
    if (opts.plain404) return send(res, 404, '<html><body>Not Found</body></html>');
    return send(res, 404, `<html><body><h1>Page not found</h1>This page does not exist in ${APP_NAME.replace('&', '&amp;')}.</body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    secrets: new Map([
      ['NEXT_PUBLIC_SUPABASE_URL', url],
      ['NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON],
      ['SUPABASE_SERVICE_ROLE_KEY', SERVER],
    ]),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
