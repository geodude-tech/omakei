export type AccountKind = "checking" | "savings" | "credit" | "mortgage" | "other";

export type CategoryGroup = "living" | "lifestyle" | "money" | "income";

export interface Category {
  id: string;
  name: string;
  group: CategoryGroup;
}

export interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  accountName: string;
  accountKind: AccountKind;
  sourceFile: string;
  fingerprint: string;
  categoryId: string | null;
  importedAt: number;
}

export interface CategorizeRule {
  id: string;
  pattern: string;
  categoryId: string;
  createdAt: number;
  source: "user" | "default";
}

/** Monthly reserve subtracted from this month's Net (e.g. $500 for taxes). Not a savings balance. */
export interface SetAside {
  id: string;
  name: string;
  amount: number;
}

export interface ImportFileResult {
  filename: string;
  accountName: string;
  accountKind: AccountKind;
  rows: ParsedRow[];
  warnings: string[];
}

export interface ParsedRow {
  date: string;
  description: string;
  amount: number;
  raw: Record<string, string>;
}

export interface ImportSummary {
  added: number;
  skipped: number;
  uncategorized: number;
  files: number;
}

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  mortgage: "Mortgage",
  other: "Other",
};
