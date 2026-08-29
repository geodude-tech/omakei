import assert from "node:assert/strict";
import { test } from "node:test";
import { importSummaryLine } from "./sync.ts";

test("importSummaryLine pluralizes the duplicate count", () => {
  assert.equal(importSummaryLine({ added: 3, skipped: 0 }), "3 added · 0 duplicates skipped");
  assert.equal(importSummaryLine({ added: 3, skipped: 1 }), "3 added · 1 duplicate skipped");
  assert.equal(importSummaryLine({ added: 0, skipped: 2 }), "0 added · 2 duplicates skipped");
});
