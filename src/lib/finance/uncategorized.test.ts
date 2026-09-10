/**
 * The grouping behind three surfaces: the editor's "Needs a category" list,
 * `omakei-categorize.mjs --list`, and the bar popup's section. It had no test
 * of its own while it lived in `store.ts` and only the editor read it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { uncategorizedMerchants } from "./uncategorized.ts";
import type { Transaction } from "./types.ts";

function tx(id: string, description: string, amount: number, categoryId: string | null = null) {
  return {
    id,
    date: "2026-08-10",
    description,
    amount,
    accountName: "checking",
    accountKind: "checking",
    sourceFile: "f.csv",
    fingerprint: `fp:${id}`,
    categoryId,
    importedAt: 0,
  } as Transaction;
}

test("rows with no category group by merchant, biggest first", () => {
  const rows = uncategorizedMerchants([
    tx("a", "ZORP WIDGETS 5567", -12.5),
    tx("b", "ZORP WIDGETS 1180 SEATTLE WA", -30),
    tx("c", "SQ *PORCH SUPPLY SEATTLE WA", -80),
  ]);
  assert.deepEqual(rows, [
    { merchant: "PORCH SUPPLY", count: 1, total: -80 },
    { merchant: "ZORP WIDGETS", count: 2, total: -42.5 },
  ]);
});

test("a categorized row is not asking to be categorized", () => {
  const rows = uncategorizedMerchants([
    tx("a", "ZORP WIDGETS 5567", -12.5, "shopping"),
    tx("b", "QUUX SUPPLY", -1),
  ]);
  assert.deepEqual(
    rows.map((r) => r.merchant),
    ["QUUX SUPPLY"],
  );
});

test("the total is money, not a float that has drifted", () => {
  const rows = uncategorizedMerchants([
    tx("a", "ZORP WIDGETS", -0.1),
    tx("b", "ZORP WIDGETS", -0.2),
  ]);
  assert.equal(rows[0].total, -0.3, "0.1 + 0.2 must not surface as -0.30000000000000004");
});

test("income and spend on one merchant net out rather than splitting it", () => {
  const rows = uncategorizedMerchants([
    tx("a", "ZORP WIDGETS", -50),
    tx("b", "ZORP WIDGETS", 20), // a refund
  ]);
  assert.deepEqual(rows, [{ merchant: "ZORP WIDGETS", count: 2, total: -30 }]);
});

test("a row the scripts read off disk without a description is skipped", () => {
  // The two callers outside the app parse the ledger file as plain JSON, so
  // this shape reaches the function however the types are declared.
  const rows = uncategorizedMerchants([
    { id: "a", amount: -1, categoryId: null } as unknown as Transaction,
    tx("b", "   ", -2),
    tx("c", "QUUX SUPPLY", -3),
  ]);
  assert.deepEqual(
    rows.map((r) => r.merchant),
    ["QUUX SUPPLY"],
    "no description and no merchant key both mean there is no rule to write",
  );
});

test("nothing uncategorized is an empty list, not a throw", () => {
  assert.deepEqual(uncategorizedMerchants([]), []);
});
