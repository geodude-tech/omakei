import { toast } from "sonner";
import { parseLocalStatement, readDirectoryStatements } from "./folder";
import { activateFolderForLedger, readLedgerFile, saveLedgerNow } from "./ledger-file";
import { useLedgerStore } from "./store";
import type { ImportFileResult, ImportSummary } from "./types";

export type FolderSyncResult = {
  folderName: string;
  added: number;
  skipped: number;
  uncategorized: number;
  files: number;
  empty: boolean;
};

const EMPTY_SUMMARY: ImportSummary = { added: 0, skipped: 0, uncategorized: 0, files: 0 };

export async function importAndSave(files: ImportFileResult[]): Promise<ImportSummary> {
  const summary = files.length ? useLedgerStore.getState().importFiles(files) : EMPTY_SUMMARY;
  await saveLedgerNow(useLedgerStore.getState());
  return summary;
}

export async function syncAttachedFolder(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<FolderSyncResult> {
  const access = await activateFolderForLedger(handle, true);
  if (!access.read) {
    throw new Error("Folder access was not granted");
  }
  const snapshot = await readLedgerFile(handle);
  if (snapshot && useLedgerStore.getState().transactions.length === 0) {
    useLedgerStore.getState().loadSnapshot(snapshot);
  }
  const files = await readDirectoryStatements(handle);
  const summary = await importAndSave(files);
  return {
    folderName: name,
    added: summary.added,
    skipped: summary.skipped,
    uncategorized: summary.uncategorized,
    files: files.length,
    empty: files.length === 0 && useLedgerStore.getState().transactions.length === 0,
  };
}

export async function syncLocalDiskStatements(): Promise<FolderSyncResult | null> {
  try {
    const listRes = await fetch("/__folio/local-statements");
    if (!listRes.ok) return null;
    const list = (await listRes.json()) as {
      configured?: boolean;
      folderName?: string;
      files?: Array<{ path: string; name: string }>;
    };
    if (!list.configured) return null;
    const files: ImportFileResult[] = [];
    for (const file of list.files ?? []) {
      const fileRes = await fetch(
        `/__folio/local-statements/file?path=${encodeURIComponent(file.path)}`,
      );
      if (!fileRes.ok) continue;
      const payload = (await fileRes.json()) as { path: string; text: string };
      files.push(parseLocalStatement(payload.path, payload.text));
    }
    const summary = await importAndSave(files);
    return {
      folderName: list.folderName || "folder",
      added: summary.added,
      skipped: summary.skipped,
      uncategorized: summary.uncategorized,
      files: files.length,
      empty: files.length === 0 && useLedgerStore.getState().transactions.length === 0,
    };
  } catch {
    return null;
  }
}

export function toastFolderSync(result: FolderSyncResult): void {
  if (result.empty) {
    toast.message(`Attached ${result.folderName}. Drop OFX, QFX, or CSV exports into it.`);
    return;
  }
  if (result.files) {
    toast.success(
      `${result.added} added · ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped`,
    );
  } else {
    toast.success(`Opened ledger in ${result.folderName}`);
  }
  if (result.uncategorized > 0) {
    toast.message(`${result.uncategorized} still need a category`);
  }
}
