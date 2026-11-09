# Shared Supabase project: auth troubleshooting

When several apps share one Supabase project, sign-in belongs to the project, not to one app. A trigger or a Site URL change made for one app can break sign-in for the others. Check that before changing app code.

## When sign-in says "invalid credentials" or every page returns to /sign-in

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/supabase-health.mjs" <project-ref>`. The database, sign-in service and data API are reported separately. `/auth/v1/health` answering 200 does not mean the database is up.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/supabase-health.mjs" <project-ref> --auth-triggers`. It lists trigger names on the shared sign-in table and whether each definition mentions `encrypted_password`. It does not print addresses or passwords. A trigger that sets `encrypted_password` when `email_confirmed_at` becomes non-null will empty the password of every account created with confirm and password in one call.
3. Look at the project's Site URL in the Supabase dashboard. There is one Site URL per project. An emailed link that does not pass this app's own confirm address lands on whichever app set the Site URL last.

The script reads the access token from the Shipyard keys file. Do not grep that file, do not put the token in a command, and do not query `auth.users` for addresses.

## Rules for apps on a shared project

- Starter sign-up confirms the account first and sets the password in a second `updateUserById` call (`template/src/lib/auth/server-signup.ts`). If the password call fails, that user is deleted. Do not pass `password` and `email_confirm: true` in one `createUser`.
- Verified sign-up still uses `signUp` with `emailRedirectTo: confirmRedirectUrl(SITE_URL)`, which is this app's `/auth/confirm`. That redirect is required. Do not turn it off. Password sign-in does not depend on the Site URL.
- An `AFTER INSERT` trigger that creates this app's profile row is expected. A trigger that writes `encrypted_password` or `email`, or that raises for another app's update, is not.
- "Error sending confirmation email" on sign-up usually means the project has no SMTP yet. Starter mode (admin create, already confirmed, no mail) is the path until email is set up.
- The sign-in user is shared. Deleting the account from one app removes that app's rows only (`ACCOUNT_DATA_TABLES`). Do not delete the sign-in user while other apps use it.

## Restart

`supabase-health.mjs <project-ref> --restart` asks Supabase to restart the project. It takes about 5 minutes and does not refill a used-up disk IO budget. Ask the owner before passing `--restart`.
