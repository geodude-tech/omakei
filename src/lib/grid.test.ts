import assert from "node:assert/strict";
import { test } from "node:test";
import { trailingCellSpan } from "./grid.ts";

test("trailingCellSpan fills the rest of a partly-full row", () => {
  // 3 cells, 4 columns: the 3rd cell has 2 ahead of it, 2 slots left.
  assert.equal(trailingCellSpan(3, 4), 2);
  assert.equal(trailingCellSpan(2, 4), 3);
  assert.equal(trailingCellSpan(1, 4), 4);
});

test("trailingCellSpan is 1 when the last cell already ends a row", () => {
  assert.equal(trailingCellSpan(4, 4), 1);
  assert.equal(trailingCellSpan(8, 4), 1);
  assert.equal(trailingCellSpan(2, 2), 1);
});

test("trailingCellSpan spans a whole row when the last cell starts one", () => {
  assert.equal(trailingCellSpan(5, 4), 4);
  assert.equal(trailingCellSpan(3, 2), 2);
});
