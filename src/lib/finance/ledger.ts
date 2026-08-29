import { CATEGORIES, defaultRules, TRANSFER_CATEGORY } from "./categories.ts";
import { fingerprint, identifierLength, ruleMatches } from "./fingerprint.ts";
import {
  applyTransferCategories,
  isInternalTransfer,
  mortgageCategory,
} from "./transfers.ts";
import type {
  AccountKind,
  CategorizeRule,
  ImportFileResult,
  ImportSummary,
  Transaction,
} from "./types.ts";

function bestMatchingRule(
  description: string,
  rules: CategorizeRule[],
  source: "user" | "default",
): CategorizeRule | null {
  let best: CategorizeRule | null = null;
  let bestLen = -1;
  for (const rule of rules) {
    if (rule.source !== source) continue;
    if (!ruleMatches(rule.pattern, description)) continue;
    const len = identifierLength(rule.pattern);
    if (
      !best ||
      len > bestLen ||
      (len === bestLen && rule.createdAt > best.createdAt)
    ) {
      best = rule;
      bestLen = len;
    }
  }
  return best;
}

export function assignCategory(
  description: string,
  rules: CategorizeRule[],
  accountKind?: AccountKind,
  amount?: number,
): string | null {
  const userHit = bestMatchingRule(description, rules, "user");
  if (userHit) return userHit.categoryId;
  if (accountKind && isInternalTransfer(description, accountKind, amount)) {
    return TRANSFER_CATEGORY;
  }
  if (accountKind === "mortgage") {
    const mortgage = mortgageCategory(description);
    if (mortgage) return mortgage;
  }
  return bestMatchingRule(description, rules, "default")?.categoryId ?? null;
}

/** Recompute categories from rules + transfer/mortgage logic. Fixes stale transfer tags on load. */
export function refreshCategories(
  transactions: Transaction[],
  rules: CategorizeRule[],
): Transaction[] {
  const assigned = transactions.map((tx) => ({
    ...tx,
    categoryId: assignCategory(tx.description, rules, tx.accountKind, tx.amount),
  }));
  return applyTransferCategories(assigned, rules);
}

export function mergeImport(
  existing: Transaction[],
  files: ImportFileResult[],
  rules: CategorizeRule[],
  importedAt = Date.now(),
): { transactions: Transaction[]; summary: ImportSummary } {
  const counts = new Map<string, number>();
  for (const tx of existing) {
    counts.set(tx.fingerprint, (counts.get(tx.fingerprint) ?? 0) + 1);
  }

  const added: Transaction[] = [];
  let skipped = 0;

  for (const file of files) {
    const incomingCounts = new Map<string, ParsedIncoming[]>();
    for (const row of file.rows) {
      const fp = fingerprint(row.date, row.amount, row.description);
      const list = incomingCounts.get(fp) ?? [];
      list.push({
        date: row.date,
        description: row.description,
        amount: row.amount,
        fingerprint: fp,
      });
      incomingCounts.set(fp, list);
    }

    for (const [fp, rows] of incomingCounts) {
      const have = counts.get(fp) ?? 0;
      const take = Math.max(0, rows.length - have);
      skipped += rows.length - take;
      for (let i = 0; i < take; i++) {
        const row = rows[i]!;
        const tx: Transaction = {
          id: `${file.filename}:${fp}:${have + i}`,
          date: row.date,
          description: row.description,
          amount: row.amount,
          accountName: file.accountName,
          accountKind: file.accountKind,
          sourceFile: file.filename,
          fingerprint: fp,
          categoryId: assignCategory(row.description, rules, file.accountKind, row.amount),
          importedAt,
        };
        added.push(tx);
        counts.set(fp, have + i + 1);
      }
    }
  }

  const transactions = refreshCategories([...existing, ...added].sort(compareTx), rules);
  return {
    transactions,
    summary: {
      added: added.length,
      skipped,
      uncategorized: added.filter((t) => !t.categoryId).length,
      files: files.length,
    },
  };
}

type ParsedIncoming = {
  date: string;
  description: string;
  amount: number;
  fingerprint: string;
};

function compareTx(a: Transaction, b: Transaction): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.description.localeCompare(b.description);
}

export function makeUserRule(pattern: string, categoryId: string): CategorizeRule {
  return {
    id: crypto.randomUUID(),
    pattern: pattern.trim(),
    categoryId,
    createdAt: Date.now(),
    source: "user",
  };
}

export function upsertRule(
  rules: CategorizeRule[],
  pattern: string,
  categoryId: string,
): CategorizeRule[] {
  const needle = pattern.trim().toLowerCase();
  const existing = rules.find(
    (r) => r.source === "user" && r.pattern.toLowerCase() === needle,
  );
  if (existing) {
    return rules.map((r) => (r.id === existing.id ? { ...r, categoryId } : r));
  }
  return [makeUserRule(pattern, categoryId), ...rules];
}

export function seedRules(): CategorizeRule[] {
  return defaultRules();
}

export { CATEGORIES };

export function isSpend(tx: Transaction): boolean {
  return tx.amount < 0 && tx.categoryId !== TRANSFER_CATEGORY;
}

export function isIncome(tx: Transaction): boolean {
  return tx.amount > 0 && tx.categoryId !== TRANSFER_CATEGORY;
}

export function exportLedgerCsv(transactions: Transaction[]): string {
  const header = [
    "Date",
    "Description",
    "Amount",
    "Category",
    "Account",
    "Account type",
    "Source file",
  ];
  const catName = (id: string | null) =>
    CATEGORIES.find((c) => c.id === id)?.name ?? "";
  const lines = [...transactions]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((tx) =>
      [
        tx.date,
        csvEscape(tx.description),
        tx.amount.toFixed(2),
        csvEscape(catName(tx.categoryId)),
        csvEscape(tx.accountName),
        tx.accountKind,
        csvEscape(tx.sourceFile),
      ].join(","),
    );
  return [header.join(","), ...lines].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
