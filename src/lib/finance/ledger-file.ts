/**
 * The ledger's on-disk shape, and the debounce in front of saving it.
 *
 * Writing goes to the local server, which owns the attached folder. There is
 * exactly one destination — no browser-side copy to fall out of step with the
 * file the bar widget reads.
 */
import { refreshCategories, seedRules } from "./ledger.ts";
import { parseSetAsides } from "./set-asides.ts";
import type { CategorizeRule, SetAside, Transaction } from "./types.ts";

export const LEDGER_FILENAME = "omakei-ledger.json";
const SAVE_DEBOUNCE_MS = 32;

export type LedgerSnapshot = {
  version: 1;
  savedAt: string;
  selectedMonth: string;
  transactions: Transaction[];
  rules: CategorizeRule[];
  setAsides: SetAside[];
};

export type PersistableLedger = {
  transactions: Transaction[];
  rules: CategorizeRule[];
  selectedMonth: string;
  setAsides?: SetAside[];
};

export function snapshotFromState(state: PersistableLedger): LedgerSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    selectedMonth: state.selectedMonth,
    transactions: state.transactions,
    // Only the user's own rules are stored; the defaults ship with the build.
    rules: state.rules.filter((r) => r.source === "user"),
    setAsides: parseSetAsides(state.setAsides),
  };
}

export function parseLedgerData(raw: unknown): LedgerSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Partial<LedgerSnapshot>;
  if (data.version !== 1 || !Array.isArray(data.transactions) || !Array.isArray(data.rules)) {
    return null;
  }
  const userRules = data.rules.filter(
    (r) => r && r.source === "user" && r.pattern && r.categoryId,
  );
  return {
    version: 1,
    savedAt: typeof data.savedAt === "string" ? data.savedAt : new Date().toISOString(),
    selectedMonth: typeof data.selectedMonth === "string" ? data.selectedMonth : "",
    transactions: data.transactions.filter(
      (t) => t && typeof t.id === "string" && typeof t.date === "string",
    ),
    rules: [...userRules, ...seedRules()],
    setAsides: parseSetAsides(data.setAsides),
  };
}

/* ------------------------------------------------------------------ merging */

/**
 * Reconcile our ledger with one that reached the file first.
 *
 * The server refuses a save derived from a version that has moved on, and hands
 * back what it lost to. This is how the losing side catches up without throwing
 * away the edit that was refused.
 *
 * It works because a category is not stored state — it is a function of
 * transactions and rules, re-derived on every load and on every import. So only
 * three things actually have to be reconciled:
 *
 * - **Transactions** merge by `id`, which already encodes file, fingerprint,
 *   and occurrence, so the same bank line imported twice is the same id. Ours
 *   wins a tie only to keep the object we already hold; the fields that differ
 *   are derived ones, and they are recomputed below anyway.
 * - **User rules** merge by pattern, newest `createdAt` winning, which is the
 *   same rule `upsertRule` follows when one person edits twice.
 * - **Set-asides and the selected month** are ours. Nothing else writes them:
 *   the CLI does not touch them, and a second tab losing its month is not a
 *   loss worth a merge.
 *
 * Then every category is re-derived from the merged rules, so the file we write
 * is consistent rather than carrying whichever categories each side happened to
 * have. The bar widget reads `categoryId` straight out of the file and does not
 * re-derive, so leaving that stale would show wrong categories on the bar.
 */
export function mergeSnapshots(mine: LedgerSnapshot, theirs: LedgerSnapshot): LedgerSnapshot {
  const byId = new Map<string, Transaction>();
  for (const tx of theirs.transactions) byId.set(tx.id, tx);
  for (const tx of mine.transactions) byId.set(tx.id, tx);

  const byPattern = new Map<string, CategorizeRule>();
  for (const rule of [...theirs.rules, ...mine.rules]) {
    if (rule.source !== "user") continue;
    const key = rule.pattern.trim().toLowerCase();
    const held = byPattern.get(key);
    if (!held || rule.createdAt >= held.createdAt) byPattern.set(key, rule);
  }

  const rules = [...byPattern.values()];
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    selectedMonth: mine.selectedMonth,
    transactions: refreshCategories([...byId.values()], [...rules, ...seedRules()]),
    rules,
    setAsides: mine.setAsides,
  };
}

/* ------------------------------------------------------------------ saving */

let writable = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let write: (snapshot: LedgerSnapshot) => Promise<boolean> = async () => false;

/** Set once the server reports an attached folder to write into. */
export function setLedgerWritable(
  enabled: boolean,
  writer?: (snapshot: LedgerSnapshot) => Promise<boolean>,
): void {
  writable = enabled;
  if (writer) write = writer;
  if (!enabled && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

export function scheduleLedgerSave(state: PersistableLedger): void {
  if (!writable) return;
  if (saveTimer) clearTimeout(saveTimer);
  const snapshot = snapshotFromState(state);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void write(snapshot).catch(() => {
      /* The next edit retries; a failed save must not break the page. */
    });
  }, SAVE_DEBOUNCE_MS);
}

/** Write any pending debounce immediately — on blur, tab hide, or an explicit edit. */
export async function saveLedgerNow(state: PersistableLedger): Promise<boolean> {
  if (!writable) return false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return write(snapshotFromState(state));
}
