/**
 * Which categories are drifting up, and by how much.
 *
 * This is the verdict the dashboard was missing: not a chart of what was spent,
 * but a sentence about what changed. Panels are `.tsx` and cannot be unit
 * tested, so the arithmetic lives here.
 */
import { CATEGORY_BY_ID } from "./categories.ts";
import { isSpend } from "./ledger.ts";
import type { Transaction } from "./types.ts";
import { monthKey, shiftMonth } from "../utils.ts";

export type Drift = {
  id: string;
  name: string;
  /** Spend in the selected month, to the comparison cutoff. */
  current: number;
  /** Mean of the same window in each preceding month. */
  average: number;
  /** Increase over that average, as a fraction. 0.58 is "up 58%". */
  pct: number;
  /** How many preceding months the average was taken over. */
  months: number;
};

export type DriftOptions = {
  /** Today, "YYYY-MM-DD". Only matters when `month` is still in progress. */
  today?: string;
  /** Preceding months to average over. */
  window?: number;
  /** Minimum increase to be worth saying out loud. */
  threshold?: number;
  /** Ignore categories whose average is too small for a percentage to mean much. */
  minAverage?: number;
  /** Fewer preceding months than this and there is no trend to report. */
  minMonths?: number;
};

/**
 * A month in progress has less spending in it than a finished one, which would
 * read as every category falling. Comparing the same slice of each month — the
 * 1st to the 12th against previous 1sts to 12ths — keeps the comparison honest
 * from the first week rather than only at month end.
 */
function cutoffDay(month: string, today: string | undefined): number {
  if (!today || monthKey(today) !== month) return 31;
  return Number(today.slice(8, 10)) || 31;
}

function spendByCategory(rows: Transaction[], month: string, cutoff: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const tx of rows) {
    if (!isSpend(tx)) continue;
    if (monthKey(tx.date) !== month) continue;
    if (Number(tx.date.slice(8, 10)) > cutoff) continue;
    // Uncategorized spending is real money; it groups under Other, as it does
    // everywhere else in the app.
    const id = tx.categoryId ?? "other";
    out.set(id, (out.get(id) ?? 0) + Math.abs(tx.amount));
  }
  return out;
}

export function categoryDrift(
  transactions: Transaction[],
  month: string,
  options: DriftOptions = {},
): Drift[] {
  const { today, window = 6, threshold = 0.15, minAverage = 25, minMonths = 3 } = options;
  const cutoff = cutoffDay(month, today);

  const earliest = transactions.reduce(
    (min, tx) => (min === "" || tx.date < min ? tx.date : min),
    "",
  );
  if (earliest === "") return [];

  const prior: Map<string, number>[] = [];
  for (let i = 1; i <= window; i++) {
    const key = shiftMonth(month, -i);
    if (key < monthKey(earliest)) break;
    prior.push(spendByCategory(transactions, key, cutoff));
  }
  if (prior.length < minMonths) return [];

  const current = spendByCategory(transactions, month, cutoff);
  const drifts: Drift[] = [];

  for (const [id, now] of current) {
    // A category absent from a past month spent nothing then, not nothing
    // knowable — a zero belongs in the average.
    const average = prior.reduce((sum, m) => sum + (m.get(id) ?? 0), 0) / prior.length;
    if (average < minAverage) continue;
    const pct = (now - average) / average;
    if (pct < threshold) continue;
    drifts.push({
      id,
      name: CATEGORY_BY_ID[id]?.name ?? "Other",
      current: Math.round(now * 100) / 100,
      average: Math.round(average * 100) / 100,
      pct,
      months: prior.length,
    });
  }

  // Most money first. A 200% jump on $30 matters less than 20% on $900.
  return drifts.sort((a, b) => b.current - b.average - (a.current - a.average));
}
