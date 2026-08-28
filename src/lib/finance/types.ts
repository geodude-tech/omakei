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

/**
 * What a dashboard panel receives. Panels are read-only views over the ledger:
 * they render, they never write. Keep this additive — fields may be added, but
 * existing ones keep their meaning so already-written panels keep working.
 */
export interface PanelProps {
  /** Every transaction, every month. Trend panels need the history. */
  transactions: Transaction[];
  /** The selected month, "YYYY-MM". */
  month: string;
  /** `transactions` filtered to `month`, so panels don't each refilter. */
  monthTransactions: Transaction[];
  setAsides: SetAside[];
}

/** Declared by every panel alongside its default export. */
export interface PanelMeta {
  /** Card title. The panel renders the contents; the frame draws the header. */
  title: string;
  /** Columns in the five-wide panel grid. Default 2. */
  span?: 1 | 2 | 3 | 4 | 5;
  /** Ascending. Default 100; ties broken by filename. */
  order?: number;
}
