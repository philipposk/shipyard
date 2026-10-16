import { test } from "node:test";
import assert from "node:assert/strict";
import { hasAuthCookie, isAuthCookieName } from "../src/lib/supabase/auth-cookie.mjs";

const NAME = "sb-my-app-auth";

test("the login cookie matches by its exact name", () => {
  assert.equal(isAuthCookieName(NAME, NAME), true);
  assert.equal(hasAuthCookie([{ name: NAME }], NAME), true);
});

test("large logins are split into numbered parts and still match", () => {
  assert.equal(isAuthCookieName(`${NAME}.0`, NAME), true);
  assert.equal(isAuthCookieName(`${NAME}.12`, NAME), true);
  assert.equal(hasAuthCookie([{ name: "theme" }, { name: `${NAME}.1` }], NAME), true);
});

test("cookies from other apps or other purposes do not match", () => {
  assert.equal(hasAuthCookie([], NAME), false);
  assert.equal(isAuthCookieName("sb-other-app-auth", NAME), false);
  assert.equal(isAuthCookieName(`${NAME}-token`, NAME), false);
  assert.equal(isAuthCookieName(`${NAME}.x`, NAME), false);
  assert.equal(isAuthCookieName(`x${NAME}`, NAME), false);
});

test("dots in the app name are not treated as wildcards", () => {
  assert.equal(isAuthCookieName("sb-myXapp-auth", "sb-my.app-auth"), false);
  assert.equal(isAuthCookieName("sb-my.app-auth", "sb-my.app-auth"), true);
});
