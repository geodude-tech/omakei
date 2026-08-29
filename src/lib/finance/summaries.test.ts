import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryTotals, dailySpend, monthSummary } from "./summaries.ts";
import type { Transaction } from "./types.ts";

function tx(
  partial: Partial<Transaction> & Pick<Transaction, "id" | "date" | "description" | "amount">,
): Transaction {
  return {
    accountName: "checking",
    accountKind: "checking",
    sourceFile: "test.csv",
    fingerprint: `${partial.date}|${Math.round(partial.amount * 100)}`,
    categoryId: partial.categoryId ?? null,
    importedAt: 0,
    ...partial,
  };
}

test("categoryTotals sums spend per category, largest first", () => {
  const rows = [
    tx({
      id: "1",
      date: "2026-03-02",
      description: "Trader Joe's",
      amount: -40,
      categoryId: "groceries",
    }),
    tx({
      id: "2",
      date: "2026-03-05",
      description: "Trader Joe's",
      amount: -60,
      categoryId: "groceries",
    }),
    tx({ id: "3", date: "2026-03-06", description: "Shell", amount: -25, categoryId: "transport" }),
  ];
  assert.deepEqual(categoryTotals(rows), [
    { id: "groceries", name: "Groceries", total: 100 },
    { id: "transport", name: "Transport", total: 25 },
  ]);
});

test("categoryTotals ignores income and files uncategorized spend under Other", () => {
  const rows = [
    tx({ id: "1", date: "2026-03-01", description: "Payroll", amount: 3000, categoryId: "income" }),
    tx({ id: "2", date: "2026-03-04", description: "Unknown Shop", amount: -30 }),
  ];
  assert.deepEqual(categoryTotals(rows), [{ id: "other", name: "Other", total: 30 }]);
});

test("monthSummary totals spend and income and nets out set-asides", () => {
  const rows = [
    tx({ id: "1", date: "2026-03-01", description: "Payroll", amount: 3000, categoryId: "income" }),
    tx({
      id: "2",
      date: "2026-03-04",
      description: "Trader Joe's",
      amount: -120,
      categoryId: "groceries",
    }),
    tx({ id: "3", date: "2026-03-06", description: "Unknown Shop", amount: -30 }),
    tx({
      id: "4",
      date: "2026-03-08",
      description: "Move to savings",
      amount: -500,
      categoryId: "transfers",
    }),
  ];
  const setAsides = [{ id: "t", name: "Taxes", amount: 400 }];
  const s = monthSummary(rows, setAsides);
  assert.equal(s.spent, 150, "transfers are neither spend nor income");
  assert.equal(s.income, 3000);
  assert.equal(s.cashflow, 2850);
  assert.equal(s.allocated, 400);
  assert.equal(s.net, 2450, "cashflow minus the month's set-asides");
  assert.equal(s.uncategorized, 1, "only the row with no categoryId counts");
});

test("monthSummary is all zeros for an empty month", () => {
  assert.deepEqual(monthSummary([], []), {
    spent: 0,
    income: 0,
    cashflow: 0,
    allocated: 0,
    net: 0,
    uncategorized: 0,
  });
});

test("dailySpend covers every day of the month, including empty ones", () => {
  const rows = [
    tx({ id: "1", date: "2026-02-03", description: "Cafe", amount: -4.5, categoryId: "coffee" }),
    tx({ id: "2", date: "2026-02-03", description: "Cafe", amount: -5.25, categoryId: "coffee" }),
  ];
  const days = dailySpend("2026-02", rows);
  assert.equal(days.length, 28, "February 2026 has 28 days");
  assert.equal(days[2]!.spent, 9.75, "the 3rd sums both cafe visits");
  assert.equal(days[0]!.spent, 0, "a day with no spending is still present");
});

test("dailySpend handles a leap February and drops out-of-month rows", () => {
  const rows = [
    tx({ id: "1", date: "2024-02-29", description: "Cafe", amount: -10, categoryId: "coffee" }),
    tx({ id: "2", date: "2024-03-01", description: "Cafe", amount: -99, categoryId: "coffee" }),
  ];
  const days = dailySpend("2024-02", rows);
  assert.equal(days.length, 29);
  assert.equal(days[28]!.spent, 10);
  assert.equal(
    days.reduce((sum, d) => sum + d.spent, 0),
    10,
    "a row dated outside the month contributes nothing",
  );
});
