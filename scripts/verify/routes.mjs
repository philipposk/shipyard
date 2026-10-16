// Check: the public pages exist, the 404 page is the app's own, and the sign-up route answers.
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

  if (problems.length > 0) return failed(name, `${problems.length} problem${problems.length === 1 ? '' : 's'} found`, problems, { details });
  return pass(name, `${PAGES.length} pages, the 404 page and the sign-up route all work`, details);
}
