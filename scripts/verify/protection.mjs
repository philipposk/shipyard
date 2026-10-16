// Check: the public site is really public. Vercel can put a login wall in front of a new project.
import { request, joinUrl, pass, failed, skip } from './util.mjs';

const WALL = /vercel\.com\/(?:sso|login)|_vercel_sso_nonce|Authentication Required/i;

export async function check(ctx) {
  const name = 'protection';
  if (!ctx.url) return skip(name, 'no web address given (pass --url, or deploy first)');

  const res = await request(joinUrl(ctx.url, '/'), { redirect: 'follow' });
  if (res.status === 0) return failed(name, 'could not reach the site', [res.error]);

  const redirectedToVercel = /vercel\.com\/(?:sso|login)/i.test(res.url ?? '');
  const setsSsoCookie = /_vercel_sso_nonce/.test(res.headers.get('set-cookie') ?? '');
  const wallPage = res.status === 401 || WALL.test(res.text.slice(0, 20_000));
  if (redirectedToVercel || setsSsoCookie || (wallPage && (res.status === 401 || res.status === 403))) {
    return failed(name, 'Vercel is asking visitors to log in', [
      'Anyone who opens the link sees a Vercel login page instead of your app.',
      'Fix: Vercel dashboard > your project > Settings > Deployment Protection > turn Vercel Authentication off for Production.',
    ]);
  }
  if (res.status === 401 || res.status === 403) {
    return failed(name, `the home page answers ${res.status}`, ['Visitors are being refused. Check the project settings on Vercel.']);
  }
  return pass(name, 'the site is open to everyone', []);
}
