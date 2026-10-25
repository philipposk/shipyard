import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_TIMEOUT_MESSAGE, authTimeoutFetch, gateFetch, isAuthTimeout } from "../src/lib/supabase/auth-fetch.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// A fetch that never answers on its own, only when its signal aborts. Same shape as a hung database.
/** @type {typeof fetch} */
const hanging = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
  });

test("an auth request that hangs fails with the sign-in message", async () => {
  const f = authTimeoutFetch(hanging, 20);
  await assert.rejects(f("https://x.supabase.co/auth/v1/token?grant_type=password"), { message: AUTH_TIMEOUT_MESSAGE });
});

test("storage uploads are passed through untouched", async () => {
  /** @type {RequestInit | undefined} */
  let seen;
  /** @type {typeof fetch} */
  const base = async (_input, init) => {
    seen = init;
    return new Response("ok");
  };
  const init = { method: "PUT" };
  const res = await authTimeoutFetch(base, 20)("https://x.supabase.co/storage/v1/object/upload/sign/a", init);
  assert.equal(await res.text(), "ok");
  assert.equal(seen, init);
});

test("a data read is not timed out by the browser auth wrapper", async () => {
  /** @type {RequestInit | undefined} */
  let seen;
  /** @type {typeof fetch} */
  const base = async (_input, init) => {
    seen = init;
    return new Response("[]");
  };
  const init = { method: "GET" };
  await authTimeoutFetch(base, 20)("https://x.supabase.co/rest/v1/profiles?select=id", init);
  assert.equal(seen, init);
});

test("the proxy gate does time out a data read, and still leaves storage alone", async () => {
  await assert.rejects(gateFetch(hanging, 20)("https://x.supabase.co/rest/v1/profiles?select=id"), /aborted|abort/i);
  /** @type {RequestInit | undefined} */
  let seen;
  /** @type {typeof fetch} */
  const base = async (_input, init) => {
    seen = init;
    return new Response("ok");
  };
  const init = { method: "PUT" };
  await gateFetch(base, 20)("https://x.supabase.co/storage/v1/object/a", init);
  assert.equal(seen, init);
});

test("a caller's own abort still wins", async () => {
  const outer = new AbortController();
  const pending = authTimeoutFetch(hanging, 10_000)(new URL("https://x.supabase.co/auth/v1/user"), { signal: outer.signal });
  outer.abort(new Error("caller gave up"));
  await assert.rejects(pending, { message: "caller gave up" });
});

test("a fast auth answer clears the timer", async () => {
  /** @type {typeof fetch} */
  const base = async () => new Response("{}", { status: 200 });
  const res = await authTimeoutFetch(base, 20)("https://x.supabase.co/auth/v1/token");
  assert.equal(res.status, 200);
});

test("isAuthTimeout recognises the sign-in message and an abort", () => {
  assert.equal(isAuthTimeout({ message: AUTH_TIMEOUT_MESSAGE }), true);
  assert.equal(isAuthTimeout({ name: "AbortError", message: "The operation was aborted" }), true);
  assert.equal(isAuthTimeout({ message: "Invalid login credentials" }), false);
  assert.equal(isAuthTimeout(null), false);
});

test("the app wires the timeouts into the clients, the proxy, the health route and the sign-in page", () => {
  assert.match(read("src/lib/supabase/client.ts"), /authTimeoutFetch\(\)/);
  assert.match(read("src/lib/supabase/server.ts"), /authRequestFetch\(\)/);
  assert.match(read("src/lib/admin.ts"), /authRequestFetch\(\)/);
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /gateFetch\(\)/);
  assert.match(proxy, /AUTH_DEADLINE_MS/);
  assert.match(proxy, /matchesPrefix\(pathname, "\/api\/health"\)/);
  const health = read("src/app/api/health/route.ts");
  assert.match(health, /head:\s*true/);
  assert.match(health, /status:\s*503/);
  assert.match(health, /AbortSignal\.timeout/);
  assert.match(read("src/app/sign-in/page.tsx"), /AUTH_TIMEOUT_MESSAGE/);
});
