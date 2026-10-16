import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOrigin } from "../src/lib/same-origin.mjs";

const h = (obj) => new Headers(obj);

test("same-origin: Origin equal to the request's own origin or the site address passes", () => {
  assert.equal(isSameOrigin(h({ origin: "https://app.example.org" }), "https://app.example.org/api/x", "https://app.example.org"), true);
  assert.equal(isSameOrigin(h({ origin: "https://app.example.org" }), "https://other-host.vercel.app/api/x", "https://app.example.org"), true);
  assert.equal(isSameOrigin(h({ origin: "http://localhost:3000" }), "http://localhost:3000/api/x", "https://app.example.org"), true);
});

test("same-origin: another site, a look-alike or 'null' is refused", () => {
  const req = "https://app.example.org/api/x";
  assert.equal(isSameOrigin(h({ origin: "https://evil.example" }), req, "https://app.example.org"), false);
  assert.equal(isSameOrigin(h({ origin: "https://app.example.org.evil.example" }), req, "https://app.example.org"), false);
  assert.equal(isSameOrigin(h({ origin: "http://app.example.org" }), req, "https://app.example.org"), false);
  assert.equal(isSameOrigin(h({ origin: "null" }), req, "https://app.example.org"), false);
});

test("same-origin: without Origin, only the browser's same-origin hint passes", () => {
  const req = "https://app.example.org/api/x";
  assert.equal(isSameOrigin(h({ "sec-fetch-site": "same-origin" }), req), true);
  assert.equal(isSameOrigin(h({ "sec-fetch-site": "cross-site" }), req), false);
  assert.equal(isSameOrigin(h({}), req), false);
});

test("same-origin: a broken site address does not crash", () => {
  assert.equal(isSameOrigin(h({ origin: "https://app.example.org" }), "https://app.example.org/x", "not a url"), true);
  assert.equal(isSameOrigin(h({ origin: "https://app.example.org" }), "garbage", "also garbage"), false);
});
