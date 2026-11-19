# Sign-in and sign-up: pending state (required)

Every sign-in or sign-up control (Google, Apple, GitHub, magic link, email and password) must protect against a double submit. Google's account chooser stays on screen for a few seconds, and people click again. A second click opens a second popup, starts a second session exchange, or sends a second email. This is the standard pattern (the same one payment buttons use). It is a required part of a build and of a review.

## The pattern

1. **Pending state on the first click.** Set it synchronously, in the click handler, before any `await`.
2. **A ref guard as well as state.** `if (pendingRef.current) return; pendingRef.current = true; setPending(...)`. State alone is not enough: a fast second click can arrive before React re-renders.
3. **Disable everything, not only the button clicked.** Every provider button and the email form's submit are disabled while one sign-in is pending (`disabled`, plus `aria-busy="true"` on the active one). Two different providers must not run at once. For a control you cannot disable (Google's iframe button), cover it with a same-size overlay or wrap the area in `inert`.
4. **Show it.** A spinner and a short label ("Signing in…", "Signing up…") inside the same box as the idle button, so nothing shifts. Keep the app's own button styling. Respect `prefers-reduced-motion` (slow the spinner, never remove the label).
5. **Stay pending until the browser leaves.** After success, do not clear the state: the page is about to navigate (`window.location.assign/replace`, `router.push`), and clearing it re-enables the button for a moment. Only clear it when the person stays on the page.
6. **Release it when the person stays.**
   - On error (show the message, then clear).
   - When the Google popup or chooser is closed without a credential. GIS has no cancel event: when the window regains focus and no credential arrives within about 1.5 seconds, clear it (the template does this), and add a hard cap (about 2 minutes).
   - On `pageshow` with `event.persisted` (the back button restores the page from the back/forward cache with the old pending state).
   - A redirect flow (`signInWithOAuth`) that has not left after about 15 to 20 seconds.
7. **The return screen.** The page Google or an email link sends people back to must not show the sign-in form again while the session is exchanged. If the callback is a route handler that redirects, there is nothing to click. If it is a page, render only "Signing you in…" (a spinner, `role="status"`) until it redirects, and show the form again only on failure, with the error.

## Google Identity Services (popup) specifics

- `renderButton` draws Google's own iframe: pass `click_listener` to learn of a click, then cover the slot with the pending overlay.
- Keep the iframe mounted (`visibility: hidden`), not removed, while pending.
- A sign-in that fails inside the callback (`signInWithIdToken` error) clears the pending state and shows the error.

## Template

`template/src/components/GoogleIdentityButton.tsx` and `template/src/app/sign-in/page.tsx` implement all of this. Copy them as they are; for a new provider button, follow the same six rules. The redirect fallback button inside `GoogleIdentityButton` is covered too: on failure call `window.dispatchEvent(new Event("auth:release"))`.

## Check it

- In a browser: click the provider button twice quickly. One popup or one redirect, button shows the spinner and label, the other controls are disabled.
- Close the Google popup: the button comes back.
- After signing in, press Back: the button is not stuck.
- With a screen reader or `getByRole('status')`: the pending text is announced once.
