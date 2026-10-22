import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAll, PAGE_SIZE } from "../src/lib/paginate.mjs";

/** A fake table of `total` rows that, like Supabase, returns at most 1000 rows per request. */
function table(total) {
  const calls = [];
  const fetchPage = async (from, to) => {
    calls.push([from, to]);
    const end = Math.min(to, from + 999, total - 1);
    const data = [];
    for (let i = from; i <= end; i++) data.push(i);
    return { data, error: null };
  };
  return { fetchPage, calls };
}

test("fetchAll: reads past the 1000 row cap", async () => {
  const { fetchPage, calls } = table(2500);
  const { data, error, truncated } = await fetchAll(fetchPage);
  assert.equal(error, null);
  assert.equal(truncated, false);
  assert.equal(data.length, 2500);
  assert.deepEqual(data.slice(998, 1002), [998, 999, 1000, 1001]);
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(PAGE_SIZE, 1000);
});

test("fetchAll: an exact multiple of the page size ends on an empty page", async () => {
  const { fetchPage, calls } = table(2000);
  const { data } = await fetchAll(fetchPage);
  assert.equal(data.length, 2000);
  assert.equal(calls.length, 3);
});

test("fetchAll: an empty table and null data give no rows", async () => {
  assert.deepEqual((await fetchAll(async () => ({ data: null, error: null }))).data, []);
  assert.deepEqual((await fetchAll(table(0).fetchPage)).data, []);
});

test("fetchAll: an error stops the read and is returned", async () => {
  let n = 0;
  const { data, error } = await fetchAll(async () => (++n === 2 ? { data: null, error: { message: "boom" } } : { data: new Array(1000).fill(1), error: null }));
  assert.equal(error.message, "boom");
  assert.equal(data.length, 1000);
});

test("fetchAll: maxRows is a safety stop and says it truncated", async () => {
  const { data, truncated } = await fetchAll(table(10_000).fetchPage, { pageSize: 1000, maxRows: 3000 });
  assert.equal(data.length, 3000);
  assert.equal(truncated, true);
});
