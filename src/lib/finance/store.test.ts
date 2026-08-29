import assert from "node:assert/strict";
import { test } from "node:test";
import { seedRules } from "./ledger.ts";
import { useLedgerStore } from "./store.ts";
import type { CategorizeRule, Transaction } from "./types.ts";

function tx(
  id: string,
  description: string,
  categoryId: string | null,
): Transaction {
  return {
    id,
    date: "2026-08-10",
    description,
    amount: -20,
    accountName: "checking",
    accountKind: "checking",
    sourceFile: "f.csv",
    fingerprint: `fp:${id}`,
    categoryId,
    importedAt: 0,
  };
}

/** How the server hands rules over: the user's own, then the shipped defaults. */
function snapshotRules(...user: CategorizeRule[]): CategorizeRule[] {
  return [...user, ...seedRules()];
}

test("loadSnapshot re-derives categories from the snapshot's rules", () => {
  useLedgerStore.getState().loadSnapshot({
    transactions: [
      // Stored under an old category; a user rule now says otherwise.
      tx("1", "ZORP WIDGETS 5567", "shopping"),
      // Never categorized; a default still applies on load.
      tx("2", "NETFLIX.COM 866-579-7172 CA", null),
      // No rule anywhere — stays null, not coerced.
      tx("3", "QQQ UNKNOWN VENDOR 90", null),
    ],
    rules: snapshotRules({
      id: "u1",
      pattern: "zorp widgets",
      categoryId: "utilities",
      createdAt: 1,
      source: "user",
    }),
    selectedMonth: "2026-08",
  });

  const byId = Object.fromEntries(
    useLedgerStore.getState().transactions.map((t) => [t.id, t.categoryId]),
  );
  assert.equal(byId["1"], "utilities");
  assert.equal(byId["2"], "subscriptions");
  assert.equal(byId["3"], null);
});

test("loadSnapshot with no stored rules falls back to the defaults", () => {
  useLedgerStore.getState().loadSnapshot({
    transactions: [tx("1", "STARBUCKS STORE 09876 SAN JOSE CA", null)],
    rules: [],
    selectedMonth: "2026-08",
  });
  assert.equal(useLedgerStore.getState().transactions[0]!.categoryId, "dining");
});
