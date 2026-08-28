/**
 * Startup, in one path.
 *
 * The server hands over the attached folder and the ledger it already read, so
 * the first render has real numbers. Re-reading the statements happens after
 * that, because it must never delay what is already on screen.
 */
import { setLedgerWritable } from "./ledger-file.ts";
import { readState, writeLedger, type AttachedFolder } from "./server.ts";
import { useLedgerStore } from "./store.ts";
import { syncAttachedFolder } from "./sync.ts";
import { readOpeningMonth } from "./opening-month.ts";

export type BootResult = {
  folder: AttachedFolder | null;
  ledgerPath: string;
  home: string;
};

export async function bootLedger(): Promise<BootResult> {
  const state = await readState();

  if (state.folder) setLedgerWritable(true, writeLedger);

  if (state.ledger) {
    useLedgerStore.getState().loadSnapshot({
      ...state.ledger,
      selectedMonth: readOpeningMonth() || state.ledger.selectedMonth,
    });
  }

  useLedgerStore.setState({ initialized: true });

  if (state.folder) {
    // New months land in the folder between visits; pick them up quietly.
    await syncAttachedFolder(state.folder.name).catch(() => null);
  }

  return { folder: state.folder, ledgerPath: state.ledgerPath, home: state.home };
}
