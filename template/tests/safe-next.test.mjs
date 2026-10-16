import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "../src/lib/safe-next.mjs";

test("same-site paths are kept", () => {
  assert.equal(safeNext("/items"), "/items");
  assert.equal(safeNext("/items?page=2#top"), "/items?page=2#top");
  assert.equal(safeNext("/a/b/c"), "/a/b/c");
});

test("missing or empty values use the fallback", () => {
  assert.equal(safeNext(null), "/");
  assert.equal(safeNext(undefined), "/");
  assert.equal(safeNext(""), "/");
  assert.equal(safeNext(null, "/home"), "/home");
});

test("links to other sites are refused", () => {
  for (const bad of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "evil.example",
    "@evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
  ]) {
    assert.equal(safeNext(bad), "/", `should refuse ${JSON.stringify(bad)}`);
  }
});

test("the sign-in page is never the destination", () => {
  assert.equal(safeNext("/sign-in"), "/");
  assert.equal(safeNext("/sign-in?next=/items"), "/");
  assert.equal(safeNext("/sign-in-help"), "/sign-in-help");
});

test("very long values are refused", () => {
  assert.equal(safeNext(`/${"a".repeat(3000)}`), "/");
});

test("non-strings are refused", () => {
  assert.equal(safeNext(42), "/");
  assert.equal(safeNext({}), "/");
});
