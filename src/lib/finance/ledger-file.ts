/**
 * The ledger's on-disk shape, and the debounce in front of saving it.
 *
 * Writing goes to the local server, which owns the attached folder. There is
 * exactly one destination — no browser-side copy to fall out of step with the
 * file the bar widget reads.
 */
import { seedRules } from "./ledger.ts";
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
