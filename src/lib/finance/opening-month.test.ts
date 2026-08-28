import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOpeningMonth } from "./opening-month.ts";

test("parseOpeningMonth accepts the month the widget passes", () => {
  assert.equal(parseOpeningMonth("?m=2026-08"), "2026-08");
  assert.equal(parseOpeningMonth("m=2026-08"), "2026-08");
  assert.equal(parseOpeningMonth("?other=1&m=1999-12"), "1999-12");
});

test("parseOpeningMonth rejects anything that is not a month key", () => {
  assert.equal(parseOpeningMonth(""), "");
  assert.equal(parseOpeningMonth("?m="), "");
  assert.equal(parseOpeningMonth("?m=2026-8"), "");
  assert.equal(parseOpeningMonth("?m=2026-08-01"), "");
  assert.equal(parseOpeningMonth("?m=not-a-month"), "");
  assert.equal(parseOpeningMonth("?sp=100"), "");
});
