import assert from "node:assert/strict";
import { test } from "node:test";
import { barHeightPercent } from "./chart.ts";

test("barHeightPercent scales a value against the max", () => {
  assert.equal(barHeightPercent(50, 100), 50);
  assert.equal(barHeightPercent(100, 100), 100);
});

test("barHeightPercent floors a positive day at a visible 1.5%", () => {
  assert.equal(barHeightPercent(1, 1000), 1.5);
});

test("barHeightPercent gives a zero day a 0.5% hairline", () => {
  assert.equal(barHeightPercent(0, 100), 0.5);
});

test("barHeightPercent returns the hairline when nothing was spent all month", () => {
  assert.equal(barHeightPercent(0, 0), 0.5);
});
