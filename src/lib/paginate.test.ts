import assert from "node:assert/strict";
import { test } from "node:test";
import { pageSlice } from "./paginate.ts";

const nums = Array.from({ length: 10 }, (_, i) => i);

test("pageSlice returns the requested page", () => {
  const p = pageSlice(nums, 1, 4);
  assert.deepEqual(p.items, [4, 5, 6, 7]);
  assert.equal(p.page, 1);
  assert.equal(p.pages, 3);
  assert.equal(p.total, 10);
});

test("pageSlice clamps a too-high page to the last one", () => {
  const p = pageSlice(nums, 99, 4);
  assert.deepEqual(p.items, [8, 9]);
  assert.equal(p.page, 2);
});

test("pageSlice clamps a negative page to the first one", () => {
  const p = pageSlice(nums, -3, 4);
  assert.deepEqual(p.items, [0, 1, 2, 3]);
  assert.equal(p.page, 0);
});

test("pageSlice reports one empty page for an empty list", () => {
  const p = pageSlice([], 0, 4);
  assert.deepEqual(p.items, []);
  assert.equal(p.page, 0);
  assert.equal(p.pages, 1);
  assert.equal(p.total, 0);
});

test("pageSlice reports a single page when the list fits", () => {
  const p = pageSlice([1, 2, 3], 0, 4);
  assert.equal(p.pages, 1);
  assert.deepEqual(p.items, [1, 2, 3]);
});
