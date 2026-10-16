import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeleteConfirmation, runPreDeleteHooks } from "../src/lib/account/run-hooks.mjs";

const ctx = { userId: "u1", email: "a@example.org" };

test("hooks run in order and get the person", async () => {
  const seen = [];
  const hooks = [
    { id: "one", label: "do one", run: async (c) => void seen.push(["one", c.userId]) },
    { id: "two", label: "do two", run: async (c) => void seen.push(["two", c.email]) },
  ];
  const r = await runPreDeleteHooks(hooks, ctx);
  assert.deepEqual(r, { ok: true, ran: ["one", "two"] });
  assert.deepEqual(seen, [["one", "u1"], ["two", "a@example.org"]]);
});

test("no hooks is fine", async () => {
  assert.deepEqual(await runPreDeleteHooks([], ctx), { ok: true, ran: [] });
});

test("a failing hook stops everything after it and says which one failed", async () => {
  let third = false;
  const hooks = [
    { id: "a", label: "tidy a", run: async () => {} },
    { id: "b", label: "cancel your subscription", run: async () => { throw new Error("Stripe said no"); } },
    { id: "c", label: "tidy c", run: async () => { third = true; } },
  ];
  const r = await runPreDeleteHooks(hooks, ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ran, ["a"]);
  assert.equal(r.failed.id, "b");
  assert.equal(r.failed.label, "cancel your subscription");
  assert.match(r.failed.error, /Stripe said no/);
  assert.equal(third, false);
});

test("a hook that throws synchronously also counts as a failure", async () => {
  const r = await runPreDeleteHooks([{ id: "x", label: "x", run: () => { throw new Error("boom"); } }], ctx);
  assert.equal(r.ok, false);
  assert.equal(r.failed.error, "boom");
});

test("a hook that never finishes is cut off", async () => {
  const r = await runPreDeleteHooks([{ id: "slow", label: "wait", run: () => new Promise(() => {}) }], ctx, { timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.failed.error, /took longer/);
});

test("the typed confirmation is the word DELETE, in any case", () => {
  for (const ok of ["DELETE", "delete", "  Delete "]) assert.equal(isDeleteConfirmation(ok), true);
  for (const bad of ["", "del", "DELETE ME", undefined, null, 5, true]) assert.equal(isDeleteConfirmation(bad), false);
});
