import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelCustomerSubscriptions } from "../src/lib/billing/account.mjs";

function fakeStripe(pages, { failOn } = {}) {
  const calls = { list: [], cancel: [] };
  return {
    calls,
    subscriptions: {
      async list(params) {
        calls.list.push(params);
        return pages[calls.list.length - 1] ?? { data: [], has_more: false };
      },
      async cancel(id, params) {
        if (id === failOn) throw new Error("stripe said no");
        calls.cancel.push([id, params]);
        return { id, status: "canceled" };
      },
    },
  };
}

test("cancels every live subscription of the customer and leaves finished ones alone", async () => {
  const stripe = fakeStripe([
    { data: [{ id: "sub_1", status: "active" }, { id: "sub_2", status: "canceled" }, { id: "sub_3", status: "past_due" }, { id: "sub_4", status: "incomplete_expired" }], has_more: false },
  ]);
  const done = await cancelCustomerSubscriptions(stripe, "cus_1");
  assert.deepEqual(done, ["sub_1", "sub_3"]);
  assert.equal(stripe.calls.list[0].customer, "cus_1");
  assert.equal(stripe.calls.list[0].status, "all");
  // Nothing is invoiced or refunded when an account is deleted.
  assert.deepEqual(stripe.calls.cancel[0][1], { prorate: false, invoice_now: false });
});

test("follows pages of subscriptions", async () => {
  const stripe = fakeStripe([
    { data: [{ id: "sub_a", status: "active" }], has_more: true },
    { data: [{ id: "sub_b", status: "trialing" }], has_more: false },
  ]);
  assert.deepEqual(await cancelCustomerSubscriptions(stripe, "cus_1"), ["sub_a", "sub_b"]);
  assert.equal(stripe.calls.list[1].starting_after, "sub_a");
});

test("does nothing for a customer without subscriptions", async () => {
  assert.deepEqual(await cancelCustomerSubscriptions(fakeStripe([{ data: [], has_more: false }]), "cus_1"), []);
});

test("throws when Stripe refuses, so the account is not deleted while still being charged", async () => {
  const stripe = fakeStripe([{ data: [{ id: "sub_1", status: "active" }], has_more: false }], { failOn: "sub_1" });
  await assert.rejects(() => cancelCustomerSubscriptions(stripe, "cus_1"), /stripe said no/);
});
