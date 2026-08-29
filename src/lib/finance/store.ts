import { create } from "zustand";
import { extractMerchant } from "./fingerprint.ts";
import { mergeImport, refreshCategories, seedRules, upsertRule } from "./ledger.ts";
import { scheduleLedgerSave } from "./ledger-file.ts";
import { makeSetAside, parseSetAsides } from "./set-asides.ts";
import type {
  CategorizeRule,
  ImportFileResult,
  ImportSummary,
  SetAside,
  Transaction,
} from "./types.ts";

/**
 * The ledger in memory. The file in the attached folder is the only copy that
 * outlives the tab: every change here is written back through the server, so
 * there is nothing cached in the browser to drift out of step with it.
 */
interface LedgerState {
  transactions: Transaction[];
  rules: CategorizeRule[];
  setAsides: SetAside[];
  initialized: boolean;
  selectedMonth: string;
  setMonth: (month: string) => void;
  importFiles: (files: ImportFileResult[]) => ImportSummary;
  loadSnapshot: (snapshot: {
    transactions: Transaction[];
    rules: CategorizeRule[];
    selectedMonth: string;
    setAsides?: SetAside[];
  }) => void;
  categorizeMerchant: (merchant: string, categoryId: string) => void;
  categorizeOne: (id: string, categoryId: string, always: boolean) => void;
  deleteTransaction: (id: string) => void;
  deleteRule: (id: string) => void;
  addSetAside: () => string;
  updateSetAside: (id: string, patch: { name?: string; amount?: number }) => void;
  removeSetAside: (id: string) => void;
  clearLedger: () => void;
}

export function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function latestMonth(transactions: Transaction[]): string {
  if (transactions.length === 0) return currentMonthKey();
  let latest = transactions[0]!.date;
  for (const tx of transactions) if (tx.date > latest) latest = tx.date;
  return latest.slice(0, 7);
}

export const useLedgerStore = create<LedgerState>()((set, get) => ({
  transactions: [],
  rules: seedRules(),
  setAsides: [],
  initialized: false,
  selectedMonth: currentMonthKey(),

  setMonth: (month) => set({ selectedMonth: month }),

  importFiles: (files) => {
    const { transactions, summary } = mergeImport(get().transactions, files, get().rules);
    set({ transactions, initialized: true, selectedMonth: latestMonth(transactions) });
    return summary;
  },

  loadSnapshot: (snapshot) => {
    set({
      transactions: snapshot.transactions,
      rules: snapshot.rules.length > 0 ? snapshot.rules : seedRules(),
      ...(snapshot.setAsides !== undefined
        ? { setAsides: parseSetAsides(snapshot.setAsides) }
        : {}),
      initialized: true,
      selectedMonth: snapshot.selectedMonth || latestMonth(snapshot.transactions),
    });
  },

  categorizeMerchant: (merchant, categoryId) => {
    const rules = upsertRule(get().rules, merchant.trim(), categoryId);
    set({ rules, transactions: refreshCategories(get().transactions, rules) });
  },

  categorizeOne: (id, categoryId, always) => {
    const tx = get().transactions.find((t) => t.id === id);
    if (!tx) return;
    if (!always) {
      set({
        transactions: get().transactions.map((t) => (t.id === id ? { ...t, categoryId } : t)),
      });
      return;
    }
    const rules = upsertRule(get().rules, extractMerchant(tx.description), categoryId);
    set({ rules, transactions: refreshCategories(get().transactions, rules) });
  },

  deleteTransaction: (id) =>
    set({ transactions: get().transactions.filter((t) => t.id !== id) }),

  deleteRule: (id) => set({ rules: get().rules.filter((r) => r.id !== id) }),

  addSetAside: () => {
    const item = makeSetAside();
    set({ setAsides: [...get().setAsides, item] });
    return item.id;
  },

  updateSetAside: (id, patch) => {
    set({
      setAsides: get().setAsides.map((item) => {
        if (item.id !== id) return item;
        const next = { ...item, ...patch };
        if (typeof patch.amount === "number") {
          next.amount = Number.isFinite(patch.amount)
            ? Math.max(0, Math.round(patch.amount * 100) / 100)
            : item.amount;
        }
        return next;
      }),
    });
  },

  removeSetAside: (id) =>
    set({ setAsides: get().setAsides.filter((item) => item.id !== id) }),

  clearLedger: () =>
    set({ transactions: [], initialized: true, selectedMonth: currentMonthKey() }),
}));

useLedgerStore.subscribe((state) => {
  scheduleLedgerSave(state);
});

export function unknownMerchants(
  transactions: Transaction[],
): Array<{ merchant: string; count: number; total: number }> {
  const map = new Map<string, { count: number; total: number }>();
  for (const tx of transactions) {
    if (tx.categoryId) continue;
    const merchant = extractMerchant(tx.description);
    const cur = map.get(merchant) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += tx.amount;
    map.set(merchant, cur);
  }
  return [...map.entries()]
    .map(([merchant, v]) => ({ merchant, ...v }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}
