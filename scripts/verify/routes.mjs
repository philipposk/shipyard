// Check: the public pages exist, the 404 page is the app's own, the sign-up route answers, and a signed-out
// API call gets 401 JSON instead of a redirect to sign-in.
import { request, joinUrl, locationPath, decodeEntities, resolveAppName, pass, failed, skip } from './util.mjs';
import { randomBytes } from 'node:crypto';

export const PAGES = [
  '/', '/about', '/help', '/privacy', '/terms', '/sign-in',
  '/manifest.webmanifest', '/icon.svg', '/robots.txt', '/sitemap.xml', '/llms.txt',
];

// Words the scaffold step replaces. If one is still on a page, the app was not set up fully.
const PLACEHOLDER = /APP_(?:SLUG|NAME|SHORT_NAME|DESCRIPTION|TAGLINE|LAYOUT)/;
const TEXT_PAGES = new Set(['/', '/about', '/help', '/privacy', '/terms', '/sign-in', '/manifest.webmanifest']);

async function checkPage(url, pathname) {
  const res = await request(joinUrl(url, pathname));
  if (res.status === 0) return { pathname, ok: false, why: res.error };
  if (res.status >= 300 && res.status < 400) {
    return { pathname, ok: false, why: `sends visitors to ${locationPath(res.location, url)} instead of showing the page` };
  }
  if (res.status !== 200) return { pathname, ok: false, why: `answered ${res.status}, expected 200` };
  if (TEXT_PAGES.has(pathname) && PLACEHOLDER.test(res.text)) {
    return { pathname, ok: false, why: 'still contains a setup placeholder like APP_NAME (the app was not fully set up)' };
  }
  if (pathname === '/manifest.webmanifest') {
    try {
      const manifest = JSON.parse(res.text);
      if (!manifest?.name) return { pathname, ok: false, why: 'the manifest has no app name' };
    } catch {
      return { pathname, ok: false, why: 'is not valid JSON' };
    }
  }
  return { pathname, ok: true };
}

/**
 * How a signed-out call to an API route was answered. A redirect is a real bug: fetch follows it, gets the
 * sign-in page with status 200, and the app thinks the call worked. Returns { problem } or { detail }. Pure.
 */
export function signedOutApi(res, base) {
  const where = 'a signed-out API call';
  if (res.status === 0) return { problem: `${where}: ${res.error}` };
  if (res.status >= 300 && res.status < 400) {
    return { problem: `${where} is sent to ${locationPath(res.location, base)} instead of getting 401 JSON. In src/proxy.ts, answer /api/* without a login with NextResponse.json({ error: "Unauthorized" }, { status: 401 }): fetch follows the redirect, gets a 200 page and the app thinks the call worked` };
  }
  if (res.status >= 200 && res.status < 300) return { problem: `${where} answered ${res.status}. API routes need a login (401 JSON) unless they are listed as public` };
  if (res.status === 401 || res.status === 403) {
    const json = /json/i.test(res.headers?.get?.('content-type') ?? '') || (() => { try { JSON.parse(res.text); return true; } catch { return false; } })();
    if (json) return { detail: `signed-out API calls get ${res.status} JSON` };
    if (/vercel\.com\/sso-api|Authentication Required/i.test(res.text)) return { detail: 'signed-out API calls are stopped by Vercel Deployment Protection (see the protection check)' };
    return { problem: `${where} answered ${res.status} with a page instead of JSON, so the app's own code cannot read the error. Answer with JSON` };
  }
  if (res.status === 404) return { detail: 'unknown API paths answer 404 before any login check, so every API route must check the login itself' };
  return { problem: `${where} answered ${res.status}, expected 401 JSON` };
}

/** Is `res` a 404 page that mentions the app by name? */
function styled404(res, appName) {
  if (res.status !== 404) return { ok: false, why: `answered ${res.status}, expected 404` };
  if (!appName) return { ok: true, note: 'the app name is unknown, so the page text was not checked' };
  if (!decodeEntities(res.text).includes(appName)) {
    return { ok: false, why: `answered 404 but the page does not mention "${appName}" (it is not the app's own 404 page)` };
  }
  return { ok: true };
}

export async function check(ctx) {
  const name = 'routes';
  if (!ctx.url) return skip(name, 'no web address given (pass --url, or deploy first)');

  const details = [];
  const problems = [];

  const results = await Promise.all(PAGES.map((p) => checkPage(ctx.url, p)));
  for (const r of results) if (!r.ok) problems.push(`${r.pathname}: ${r.why}`);
  const okCount = results.filter((r) => r.ok).length;
  details.push(`${okCount} of ${PAGES.length} pages answer correctly`);

  // A page that does not exist must show the app's own 404 page.
  const appName = await resolveAppName(ctx);
  const junk = `/this-page-does-not-exist-${randomBytes(4).toString('hex')}`;
  let probe = await request(joinUrl(ctx.url, junk));
  let verdict;
  if (probe.status >= 300 && probe.status < 400 && /^\/sign-in/.test(locationPath(probe.location, ctx.url))) {
    // The login gate catches unknown pages for signed-out visitors. A path ending in .txt skips the gate,
    // so it shows the real 404 page.
    probe = await request(joinUrl(ctx.url, `${junk}.txt`));
    verdict = styled404(probe, appName);
    if (verdict.ok) details.push('unknown pages send signed-out visitors to sign-in; the 404 page itself is the app\'s own');
  } else {
    verdict = styled404(probe, appName);
  }
  if (!verdict.ok) problems.push(`404 page: ${verdict.why}`);
  else if (verdict.note) details.push(`404 page: ${verdict.note}`);
  else if (!details.some((d) => d.includes('404 page'))) details.push('404 page shows the app name');

  // The sign-up route must exist and answer an OPTIONS request (a 405 means the route is missing or blocked).
  const options = await request(joinUrl(ctx.url, '/api/auth/signup'), { method: 'OPTIONS' });
  if (options.status === 0) problems.push(`/api/auth/signup: ${options.error}`);
  else if (options.status === 405 || options.status === 404) problems.push(`/api/auth/signup: OPTIONS answered ${options.status}, so the route is missing or blocked`);
  else details.push('sign-up route answers');

  // A made-up API path: the login gate answers before any route exists, so this tests the gate itself.
  const api = signedOutApi(await request(joinUrl(ctx.url, `/api/shipyard-signed-out-${randomBytes(4).toString('hex')}`)), ctx.url);
  if (api.problem) problems.push(api.problem);
  else details.push(api.detail);

  if (problems.length > 0) return failed(name, `${problems.length} problem${problems.length === 1 ? '' : 's'} found`, problems, { details });
  return pass(name, `${PAGES.length} pages, the 404 page, the sign-up route and the API login gate all work`, details);
}
