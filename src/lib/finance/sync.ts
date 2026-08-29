/**
 * Pulling the attached folder into the ledger.
 *
 * Every statement in the folder is re-read on each sync and merged; duplicates
 * are dropped by fingerprint, so re-reading a file that is already in the
 * ledger costs nothing but time.
 */
import { toast } from "sonner";
import { saveLedgerNow } from "./ledger-file.ts";
import { listStatements, readStatement } from "./server.ts";
import { parseStatementAtPath } from "./statements.ts";
import { useLedgerStore } from "./store.ts";
import type { ImportFileResult, ImportSummary } from "./types.ts";

const EMPTY_SUMMARY: ImportSummary = { added: 0, skipped: 0, uncategorized: 0, files: 0 };

export type SyncResult = ImportSummary & { folderName: string; empty: boolean };

/** Merge parsed files into the ledger and write the result in one pass. */
export async function importAndSave(files: ImportFileResult[]): Promise<ImportSummary> {
  const summary = files.length ? useLedgerStore.getState().importFiles(files) : EMPTY_SUMMARY;
  await saveLedgerNow(useLedgerStore.getState());
  return summary;
}

export async function readAttachedStatements(): Promise<ImportFileResult[]> {
  const { files } = await listStatements();
  const out: ImportFileResult[] = [];
  for (const file of files) {
    try {
      const payload = await readStatement(file.path);
      out.push(parseStatementAtPath(payload.path, payload.text));
    } catch {
      /* One unreadable file must not abort the whole sync. */
    }
  }
  return out;
}

export async function syncAttachedFolder(folderName: string): Promise<SyncResult> {
  const files = await readAttachedStatements();
  const summary = await importAndSave(files);
  return {
    ...summary,
    files: files.length,
    folderName,
    empty: files.length === 0 && useLedgerStore.getState().transactions.length === 0,
  };
}

/** "3 added · 1 duplicate skipped" — shared by the sheet import and a folder sync. */
export function importSummaryLine(s: { added: number; skipped: number }): string {
  return `${s.added} added · ${s.skipped} duplicate${s.skipped === 1 ? "" : "s"} skipped`;
}

/** Toast the outcome of a one-off import (the Import sheet, the empty-state drop). */
export function toastImport(summary: ImportSummary): void {
  toast.success(importSummaryLine(summary));
  if (summary.uncategorized > 0) {
    toast.message(`${summary.uncategorized} still need a category`);
  }
}

export function toastSync(result: SyncResult): void {
  if (result.empty) {
    toast.message(`Attached ${result.folderName}. Drop OFX, QFX, or CSV exports into it.`);
    return;
  }
  if (result.files) {
    toast.success(importSummaryLine(result));
  } else {
    toast.success(`Opened the ledger in ${result.folderName}`);
  }
  if (result.uncategorized > 0) {
    toast.message(`${result.uncategorized} still need a category`);
  }
}
