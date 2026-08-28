/**
 * Turning statement files into parsed rows.
 *
 * The attached folder is read by the server; these helpers cover the files
 * themselves, whichever side handed them over — a path from the server or a
 * File the user dropped onto the page.
 */
import { parseStatementFile } from "./parse.ts";
import type { AccountKind, ImportFileResult } from "./types.ts";

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

function relativeFilePath(file: File): string {
  const rel = file.webkitRelativePath?.replace(/\\/g, "/").replace(/^\//, "");
  return rel || file.name;
}

export async function parseDroppedFiles(files: File[]): Promise<ImportFileResult[]> {
  const out: ImportFileResult[] = [];
  for (const file of files) {
    const path = relativeFilePath(file);
    if (!isStatementFileName(path)) continue;
    out.push(parseStatementAtPath(path, await file.text()));
  }
  return out;
}
