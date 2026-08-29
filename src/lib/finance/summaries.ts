/**
 * Derived views over the ledger, kept out of the components that draw them.
 *
 * Panels are `.tsx`, and `node --experimental-strip-types` cannot strip JSX, so
 * anything worth a test lives here in plain TypeScript instead.
 */
import { CATEGORY_BY_ID } from "./categories.ts";
import { isIncome, isSpend } from "./ledger.ts";
import { availableNet, setAsideTotal } from "./set-asides.ts";
import type { SetAside, Transaction } from "./types.ts";
import { formatDay, monthKey } from "../utils.ts";

export type CategoryTotal = { id: string; name: string; total: number };
export type DailySpend = { day: string; spent: number; label: string };
export type MonthSummary = {
  spent: number;
  income: number;
  cashflow: number;
  allocated: number;
  net: number;
  uncategorized: number;
};

/**
 * The four numbers on the stat row: total spend and income for the month, the
 * cashflow between them, and what is left after the month's set-asides.
 */
export function monthSummary(rows: Transaction[], setAsides: SetAside[]): MonthSummary {
  let spent = 0;
  let income = 0;
  let uncategorized = 0;
  for (const tx of rows) {
    if (isSpend(tx)) spent += Math.abs(tx.amount);
    if (isIncome(tx)) income += tx.amount;
    if (!tx.categoryId) uncategorized += 1;
  }
  const cashflow = income - spent;
  return {
    spent,
    income,
    cashflow,
    allocated: setAsideTotal(setAsides),
    net: availableNet(cashflow, setAsides),
    uncategorized,
  };
}

/** Spend per category, largest first. Income and transfers are excluded. */
export function categoryTotals(rows: Transaction[]): CategoryTotal[] {
  const map = new Map<string, number>();
  for (const tx of rows) {
    if (!isSpend(tx)) continue;
    const id = tx.categoryId ?? "other";
    map.set(id, (map.get(id) ?? 0) + Math.abs(tx.amount));
  }
  return [...map.entries()]
    .map(([id, total]) => ({ id, name: CATEGORY_BY_ID[id]?.name ?? "Other", total }))
    .sort((a, b) => b.total - a.total);
}

/** One entry per day of `month`, including days with no spending. */
export function dailySpend(month: string, rows: Transaction[]): DailySpend[] {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y!, m!, 0).getDate();
  const totals = Array.from({ length: days }, () => 0);
  for (const tx of rows) {
    if (!isSpend(tx)) continue;
    // Callers may hand over the whole ledger, so the month is filtered here
    // rather than assumed. Bucketing on day-of-month alone would fold every
    // other month's 3rd onto this month's.
    if (monthKey(tx.date) !== month) continue;
    const d = Number(tx.date.slice(8, 10));
    if (d >= 1 && d <= days) totals[d - 1] += Math.abs(tx.amount);
  }
  return totals.map((spent, i) => ({
    day: String(i + 1),
    spent: Math.round(spent * 100) / 100,
    label: formatDay(`${month}-${String(i + 1).padStart(2, "0")}`),
  }));
}
