// Make the owner's account (the person who made the app) and switch on its admin flag.
//
// Why this exists: an app never trusts an email address to decide who is admin, and it refuses
// sign-ups with the owner's email (starter-mode sign-up does not check that the person owns the
// email, so a stranger could take the owner's address first). So the owner's account is made here,
// on the server side, with the app's secret key, and the admin flag is switched on the same way.
// The owner then gets in through a one-time sign-in link that opens in their own browser.
// Nothing secret is printed: not the link, not any key.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ProvisionError, readAppConfig, originOf } from './common.mjs';
import { parseEnv } from '../lib/secrets.mjs';
import { createSupabase, supabaseFromEnv, randomPassword } from '../verify/supabase.mjs';
import { loadProfile } from '../lib/profile.mjs';

const EMAIL_RE = /^[^\s@'"$#]+@[^\s@'"$#]+\.[^\s@'"$#]+$/;

/** Open a web address in the default browser. Never throws. Resolves true if a program was started. */
export function openInBrowser(target, platform = process.platform) {
  const [cmd, args] =
    platform === 'darwin' ? ['open', [target]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', target]] : ['xdg-open', [target]];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function readEnvLocal(appDir) {
  try {
    return parseEnv(await readFile(path.join(appDir, '.env.local'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
}

/**
 * @param {{ appDir: string, email?: string, url?: string, open?: boolean, resetPassword?: boolean, opener?: (url: string) => Promise<boolean> }} options
 */
export async function makeOwner({ appDir, email, url, open = true, resetPassword = false, opener = openInBrowser }) {
  const config = await readAppConfig(appDir);
  const env = await readEnvLocal(appDir);

  const ownerEmail = String(email ?? env.get('ADMIN_EMAIL') ?? '').trim().toLowerCase();
  if (!ownerEmail) {
    throw new ProvisionError('There is no owner email. Pass --email you@example.com, or set ADMIN_EMAIL in .env.local.');
  }
  if (!EMAIL_RE.test(ownerEmail)) throw new ProvisionError(`"${ownerEmail}" does not look like an email address.`);

  const keys = supabaseFromEnv(env);
  if (!keys.ok) throw new ProvisionError(`Cannot reach this app's database yet: ${keys.reason}.`);
  const sb = createSupabase(keys);
  const fail = (what, detail) => new ProvisionError(`${what}${detail ? ` (${sb.redact(detail)})` : ''}`);

  // 1. The account: reuse it if it exists, otherwise create it with a random password nobody sees.
  const found = await sb.userIdByEmail(ownerEmail);
  if (!found.ok) {
    throw fail('Could not look the owner up. Did the database setup finish? Run provision-supabase.mjs again', found.error);
  }
  let userId = found.id;
  let created = false;
  if (!userId) {
    const made = await sb.createUser(ownerEmail, randomPassword());
    if (!made.ok) throw fail('Could not create the owner account', made.error);
    userId = made.id;
    created = true;
  }

  // An account that already existed might have been made by someone else with the owner's email.
  // --reset-password replaces its password with a random one nobody knows, so only the sign-in link works.
  if (resetPassword && !created) {
    const reset = await sb.setPassword(userId, randomPassword());
    if (!reset.ok) throw fail('Could not reset the password', reset.error);
  }

  // 2. Admin flag, set with the secret key (signed-in people cannot change this column).
  const patched = await sb.rest('profiles', {
    method: 'PATCH',
    query: `id=eq.${encodeURIComponent(userId)}`,
    body: { is_admin: true },
    as: { server: true },
    prefer: 'return=representation',
  });
  if (!patched.ok) throw fail('Could not switch on the admin flag', patched.error);
  if (patched.rows.length === 0) {
    const inserted = await sb.rest('profiles', { method: 'POST', body: { id: userId, is_admin: true }, as: { server: true }, prefer: 'return=representation' });
    if (!inserted.ok) throw fail('Could not create the owner profile', inserted.error);
  }

  // 3. A one-time sign-in link, opened in the owner's browser and never shown.
  const profile = await loadProfile().catch(() => null);
  const known = profile?.apps?.find((a) => a.slug === config.slug);
  const base = originOf(url || known?.url || env.get('NEXT_PUBLIC_SITE_URL') || 'http://localhost:3000');
  let opened = false;
  let linkMade = false;
  if (open) {
    const link = await sb.generateMagicLink(ownerEmail);
    if (link.ok) {
      linkMade = true;
      const target = `${base}/auth/confirm?token_hash=${encodeURIComponent(link.tokenHash)}&type=magiclink&next=${encodeURIComponent('/')}`;
      opened = await opener(target);
    }
  }

  return { ok: true, email: ownerEmail, userId, created, passwordReset: resetPassword && !created, admin: true, site: base, signInLink: linkMade ? (opened ? 'opened' : 'not-opened') : 'skipped' };
}
