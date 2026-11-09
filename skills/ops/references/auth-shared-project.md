# Shared Supabase project: auth troubleshooting

When several apps share one Supabase project, auth belongs to the project, not to any
single app. A change made by one app can silently break sign-in for every other app.
This page is the diagnostic runbook. It was written from a real incident (9 Nov 2026):
a trigger installed by one app wiped the passwords of every account on the project.

## The incident and the symptom chain

1. A different app installed `clear_password_on_first_confirm`, a BEFORE UPDATE trigger on
   `auth.users` that sets `encrypted_password := ''` whenever `email_confirmed_at` goes
   from NULL to set.
2. `admin.auth.admin.createUser({ email_confirm: true, password })` confirms the email in the
   same call, so the trigger emptied the password of every account created that way.
3. Later changes re-triggered it for existing users, so even the app owner's password ended
   up empty (`length(encrypted_password) = 0`).
4. The owner's symptom: sessions expire after ~1 hour, sign-in fails with "invalid
   credentials", and every page bounces to /sign-in. It looked like "my data disappeared".
   The data was fine; the login was gone.

## If "everything redirects to sign-in" or "invalid credentials"

Check auth state BEFORE touching app code:

1. `last_sign_in_at` and `length(encrypted_password)` per account (see queries below).
2. Is the trigger present? `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass ...`
   shows every app's trigger on the shared users table.
3. Is the project's Site URL pointing at another app? (See below.)

## Queries without psql

The Supabase Management API runs raw SQL with `SUPABASE_ACCESS_TOKEN`
(the same token Shipyard stores). PostgREST on a non-public schema needs the
`Accept-Profile: <schema>` header.

```bash
TOKEN=$(grep -oE "^SUPABASE_ACCESS_TOKEN=.*" ~/.shipyard/secrets.env | cut -d= -f2-)
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select email, email_confirmed_at is not null as confirmed, length(encrypted_password) as pwlen, last_sign_in_at from auth.users order by created_at desc limit 10;"}'
```

Triggers on the shared users table (each row is one app's hook):

```sql
select tgname, pg_get_triggerdef(oid)
from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal;
```

## Rules for apps on a shared project

- **Never create a user with a password and confirmation in one call.** Split it:
  `createUser({ email, email_confirm: true })` (no password), then
  `updateUserById(id, { password })` in a second call. The second call does not change
  `email_confirmed_at`, so the trigger cannot fire. MindScope's sign-up route is the
  reference implementation.
- **Never rely on redirect-based auth flows.** A Supabase project has ONE Site URL.
  On a shared project it points at whichever app set it last, so magic links and email
  confirmations land on the wrong app. Password sign-in (and explicit `redirect_to` to the
  app's own `/auth/confirm`) is the safe path. If a link must be emailed, generate it via
  `admin.generateLink` and pass the app's own confirm URL as `redirect_to`.
- **Audit `auth.users` triggers after any app joins the project.** Each app's migration may
  add an `AFTER INSERT` hook that creates its profile row. That is expected. But any trigger
  that UPDATES `NEW.encrypted_password`, `NEW.email` or raises on unrelated conditions
  breaks every other app.
- **"Error sending confirmation email" / `unexpected_failure` on sign-up** usually means no
  SMTP is configured for the project. Starter-mode sign-ups (admin `createUser` with
  `email_confirm: true`) are the workable path until email is set up.
- **The sign-in user is shared, so never delete it from one app.** Account deletion flows on
  a shared project remove only that app's rows (see the app's `ACCOUNT_DATA_TABLES`).
