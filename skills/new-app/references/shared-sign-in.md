# One sign-in across apps on subdomains (Supabase)

Use when several apps live on subdomains of one domain (`app1.<domain>`, `app2.<domain>`) and people should sign in once for all of them.

## Requirements

- **One Supabase project** for all the apps (see `shared-project.md`): same users table, same session. Different projects can never share a session.
- **Cookies, not localStorage.** localStorage belongs to one exact origin, so `app1.<domain>` cannot read `app2.<domain>`'s. Use `@supabase/ssr` (`createBrowserClient`, `createServerClient` and the proxy), which stores the session in cookies.
- **The same cookie options in every app and in every client** (browser, server, proxy):

```ts
const isProd = process.env.NODE_ENV === "production";
export const authCookieOptions = {
  name: "sb-<shared-name>-auth",          // identical in every app
  ...(isProd ? { domain: ".<domain>" } : {}), // prod only: localhost and *.vercel.app previews must not get it
  sameSite: "lax" as const,
  secure: isProd,
  path: "/",
};
// createBrowserClient(url, key, { cookieOptions: authCookieOptions }) and the same in createServerClient
```

A name or domain that differs between apps, or between an app's own browser and server clients, makes sign-in look fine and then forget the user on the next page.

## Supabase and Google settings

- Auth > URL configuration: add every app's `https://appN.<domain>/**` to the redirect allow-list (a wildcard `https://*.<domain>/**` also works). The Site URL stays the main app.
- Google OAuth client: add each app's origin to Authorized JavaScript origins; the redirect URI stays the Supabase callback.

## Tell the student first

- **One-time logout**: switching an existing app from its own cookie name to the shared one signs current users out once. Say so before merging.
- **Signed in everywhere**: anyone signed in to one app is signed in to all. An app that needs extra setup (a profile, age check, consent, a paid plan) must check for it on its own, server-side, and send the person through onboarding instead of assuming a signed-in user is ready.

## Data kept on the device (offline copies, caches, outboxes)

The shared cookie means the session can change under an open tab: signing in as a different account in any app on the domain switches every open tab of every app, and those tabs get no sign-in event. An app that keeps people's data on the device for offline use must handle that, or it saves one account's data into the other's copy. Real case (Sparks, November 2026): a second Google account signed in to another app on the domain; an open Sparks tab synced as that empty account, was told "no notes", and removed all 414 notes from the laptop's offline copy. The server copy was fine, but the laptop showed one note until the app was fixed.

- **Keep each account's data apart**: name the local database after the user id (`<app>-<userId>`), never one shared store.
- **Check the account before every sync and every queued write**: read the session, and if its user id is not the one the open copy belongs to, stop and open that account's own copy. With no session, wait (keep the outbox) instead of sending and counting failures.
- **Send each sync request as the account you checked**: `.setHeader("Authorization", \`Bearer ${token}\`)` on the query (and `supabase.storage.from(bucket).setHeader(...)`). supabase-js keeps a header you set; otherwise a request that leaves a moment later goes out as whoever the cookie says by then.
- **Only delete local rows against a list you know is this account's.** An empty list from the wrong account (or a failed request treated as empty) wipes the whole copy.
- **A "changed since" sync must also heal**: if a row is ever dropped locally by mistake, a cursor-based pull never brings it back. Each pull compares the server's list of ids with the local one and fetches the missing rows by id (about 100 ids per request).
- **Switching accounts waits for the sync in flight** (with a time cap), and a sync that started before the switch drops what it gets instead of saving it into the new account's copy (a counter bumped when the new copy opens). Never throw between merging rows into memory and saving them to the device, or the two drift apart and an old version comes back after a reload.
- **Signed-out requests must fail, not return nothing**: grant the app's tables to `authenticated` only (no `anon` select), so a request without a session gets 401 and the sync stops instead of seeing an empty list.

## One person, two accounts

Supabase joins Google and email sign-in for the same verified address into one account. A different Google account (work instead of personal) or Apple's "Hide My Email" makes a second, empty account, and the person thinks their data is gone. Show the signed-in email where it is easy to see (settings or the account menu), and say on the sign-in page which account to use if there are several.

## Telling people how to reset one app

The browser's "Clear site data" treats every app on `*.<domain>` as one site: it wipes every app's saved data and signs the person out of all of them, including writes that were waiting to sync. To reset one app's offline copy, delete only its own database (DevTools > Application > IndexedDB) or add a "Reset this device's copy" button that does it, after checking nothing is waiting to sync.

## When to keep a separate auth project

Keep an app on its own project when it holds outside parties' business data (a company's accounting, clients' records, anything under a data-processing agreement), has different legal or residency rules, or its users are a different audience (staff accounts of a business). Merging projects later means migrating every account and its data; give it the same-looking sign-in button instead.
