/**
 * What a drop-folder import run decides, with no I/O: which files are ready,
 * which were already imported, and what the ledger becomes. The script
 * (`scripts/omakei-import.mjs`) only finds, reads, and parses files, then
 * hands them here inside the ledger's write transaction.
 * The rules are `docs/spec/auto-import.md`.
 */
import { mergeImport, seedRules } from "./ledger.ts";
import { STATEMENT_EXTS } from "./statements.ts";
import type { CategorizeRule, ImportFileResult, SetAside, Transaction } from "./types.ts";

export type ImportStatus = "imported" | "duplicate" | "failed";

/** One file a run read, kept so the next run can skip it. */
export interface ImportRecord {
  path: string;
  sha256: string;
  size: number;
  status: ImportStatus;
  added: number;
  reason: string;
  importedAt: number;
}

export const IMPORT_STATUSES: readonly ImportStatus[] = ["imported", "duplicate", "failed"];
export const MAX_IMPORT_RECORDS = 5000;
export const MAX_IMPORT_PATH = 1024;
export const MAX_IMPORT_REASON = 120;

/** Fixed reasons, never parser text: a parser's message can quote amounts. */
export const REASONS = {
  unrecognized: "not a statement this can read",
  mismatch: "rows do not reconcile with the statement's totals",
  empty: "no transactions found",
  unreadable: "unreadable",
} as const;

/** Leave a file alone this long after its last change: it may still be saving. */
export const SETTLE_MS = 2 * 60 * 1000;

export interface FoundFile {
  /** Relative to the statements folder, "/"-separated. */
  path: string;
  size: number;
  mtimeMs: number;
}

export function isImportable(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (!base || base.startsWith(".")) return false;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = base.slice(dot).toLowerCase();
  return ext === ".pdf" || STATEMENT_EXTS.has(ext);
}

/**
 * Which found files to read now. A file changed within `settleMs` waits for the
 * next run; a PDF with a same-named CSV beside it is the CSV's source, and the
 * CSV is what gets imported.
 */
export function planFiles(
  found: readonly FoundFile[],
  now: number,
  settleMs = SETTLE_MS,
): { ready: FoundFile[]; waiting: FoundFile[]; shadowed: FoundFile[] } {
  const paths = new Set(found.map((f) => f.path.toLowerCase()));
  const ready: FoundFile[] = [];
  const waiting: FoundFile[] = [];
  const shadowed: FoundFile[] = [];
  for (const file of found) {
    if (!isImportable(file.path)) continue;
    const lower = file.path.toLowerCase();
    if (lower.endsWith(".pdf") && paths.has(`${lower.slice(0, -4)}.csv`)) {
      shadowed.push(file);
      continue;
    }
    (now - file.mtimeMs < settleMs ? waiting : ready).push(file);
  }
  const byPath = (a: FoundFile, b: FoundFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    ready: ready.sort(byPath),
    waiting: waiting.sort(byPath),
    shadowed: shadowed.sort(byPath),
  };
}

/** A file that was read: parsed, or a fixed reason it could not be. */
export interface ReadFile {
  path: string;
  sha256: string;
  size: number;
  parsed: ImportFileResult | null;
  reason?: string;
}

/** The ledger as `ledger-db.mjs` hands it over (and takes it back). */
export interface ImportLedger {
  version: 1;
  savedAt?: string;
  selectedMonth?: string;
  transactions: Transaction[];
  rules: CategorizeRule[];
  setAsides?: SetAside[];
  importedFiles?: ImportRecord[];
  [other: string]: unknown;
}

export interface ImportSummary {
  added: number;
  uncategorized: number;
  imported: string[];
  duplicates: string[];
  failed: Array<{ path: string; reason: string }>;
  alreadySeen: string[];
}

/** Whether this sha256 is already on record; skipped unless rescanning. */
export function seenHashes(records: readonly ImportRecord[] | undefined): Set<string> {
  return new Set((records ?? []).map((r) => r.sha256));
}

/**
 * Fold the read files into the ledger. Returns `next: null` when nothing
 * changed, so the caller writes nothing. Pure; `now` is the import time.
 */
export function applyImport(
  ledger: ImportLedger | null,
  files: readonly ReadFile[],
  now: number,
  { rescan = false }: { rescan?: boolean } = {},
): { next: ImportLedger | null; summary: ImportSummary } {
  const summary: ImportSummary = {
    added: 0,
    uncategorized: 0,
    imported: [],
    duplicates: [],
    failed: [],
    alreadySeen: [],
  };
  const records = [...(ledger?.importedFiles ?? [])];
  const seen = rescan ? new Set<string>() : seenHashes(records);
  const userRules = (ledger?.rules ?? []).filter(
    (r) => r && r.source === "user" && r.pattern && r.categoryId,
  );
  const rules = [...userRules, ...seedRules()];
  let transactions = ledger?.transactions ?? [];
  let changed = false;

  for (const file of files) {
    if (seen.has(file.sha256)) {
      summary.alreadySeen.push(file.path);
      continue;
    }
    seen.add(file.sha256);
    const record: ImportRecord = {
      path: file.path.slice(0, MAX_IMPORT_PATH),
      sha256: file.sha256,
      size: file.size,
      status: "failed",
      added: 0,
      reason: "",
      importedAt: now,
    };
    if (!file.parsed || file.parsed.rows.length === 0) {
      record.reason = (file.reason ?? (file.parsed ? REASONS.empty : REASONS.unreadable)).slice(
        0,
        MAX_IMPORT_REASON,
      );
      summary.failed.push({ path: file.path, reason: record.reason });
    } else {
      const merged = mergeImport(transactions, [file.parsed], rules, now);
      transactions = merged.transactions;
      record.added = merged.summary.added;
      record.status = merged.summary.added > 0 ? "imported" : "duplicate";
      summary.added += merged.summary.added;
      summary.uncategorized += merged.summary.uncategorized;
      (record.added > 0 ? summary.imported : summary.duplicates).push(file.path);
    }
    // A rescan replaces the old record for the same content instead of stacking.
    const at = records.findIndex((r) => r.sha256 === record.sha256);
    if (at >= 0) records.splice(at, 1);
    records.push(record);
    changed = true;
  }

  if (!changed) return { next: null, summary };
  const next: ImportLedger = {
    version: 1,
    savedAt: new Date(now).toISOString(),
    selectedMonth: typeof ledger?.selectedMonth === "string" ? ledger.selectedMonth : "",
    transactions,
    // Only the user's own rules are stored; the defaults ship with the build.
    rules: userRules,
    setAsides: Array.isArray(ledger?.setAsides) ? ledger.setAsides : [],
    importedFiles: records.slice(-MAX_IMPORT_RECORDS),
  };
  return { next, summary };
}

/** "12 new transactions, 2 need a category; 1 file could not be read", or null. */
export function noticeText(
  summary: Pick<ImportSummary, "added" | "uncategorized" | "failed">,
): string | null {
  const parts: string[] = [];
  if (summary.added > 0) {
    let text = `${summary.added} new transaction${summary.added === 1 ? "" : "s"}`;
    if (summary.uncategorized > 0) {
      text += `, ${summary.uncategorized} need${summary.uncategorized === 1 ? "s" : ""} a category`;
    }
    parts.push(text);
  }
  const failed = summary.failed.length;
  if (failed > 0) parts.push(`${failed} file${failed === 1 ? "" : "s"} could not be read`);
  return parts.length ? parts.join("; ") : null;
}
