import { extractMerchant } from "./fingerprint.ts";
import type { Transaction } from "./types.ts";

export interface UncategorizedMerchant {
  merchant: string;
  count: number;
  total: number;
}

/**
 * The merchants with no category yet, grouped by the same key the rules match
 * on, biggest first.
 *
 * Three surfaces ask this question and they must not disagree about the
 * answer: the editor's "Needs a category" list, `omakei-categorize.mjs --list`
 * in a terminal, and the bar popup's section — whose rows each run that same
 * CLI back. A merchant named one way here and another way there would write a
 * rule that matches nothing.
 *
 * Callers pass transactions whose `categoryId` is already derived. Nothing
 * here re-runs the engine.
 *
 * The two scripts that call this read the ledger off disk as plain JSON, with
 * no type checking between the file and this function, so the runtime guards
 * below are not redundant with the signature.
 */
export function uncategorizedMerchants(transactions: Transaction[]): UncategorizedMerchant[] {
  const map = new Map<string, { count: number; total: number }>();
  for (const tx of transactions) {
    if (!tx || tx.categoryId) continue;
    // A row with no description has no merchant to write a rule against.
    if (typeof tx.description !== "string") continue;
    const merchant = extractMerchant(tx.description);
    if (!merchant) continue;
    const cur = map.get(merchant) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += tx.amount;
    map.set(merchant, cur);
  }
  return [...map.entries()]
    .map(([merchant, v]) => ({
      merchant,
      count: v.count,
      // Summed floats, so `-42.50000000000001` is reachable. Every caller
      // renders this as money.
      total: Math.round(v.total * 100) / 100,
    }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}
