import { parseStatementFile } from "./parse";
import type { AccountKind, ImportFileResult } from "./types";

export const STATEMENT_EXTS = new Set([".csv", ".tsv", ".ofx", ".qfx", ".ofc", ".txt"]);

const DB_NAME = "folio-local-v1";
const STORE = "handles";
const KEY = "statements-dir";

export type RememberedFolder = {
  handle: FileSystemDirectoryHandle;
  name: string;
};

export type FolderPermission = PermissionState;

let importedRememberedThisSession = false;

export function isStatementFileName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  if (!base || base.startsWith(".")) return false;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return STATEMENT_EXTS.has(base.slice(dot).toLowerCase());
}

export function kindFromLocalPath(path: string, fallback: AccountKind): AccountKind {
  const top = (path.split("/")[0] ?? "").toLowerCase();
  if (top.includes("mortgage")) return "mortgage";
  if (top.includes("credit")) return "credit";
  if (top.includes("check")) return "checking";
  if (top.includes("saving")) return "savings";
  return fallback;
}

export function parseLocalStatement(path: string, text: string): ImportFileResult {
  const parsed = parseStatementFile(path, text);
  parsed.accountKind = kindFromLocalPath(path, parsed.accountKind);
  return parsed;
}

export function relativeFilePath(file: File): string {
  const rel = file.webkitRelativePath?.replace(/\\/g, "/").replace(/^\//, "");
  return rel || file.name;
}

export async function parseStatementFiles(files: File[]): Promise<ImportFileResult[]> {
  const next: ImportFileResult[] = [];
  for (const file of files) {
    const path = relativeFilePath(file);
    if (!isStatementFileName(path)) continue;
    next.push(parseLocalStatement(path, await file.text()));
  }
  return next;
}

export function canPickDirectory(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickStatementsDirectory(): Promise<RememberedFolder | null> {
  if (!canPickDirectory()) return null;
  const handle = await window.showDirectoryPicker!({
    mode: "readwrite",
    id: "folio-statements",
  });
  const rec = { handle, name: handle.name };
  await saveRememberedFolder(rec);
  return rec;
}

export async function queryFolderPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<FolderPermission> {
  const opts = { mode };
  if (typeof handle.queryPermission === "function") {
    return handle.queryPermission(opts);
  }
  return "granted";
}

export async function requestFolderPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<FolderPermission> {
  const opts = { mode };
  if (typeof handle.requestPermission === "function") {
    return handle.requestPermission(opts);
  }
  return "granted";
}

export async function readDirectoryStatements(
  handle: FileSystemDirectoryHandle,
): Promise<ImportFileResult[]> {
  const out: ImportFileResult[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, child] of dir.entries()) {
      if (name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "directory") {
        await walk(child as FileSystemDirectoryHandle, path);
        continue;
      }
      if (!isStatementFileName(name)) continue;
      const file = await (child as FileSystemFileHandle).getFile();
      out.push(parseLocalStatement(path, await file.text()));
    }
  }
  await walk(handle, "");
  return out;
}

export async function collectDrop(
  data: DataTransfer,
): Promise<{ files: ImportFileResult[]; folder: RememberedFolder | null }> {
  const folder = await directoryHandleFromDrop(data);
  if (folder) {
    await saveRememberedFolder(folder);
    return { files: await readDirectoryStatements(folder.handle), folder };
  }
  const fromEntries = await filesFromWebkitEntries(data);
  if (fromEntries.length) return { files: fromEntries, folder: null };
  return { files: await parseStatementFiles(Array.from(data.files)), folder: null };
}

async function directoryHandleFromDrop(data: DataTransfer): Promise<RememberedFolder | null> {
  const items = Array.from(data.items ?? []);
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (typeof item.getAsFileSystemHandle !== "function") continue;
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === "directory") {
        return { handle: handle as FileSystemDirectoryHandle, name: handle.name };
      }
    } catch {
      // Fall through to FileList / webkit entries.
    }
  }
  return null;
}

async function filesFromWebkitEntries(data: DataTransfer): Promise<ImportFileResult[]> {
  const items = Array.from(data.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => Boolean(e));
  if (entries.length === 0) return [];
  const files: Array<{ path: string; file: File }> = [];
  for (const entry of entries) {
    await walkEntry(entry, files);
  }
  const out: ImportFileResult[] = [];
  for (const item of files) {
    if (!isStatementFileName(item.path)) continue;
    out.push(parseLocalStatement(item.path, await item.file.text()));
  }
  return out;
}

function walkEntry(
  entry: FileSystemEntry,
  out: Array<{ path: string; file: File }>,
): Promise<void> {
  const path = entry.fullPath.replace(/^\//, "");
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file((file) => {
        out.push({ path: path || file.name, file });
        resolve();
      }, reject);
    });
  }
  if (!entry.isDirectory) return Promise.resolve();
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  return readAllEntries(reader).then(async (children) => {
    for (const child of children) {
      await walkEntry(child, out);
    }
  });
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        next();
      }, reject);
    };
    next();
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRememberedFolder(rec: RememberedFolder): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getRememberedFolder(): Promise<RememberedFolder | null> {
  const db = await openDb();
  const rec = await new Promise<RememberedFolder | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as RememberedFolder | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!rec?.handle) return null;
  return rec;
}

export async function forgetRememberedFolder(): Promise<void> {
  importedRememberedThisSession = false;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function autoLoadRememberedFolder(): Promise<{
  name: string;
  permission: FolderPermission;
  files: ImportFileResult[] | null;
} | null> {
  const rec = await getRememberedFolder();
  if (!rec) return null;
  let permission: FolderPermission;
  try {
    permission = await queryFolderPermission(rec.handle);
  } catch {
    await forgetRememberedFolder();
    return null;
  }
  if (permission !== "granted") {
    return { name: rec.name, permission, files: null };
  }
  try {
    const files = await readDirectoryStatements(rec.handle);
    return { name: rec.name, permission, files };
  } catch {
    return { name: rec.name, permission: "prompt", files: null };
  }
}

export function takeRememberedImportTurn(): boolean {
  if (importedRememberedThisSession) return false;
  importedRememberedThisSession = true;
  return true;
}

export function markFolderLoadedThisSession(): void {
  importedRememberedThisSession = true;
}
