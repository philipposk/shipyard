// Check: a real person can sign in and the app accepts their login.
// Makes a throwaway user (server side), signs in, calls the app's /api/profile with the login token,
// signs out and deletes the user. The password is random and never printed.
import { request, joinUrl, pass, failed, skip } from './util.mjs';
import { createSupabase, supabaseFromEnv, randomPassword, randomTestEmail } from './supabase.mjs';
import { sharedProjectGate } from './shared-guard.mjs';

export async function check(ctx) {
  const name = 'auth';
  if (!ctx.url) return skip(name, 'no web address given (pass --url, or deploy first)');
  const env = supabaseFromEnv(ctx.secrets);
  if (!env.ok) return skip(name, env.reason);

  // In a project shared with other apps: the schema setting must be right, and test users only on request.
  const gate = await sharedProjectGate(ctx, env, name);
  if (gate.stop) return gate.stop;

  const sb = createSupabase(env);
  const email = randomTestEmail();
  const password = randomPassword();
  const redact = (s) => sb.redact(s).split(password).join('***');
  const details = [];
  const problems = [];
  let userId = null;
  let token = null;

  try {
    const created = await sb.createUser(email, password);
    if (!created.ok) return failed(name, 'could not create a test user', [`Supabase said: ${redact(created.error)}`, 'Check the keys in .env.local belong to this app\'s Supabase project.']);
    userId = created.id;
    details.push('created a throwaway test user');

    const signedIn = await sb.signIn(email, password);
    if (!signedIn.ok) {
      problems.push(`the test user could not sign in (${redact(signedIn.error)})`);
    } else {
      token = signedIn.accessToken;
      details.push('test user signed in');

      // The app accepts the token and returns this user.
      const me = await request(joinUrl(ctx.url, '/api/profile'), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      let body = null;
      try {
        body = JSON.parse(me.text);
      } catch {
        body = null;
      }
      if (me.status === 0) problems.push(`the app did not answer /api/profile (${me.error})`);
      else if (me.status !== 200) {
        const hint = me.status >= 300 && me.status < 400 ? ' (it redirected; the bearer-token path in proxy.ts may be broken)' : '';
        problems.push(`/api/profile answered ${me.status} for a signed-in user${hint}`);
      } else if (body?.user?.id !== userId) {
        problems.push('/api/profile answered 200 but for a different user than the one that signed in');
      } else {
        details.push('the app recognises the signed-in user');
        if (body.profile && body.profile.id === userId) details.push('the profile row was created automatically at sign-up');
        else if (env.schema && env.schema !== 'public') problems.push('the signed-in user has no profile row (in a shared project the app must create it itself, with ensureProfile, the first time it needs it)');
        else problems.push('the signed-in user has no profile row (the database trigger from migration 0001 did not run)');
      }
    }

    // Signed out and bad logins must be refused with a clean 401, not a page or a crash.
    const anon = await request(joinUrl(ctx.url, '/api/profile'), { headers: { accept: 'application/json' } });
    if (anon.status === 401) details.push('no login means 401');
    else if (anon.status !== 0) problems.push(`/api/profile answered ${anon.status} with no login, expected 401`);
    else problems.push(`the app did not answer (${anon.error})`);

    const bad = await request(joinUrl(ctx.url, '/api/profile'), {
      headers: { authorization: 'Bearer not-a-real-token', accept: 'application/json' },
    });
    if (bad.status === 401) details.push('a wrong login token means 401');
    else if (bad.status !== 0) problems.push(`/api/profile answered ${bad.status} for a fake token, expected 401`);

    if (token) {
      const out = await sb.signOut(token);
      if (out.ok) details.push('test user signed out');
      else problems.push(`sign-out failed (${redact(out.error)})`);
    }
  } catch (err) {
    problems.push(`stopped early: ${redact(err?.message ?? 'unknown error')}`);
  } finally {
    if (userId) {
      const gone = await sb.deleteUser(userId).catch((e) => ({ ok: false, error: e?.message ?? 'failed' }));
      if (gone.ok) details.push('test user deleted');
      else problems.push(`the test user was NOT deleted (${email}). Remove it in Supabase > Authentication > Users`);
    }
  }

  if (problems.length > 0) return failed(name, `${problems.length} problem${problems.length === 1 ? '' : 's'} with sign-in`, problems, { details, warnings: gate.warnings });
  return pass(name, 'sign-in works end to end', details, { warnings: gate.warnings });
}
