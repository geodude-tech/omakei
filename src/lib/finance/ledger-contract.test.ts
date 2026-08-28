/**
 * `docs/ledger.md` is the contract an agent reads before querying the ledger.
 * A wrong category name or a stale rule there produces confidently wrong
 * answers, so the doc is checked against the code rather than trusted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORIES, TRANSFER_CATEGORY } from "./categories.ts";
import { isIncome, isSpend } from "./ledger.ts";
import type { Transaction } from "./types.ts";

const DOC = new URL("../../../docs/ledger.md", import.meta.url);
const doc = readFileSync(DOC, "utf8");

function documentedCategories(): { id: string; name: string; group: string }[] {
  const rows = doc.matchAll(/^\| `([a-z-]+)` \| ([^|]+?) \| ([a-z]+) \|$/gm);
  return [...rows].map((m) => ({ id: m[1]!, name: m[2]!.trim(), group: m[3]! }));
}

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: "t1",
    date: "2026-08-01",
    description: "TEST",
    amount: -10,
    accountName: "Checking",
    accountKind: "checking",
    sourceFile: "s.csv",
    fingerprint: "f1",
    categoryId: null,
    importedAt: 0,
    ...over,
  };
}

test("the category table in docs/ledger.md matches CATEGORIES", () => {
  assert.deepEqual(documentedCategories(), CATEGORIES);
});

test("docs/ledger.md documents the transfer id the code actually uses", () => {
  assert.equal(TRANSFER_CATEGORY, "transfers");
  assert.match(doc, /categoryId !== "transfers"/);
});

test("the spend and income rules in docs/ledger.md behave as documented", () => {
  const transfer = tx({ categoryId: TRANSFER_CATEGORY, amount: -1500 });
  const refund = tx({ categoryId: TRANSFER_CATEGORY, amount: 1500 });
  assert.equal(isSpend(transfer), false, "a card payment is not spending");
  assert.equal(isIncome(refund), false, "its other side is not income");
  assert.equal(isSpend(tx({ categoryId: "dining" })), true);
  assert.equal(isSpend(tx({ categoryId: null })), true, "uncategorized is still spending");
  assert.equal(isIncome(tx({ categoryId: "income", amount: 4200 })), true);
});

test("docs/ledger.md points at the state file the server writes", () => {
  assert.match(doc, /\.local\/state\/omakei\/state\.json/);
  for (const key of ["version", "statementsDir", "ledgerPath"]) {
    assert.match(doc, new RegExp(`"${key}"`), `state.json key ${key} is undocumented`);
  }
});
