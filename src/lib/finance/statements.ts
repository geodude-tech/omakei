/**
 * Turning statement files into parsed rows.
 *
 * The attached folder is read by the server; these helpers cover the files
 * themselves, whichever side handed them over — a path from the server or a
 * File the user dropped onto the page.
 */
import { parseStatementFile } from "./parse.ts";
import type { AccountKind, ImportFileResult } from "./types.ts";

/**
 * Fold newly parsed files into the ones already staged for import. A file
 * re-parsed under the same name replaces its earlier version in place rather
 * than stacking a duplicate — dropping the same folder twice stages it once.
 */
export function mergePreviews(
  prev: ImportFileResult[],
  next: ImportFileResult[],
): ImportFileResult[] {
  const out = [...prev];
  for (const item of next) {
    const idx = out.findIndex((p) => p.filename === item.filename);
    if (idx >= 0) out[idx] = item;
    else out.push(item);
  }
  return out;
}

export const STATEMENT_EXTS = new Set([".csv", ".tsv", ".ofx", ".qfx", ".ofc", ".txt"]);

export function isStatementFileName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  if (!base || base.startsWith(".")) return false;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return STATEMENT_EXTS.has(base.slice(dot).toLowerCase());
}

/** A folder named "Mortgage" or "Credit" is a stronger signal than the file's own headers. */
export function kindFromLocalPath(path: string, fallback: AccountKind): AccountKind {
  const top = (path.split("/")[0] ?? "").toLowerCase();
  if (top.includes("mortgage")) return "mortgage";
  if (top.includes("credit")) return "credit";
  if (top.includes("check")) return "checking";
  if (top.includes("saving")) return "savings";
  return fallback;
}

export function parseStatementAtPath(path: string, text: string): ImportFileResult {
  const parsed = parseStatementFile(path, text);
  parsed.accountKind = kindFromLocalPath(path, parsed.accountKind);
  return parsed;
}

/**
 * The path a dropped file should be imported under.
 *
 * A file dragged in loose has no relative path — its name is the whole story.
 * A file that arrived as part of a folder (a dropped directory, or a
 * `webkitdirectory` picker) carries `Container/Sub/file.csv`, where the first
 * segment is the folder the user picked, not a category. Drop that segment so a
 * `Credit/` or `Mortgage/` subfolder lands in the position `kindFromLocalPath`
 * reads — the same position the server hands over for an attached folder.
 */
export function droppedStatementPath(relativePath: string, name: string): string {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) return name;
  const parts = rel.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : (parts[0] ?? name);
}

export async function parseDroppedFiles(files: File[]): Promise<ImportFileResult[]> {
  const out: ImportFileResult[] = [];
  for (const file of files) {
    const path = droppedStatementPath(file.webkitRelativePath ?? "", file.name);
    if (!isStatementFileName(path)) continue;
    out.push(parseStatementAtPath(path, await file.text()));
  }
  return out;
}
