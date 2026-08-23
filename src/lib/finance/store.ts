import { create } from "zustand";
import { persist } from "zustand/middleware";
import { extractMerchant } from "./fingerprint";
import {
  mergeImport,
  refreshCategories,
  seedRules,
  upsertRule,
} from "./ledger";
import {
  fetchLocalDiskLedger,
  parseLedgerData,
  scheduleLedgerSave,
} from "./ledger-file";
import { makeSetAside, parseSetAsides } from "./set-asides";
import type {
  AccountKind,
  CategorizeRule,
  ImportFileResult,
  ImportSummary,
  SetAside,
  Transaction,
} from "./types";
import { readWidgetPreviewFromLocation } from "./widget-preview";

const PERSIST_KEY = "folio-ledger-v1";

interface LedgerState {
  transactions: Transaction[];
  rules: CategorizeRule[];
  setAsides: SetAside[];
  initialized: boolean;
  selectedMonth: string;
  lastSummary: ImportSummary | null;
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
  updateAccount: (
    filename: string,
    patch: { accountName?: string; accountKind?: AccountKind },
  ) => void;
}

function latestMonth(transactions: Transaction[]): string {
  if (transactions.length === 0) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  return [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1))[0]!.date.slice(
    0,
    7,
  );
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function openingMonth(fallback: string): string {
  return readWidgetPreviewFromLocation()?.month ?? fallback;
}

function emptyLedger() {
  return {
    transactions: [] as Transaction[],
    rules: seedRules(),
    setAsides: [] as SetAside[],
    initialized: false as const,
    selectedMonth: openingMonth(currentMonthKey()),
    lastSummary: null as ImportSummary | null,
  };
}

function snapshotInitial(state: {
  transactions: Transaction[];
  rules: CategorizeRule[];
  selectedMonth?: string;
  setAsides?: SetAside[];
}) {
  return {
    transactions: state.transactions,
    rules: state.rules.length > 0 ? state.rules : seedRules(),
    setAsides: parseSetAsides(state.setAsides),
    initialized: true as const,
    selectedMonth: openingMonth(
      typeof state.selectedMonth === "string" && state.selectedMonth
        ? state.selectedMonth
        : latestMonth(state.transactions),
    ),
    lastSummary: null as ImportSummary | null,
  };
}

function readPreloadedLedger() {
  if (typeof window === "undefined") return null;
  const body = window.__FOLIO_LEDGER;
  if (!body?.configured || body.ledger == null) return null;
  const snapshot = parseLedgerData(body.ledger);
  if (!snapshot || snapshot.transactions.length === 0) return null;
  return snapshotInitial(snapshot);
}

function readCachedLedger() {
  if (typeof globalThis.localStorage === "undefined") return null;
  try {
    const raw = globalThis.localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Partial<LedgerState> };
    const state = parsed.state;
    if (!state || (state as { isSample?: boolean }).isSample) return null;
    if (!Array.isArray(state.transactions) || state.transactions.length === 0) return null;
    return snapshotInitial({
      transactions: state.transactions,
      rules: Array.isArray(state.rules) ? state.rules : [],
      selectedMonth: state.selectedMonth,
      setAsides: state.setAsides,
    });
  } catch {
    return null;
  }
}

const INITIAL = readPreloadedLedger() ?? readCachedLedger() ?? emptyLedger();

if (typeof window !== "undefined") {
  void fetchLocalDiskLedger();
}

export const useLedgerStore = create<LedgerState>()(
  persist(
    (set, get) => ({
      ...INITIAL,
      setMonth: (month) => set({ selectedMonth: month }),
      importFiles: (files) => {
        const { transactions, summary } = mergeImport(get().transactions, files, get().rules);
        set({
          transactions,
          initialized: true,
          lastSummary: summary,
          selectedMonth: latestMonth(transactions),
        });
        return summary;
      },
      loadSnapshot: (snapshot) => {
        const rules = snapshot.rules.length > 0 ? snapshot.rules : seedRules();
        set({
          transactions: snapshot.transactions,
          rules,
          ...(snapshot.setAsides !== undefined
            ? { setAsides: parseSetAsides(snapshot.setAsides) }
            : {}),
          initialized: true,
          lastSummary: null,
          selectedMonth: snapshot.selectedMonth || latestMonth(snapshot.transactions),
        });
      },
      categorizeMerchant: (merchant, categoryId) => {
        const pattern = merchant.trim();
        const rules = upsertRule(get().rules, pattern, categoryId);
        set({ rules, transactions: refreshCategories(get().transactions, rules) });
      },
      categorizeOne: (id, categoryId, always) => {
        const tx = get().transactions.find((t) => t.id === id);
        if (!tx) return;
        if (!always) {
          set({
            transactions: get().transactions.map((t) =>
              t.id === id ? { ...t, categoryId } : t,
            ),
          });
          return;
        }
        const pattern = extractMerchant(tx.description);
        const rules = upsertRule(get().rules, pattern, categoryId);
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
        set({
          transactions: [],
          initialized: true,
          lastSummary: null,
          selectedMonth: latestMonth([]),
        }),
      updateAccount: (filename, patch) => {
        const transactions = refreshCategories(
          get().transactions.map((t) =>
            t.sourceFile === filename ? { ...t, ...patch } : t,
          ),
          get().rules,
        );
        set({ transactions });
      },
    }),
    {
      name: PERSIST_KEY,
      skipHydration: true,
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if ((state as { isSample?: boolean }).isSample) {
          state.transactions = [];
          state.setAsides = [];
          state.initialized = false;
          state.lastSummary = null;
          return;
        }
        state.setAsides = parseSetAsides(state.setAsides);
      },
      partialize: (state) => ({
        transactions: state.transactions,
        rules: state.rules,
        setAsides: state.setAsides,
        initialized: state.initialized,
        selectedMonth: state.selectedMonth,
      }),
    },
  ),
);

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
