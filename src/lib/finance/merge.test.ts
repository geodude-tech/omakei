import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSnapshots, type LedgerSnapshot } from "./ledger-file.ts";
import type { CategorizeRule, Transaction } from "./types.ts";

function tx(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    date: "2026-08-02",
    description: "LOCAL CO-OP 4471",
    amount: -41.25,
    accountName: "Everyday Checking",
    accountKind: "checking",
    sourceFile: "demo.ofx",
    fingerprint: over.id,
    categoryId: null,
    importedAt: 0,
    ...over,
  };
}

function rule(pattern: string, categoryId: string, createdAt: number): CategorizeRule {
  return { id: `r-${pattern}-${createdAt}`, pattern, categoryId, createdAt, source: "user" };
}

function snapshot(over: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    version: 1,
    savedAt: "2026-08-01T00:00:00.000Z",
    selectedMonth: "2026-08",
    transactions: [],
    rules: [],
    setAsides: [],
    ...over,
  };
}

test("a rule that reached the file first survives our save", () => {
  const theirs = snapshot({ rules: [rule("co-op", "groceries", 100)] });
  const mine = snapshot({ rules: [] });

  const merged = mergeSnapshots(mine, theirs);

  assert.equal(merged.rules.length, 1, "the CLI's rule is not dropped by our blind snapshot");
  assert.equal(merged.rules[0]!.pattern, "co-op");
});

test("the newer of two edits to the same pattern wins", () => {
  const theirs = snapshot({ rules: [rule("co-op", "groceries", 100)] });
  const mine = snapshot({ rules: [rule("co-op", "dining", 200)] });

  assert.equal(mergeSnapshots(mine, theirs).rules[0]!.categoryId, "dining");
  assert.equal(mergeSnapshots(theirs, mine).rules[0]!.categoryId, "dining", "and order does not decide it");
});

test("patterns differing only in case or padding are one rule", () => {
  const theirs = snapshot({ rules: [rule("Co-Op ", "groceries", 100)] });
  const mine = snapshot({ rules: [rule("co-op", "dining", 200)] });

  assert.equal(mergeSnapshots(mine, theirs).rules.length, 1);
});

test("transactions union, and neither side loses its own", () => {
  const theirs = snapshot({ transactions: [tx({ id: "a" }), tx({ id: "b" })] });
  const mine = snapshot({ transactions: [tx({ id: "b" }), tx({ id: "c" })] });

  const ids = mergeSnapshots(mine, theirs).transactions.map((t) => t.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"], "an import on either side is kept");
});

test("categories are re-derived from the merged rules, not carried over stale", () => {
  // Ours predates the rule, so our copy is uncategorized. Theirs has the rule.
  const theirs = snapshot({
    transactions: [tx({ id: "a", categoryId: "groceries" })],
    rules: [rule("co-op", "groceries", 100)],
  });
  const mine = snapshot({ transactions: [tx({ id: "a", categoryId: null })] });

  const merged = mergeSnapshots(mine, theirs);

  assert.equal(
    merged.transactions[0]!.categoryId,
    "groceries",
    "the bar reads categoryId straight from the file, so it cannot be left stale",
  );
});

test("set-asides and the selected month stay ours", () => {
  const theirs = snapshot({
    selectedMonth: "2026-01",
    setAsides: [{ id: "s1", name: "Theirs", amount: 10 }],
  });
  const mine = snapshot({
    selectedMonth: "2026-09",
    setAsides: [{ id: "s2", name: "Mine", amount: 500 }],
  });

  const merged = mergeSnapshots(mine, theirs);
  assert.equal(merged.selectedMonth, "2026-09");
  assert.deepEqual(merged.setAsides, [{ id: "s2", name: "Mine", amount: 500 }]);
});

test("only user rules are merged; the shipped defaults are never persisted", () => {
  const theirs = snapshot({
    rules: [{ id: "default-0", pattern: "payroll", categoryId: "income", createdAt: 0, source: "default" }],
  });
  const merged = mergeSnapshots(snapshot(), theirs);
  assert.deepEqual(merged.rules, []);
});
