import {
  getRememberedFolder,
  takeRememberedImportTurn,
} from "./folder";
import {
  activateFolderForLedger,
  fetchLocalDiskLedger,
  readLedgerFile,
  saveLedgerNow,
  setLocalDiskWrite,
} from "./ledger-file";
import { syncAttachedFolder, syncLocalDiskStatements } from "./folder-sync";
import { waitPaint } from "@/lib/utils";
import { useLedgerStore } from "./store";
import { readWidgetPreviewFromLocation } from "./widget-preview";

export type BootResult = {
  folderName: string | null;
  folderNeedsPermission: boolean;
};

function markReady(): void {
  if (!useLedgerStore.getState().initialized) {
    useLedgerStore.setState({ initialized: true });
  }
}

/**
 * Put real ledger data on screen first. Folder permission and persist
 * hydration happen after the snapshot is applied so they cannot block display.
 */
export async function bootLedger(): Promise<BootResult> {
  if (readWidgetPreviewFromLocation()) await waitPaint();

  const local = await fetchLocalDiskLedger();
  if (local.configured) setLocalDiskWrite(true);

  if (local.snapshot) {
    const previewMonth = readWidgetPreviewFromLocation()?.month;
    useLedgerStore.getState().loadSnapshot({
      ...local.snapshot,
      selectedMonth: previewMonth || local.snapshot.selectedMonth,
    });
    takeRememberedImportTurn();
  }

  if (local.configured) {
    await syncLocalDiskStatements();
  }

  const rec = await getRememberedFolder().catch(() => null);
  if (!rec) {
    if (local.configured && !local.snapshot) {
      await saveLedgerNow(useLedgerStore.getState());
    }
    markReady();
    return { folderName: local.folderName, folderNeedsPermission: false };
  }

  const access = await activateFolderForLedger(rec.handle, false);
  if (!access.read) {
    markReady();
    return { folderName: rec.name, folderNeedsPermission: true };
  }

  if (!local.snapshot) {
    const snapshot = await readLedgerFile(rec.handle);
    if (snapshot) {
      const previewMonth = readWidgetPreviewFromLocation()?.month;
      useLedgerStore.getState().loadSnapshot({
        ...snapshot,
        selectedMonth: previewMonth || snapshot.selectedMonth,
      });
      takeRememberedImportTurn();
    }
  }

  try {
    await syncAttachedFolder(rec.handle, rec.name);
  } catch {
    if (!useLedgerStore.getState().initialized) {
      await saveLedgerNow(useLedgerStore.getState());
    }
  }

  markReady();
  return { folderName: rec.name, folderNeedsPermission: false };
}
