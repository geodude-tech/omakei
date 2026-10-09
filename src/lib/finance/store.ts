import { create } from "zustand";
import { extractMerchant } from "./fingerprint.ts";
import {
  isGenericMerchant,
  mergeImport,
  pinCategory,
  refreshCategories,
  seedRules,
  uncategorizedIdsFor,
  upsertRule,
} from "./ledger.ts";
import { scheduleLedgerSave } from "./ledger-file.ts";
import { makeSetAside, parseSetAsides } from "./set-asides.ts";
import { parseSubscriptionMarks, type MarkKind, type SubscriptionMark } from "./subscriptions.ts";
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
  subscriptionMarks: SubscriptionMark[];
  initialized: boolean;
  selectedMonth: string;
  setMonth: (month: string) => void;
  importFiles: (files: ImportFileResult[]) => ImportSummary;
  loadSnapshot: (snapshot: {
    transactions: Transaction[];
    rules: CategorizeRule[];
    selectedMonth: string;
    setAsides?: SetAside[];
    subscriptionMarks?: SubscriptionMark[];
  }) => void;
  categorizeMerchant: (merchant: string, categoryId: string) => void;
  categorizeOne: (id: string, categoryId: string, always: boolean) => void;
  deleteTransaction: (id: string) => void;
  deleteRule: (id: string) => void;
  addSetAside: () => string;
  updateSetAside: (id: string, patch: { name?: string; amount?: number }) => void;
  removeSetAside: (id: string) => void;
  /** "Not a subscription" (ref "") or "dismiss this flag" (the flag's ref). */
  markSubscription: (key: string, kind: MarkKind, ref: string) => void;
  unmarkSubscription: (key: string, kind: MarkKind, ref: string) => void;
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
  subscriptionMarks: [],
  initialized: false,
  selectedMonth: currentMonthKey(),

  setMonth: (month) => set({ selectedMonth: month }),

  importFiles: (files) => {
    const { transactions, summary } = mergeImport(get().transactions, files, get().rules);
    set({ transactions, initialized: true, selectedMonth: latestMonth(transactions) });
    return summary;
  },

  loadSnapshot: (snapshot) => {
    // Re-derive on load, not just on import: a rule added to the ledger since
    // the last save (by hand, or by scripts/omakei-categorize.mjs) then applies
    // as soon as the editor opens, with or without an attached folder.
    const rules = snapshot.rules.length > 0 ? snapshot.rules : seedRules();
    set({
      transactions: refreshCategories(snapshot.transactions, rules),
      rules,
      ...(snapshot.setAsides !== undefined
        ? { setAsides: parseSetAsides(snapshot.setAsides) }
        : {}),
      ...(snapshot.subscriptionMarks !== undefined
        ? { subscriptionMarks: parseSubscriptionMarks(snapshot.subscriptionMarks) }
        : {}),
      initialized: true,
      selectedMonth: snapshot.selectedMonth || latestMonth(snapshot.transactions),
    });
  },

  categorizeMerchant: (merchant, categoryId) => {
    if (isGenericMerchant(merchant)) {
      const ids = uncategorizedIdsFor(get().transactions, merchant);
      set({ transactions: pinCategory(get().transactions, ids, categoryId) });
      return;
    }
    const rules = upsertRule(get().rules, merchant.trim(), categoryId);
    set({ rules, transactions: refreshCategories(get().transactions, rules) });
  },

  categorizeOne: (id, categoryId, always) => {
    const tx = get().transactions.find((t) => t.id === id);
    if (!tx) return;
    const merchant = extractMerchant(tx.description);
    // "Always" means a rule, and a rule on a check would categorize every
    // future check the same way. Pin this one instead.
    if (!always || isGenericMerchant(merchant)) {
      set({ transactions: pinCategory(get().transactions, new Set([id]), categoryId) });
      return;
    }
    const rules = upsertRule(get().rules, merchant, categoryId);
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

  markSubscription: (key, kind, ref) => {
    const marks = get().subscriptionMarks;
    if (marks.some((m) => m.key === key && m.kind === kind && m.ref === ref)) return;
    set({ subscriptionMarks: [...marks, { key, kind, ref, createdAt: Date.now() }] });
  },

  unmarkSubscription: (key, kind, ref) =>
    set({
      subscriptionMarks: get().subscriptionMarks.filter(
        (m) => !(m.key === key && m.kind === kind && m.ref === ref),
      ),
    }),

  clearLedger: () =>
    set({ transactions: [], initialized: true, selectedMonth: currentMonthKey() }),
}));

useLedgerStore.subscribe((state) => {
  scheduleLedgerSave(state);
});
