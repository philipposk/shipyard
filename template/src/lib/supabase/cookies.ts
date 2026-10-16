import { hasAuthCookie as hasCookie } from "./auth-cookie.mjs";

const isProd = process.env.NODE_ENV === "production";

/**
 * Login cookie settings shared by the browser, server and proxy clients. They must all agree, or sign-in
 * looks like it worked but the next page thinks you are signed out.
 * The name is unique per app and there is no `domain`, so the cookie belongs to this app's address only.
 */
export const AUTH_COOKIE_NAME = "sb-<APP_SLUG>-auth";

export const authCookieOptions = {
  name: AUTH_COOKIE_NAME,
  sameSite: "lax" as const,
  secure: isProd,
  path: "/",
};

export function hasAuthCookie(cookies: { name: string }[]): boolean {
  return hasCookie(cookies, AUTH_COOKIE_NAME);
}
