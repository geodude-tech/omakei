import { queryFolderPermission, requestFolderPermission } from "./folder";
import { seedRules } from "./ledger";
import { parseSetAsides } from "./set-asides";
import type { CategorizeRule, SetAside, Transaction } from "./types";

let activeDir: FileSystemDirectoryHandle | null = null;
let writeEnabled = false;
let localDiskWriteEnabled = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let localDiskInflight: ReturnType<typeof requestLocalDiskLedger> | null = null;

export const LEDGER_FILENAME = "omakei-ledger.json";
export const LEGACY_LEDGER_FILENAME = "folio-ledger.json";
export const LOCAL_LEDGER_ROUTE = "/__folio/local-statements/ledger";
const SAVE_DEBOUNCE_MS = 32;

export function encodeLedgerJson(snapshot: LedgerSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

export type LedgerSnapshot = {
  version: 1;
  savedAt: string;
  selectedMonth: string;
  isSample: boolean;
  transactions: Transaction[];
  rules: CategorizeRule[];
  setAsides?: SetAside[];
};

export function snapshotFromState(state: {
  transactions: Transaction[];
  rules: CategorizeRule[];
  selectedMonth: string;
  setAsides?: SetAside[];
}): LedgerSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    selectedMonth: state.selectedMonth,
    isSample: false,
    transactions: state.transactions,
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
  if (data.isSample === true) return null;
  const userRules = data.rules.filter((r) => r && r.source === "user" && r.pattern && r.categoryId);
  const transactions = data.transactions.filter(
    (t) => t && typeof t.id === "string" && typeof t.date === "string",
  );
  return {
    version: 1,
    savedAt: typeof data.savedAt === "string" ? data.savedAt : new Date().toISOString(),
    selectedMonth: typeof data.selectedMonth === "string" ? data.selectedMonth : "",
    isSample: false,
    transactions,
    rules: [...userRules, ...seedRules()],
    ...(Array.isArray(data.setAsides) ? { setAsides: parseSetAsides(data.setAsides) } : {}),
  };
}

export function parseLedgerFile(text: string): LedgerSnapshot | null {
  try {
    return parseLedgerData(JSON.parse(text));
  } catch {
    return null;
  }
}

export function setLocalDiskWrite(enabled: boolean): void {
  localDiskWriteEnabled = enabled;
}

export function fetchLocalDiskLedger(): Promise<{
  configured: boolean;
  folderName: string | null;
  snapshot: LedgerSnapshot | null;
}> {
  if (!localDiskInflight) localDiskInflight = requestLocalDiskLedger();
  return localDiskInflight;
}

type LocalDiskPayload = {
  configured?: boolean;
  folderName?: string | null;
  ledger?: unknown;
};

declare global {
  interface Window {
    __FOLIO_LEDGER?: LocalDiskPayload | null;
    __FOLIO_LEDGER_P?: Promise<LocalDiskPayload | null>;
  }
}

function snapshotFromPayload(body: LocalDiskPayload | null | undefined): {
  configured: boolean;
  folderName: string | null;
  snapshot: LedgerSnapshot | null;
} {
  if (!body?.configured) return { configured: false, folderName: null, snapshot: null };
  return {
    configured: true,
    folderName: body.folderName ?? null,
    snapshot: body.ledger == null ? null : parseLedgerData(body.ledger),
  };
}

async function requestLocalDiskLedger(): Promise<{
  configured: boolean;
  folderName: string | null;
  snapshot: LedgerSnapshot | null;
}> {
  try {
    const preloaded =
      typeof window !== "undefined"
        ? (window.__FOLIO_LEDGER ?? (await window.__FOLIO_LEDGER_P))
        : undefined;
    if (preloaded !== undefined) return snapshotFromPayload(preloaded);
    const res = await fetch(LOCAL_LEDGER_ROUTE);
    if (!res.ok) return { configured: false, folderName: null, snapshot: null };
    return snapshotFromPayload((await res.json()) as LocalDiskPayload);
  } catch {
    return { configured: false, folderName: null, snapshot: null };
  }
}

async function putLocalDiskLedger(snapshot: LedgerSnapshot): Promise<boolean> {
  try {
    const res = await fetch(LOCAL_LEDGER_ROUTE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: encodeLedgerJson(snapshot),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; folderName?: string };
    if (body.ok !== true) return false;
    localDiskInflight = Promise.resolve({
      configured: true,
      folderName: body.folderName ?? null,
      snapshot,
    });
    return true;
  } catch {
    return false;
  }
}

export async function readLedgerFile(
  dir: FileSystemDirectoryHandle,
): Promise<LedgerSnapshot | null> {
  for (const name of [LEDGER_FILENAME, LEGACY_LEDGER_FILENAME]) {
    try {
      const fh = await dir.getFileHandle(name);
      const text = await (await fh.getFile()).text();
      const parsed = parseLedgerFile(text);
      if (parsed) return parsed;
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") continue;
      return null;
    }
  }
  return null;
}

export async function writeLedgerFile(
  dir: FileSystemDirectoryHandle,
  snapshot: LedgerSnapshot,
): Promise<void> {
  const fh = await dir.getFileHandle(LEDGER_FILENAME, { create: true });
  if (typeof fh.createWritable !== "function") {
    throw new Error("This browser cannot write the ledger file");
  }
  const writable = await fh.createWritable();
  await writable.write(encodeLedgerJson(snapshot));
  await writable.close();
}

export function setActiveLedgerFolder(
  dir: FileSystemDirectoryHandle | null,
  canWrite: boolean,
): void {
  activeDir = dir;
  writeEnabled = Boolean(dir) && canWrite;
  if (!writeEnabled && !localDiskWriteEnabled && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

export function hasActiveLedgerFolder(): boolean {
  return activeDir !== null;
}

export async function activateFolderForLedger(
  handle: FileSystemDirectoryHandle,
  requestWrite: boolean,
): Promise<{ read: boolean; write: boolean }> {
  let readPerm = await queryFolderPermission(handle, "read");
  if (readPerm !== "granted" && requestWrite) {
    readPerm = await requestFolderPermission(handle, "read");
  }
  let writePerm = await queryFolderPermission(handle, "readwrite");
  if (writePerm !== "granted" && requestWrite) {
    writePerm = await requestFolderPermission(handle, "readwrite");
  }
  const write = writePerm === "granted";
  const read = write || readPerm === "granted";
  setActiveLedgerFolder(read ? handle : null, write);
  return { read, write };
}

function canWriteLedger(): boolean {
  return Boolean((activeDir && writeEnabled) || localDiskWriteEnabled);
}

async function persistSnapshot(
  snapshot: LedgerSnapshot,
  dir: FileSystemDirectoryHandle | null,
  writeFsa: boolean,
  writeLocal: boolean,
): Promise<boolean> {
  let ok = false;
  if (writeFsa && dir) {
    try {
      await writeLedgerFile(dir, snapshot);
      ok = true;
    } catch {
      /* Permission can lapse; local disk write may still work. */
    }
  }
  if (writeLocal) {
    ok = (await putLocalDiskLedger(snapshot)) || ok;
  }
  return ok;
}

type PersistableLedger = {
  transactions: Transaction[];
  rules: CategorizeRule[];
  selectedMonth: string;
  setAsides?: SetAside[];
};

export async function saveLedgerNow(state: PersistableLedger): Promise<boolean> {
  if (!canWriteLedger()) return false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return persistSnapshot(
    snapshotFromState(state),
    activeDir,
    Boolean(activeDir && writeEnabled),
    localDiskWriteEnabled,
  );
}

/** Write any pending debounce immediately. Use on blur / tab hide so set-asides are not lost. */
export async function flushLedgerSave(state: PersistableLedger): Promise<boolean> {
  return saveLedgerNow(state);
}

export function scheduleLedgerSave(state: PersistableLedger): void {
  if (!canWriteLedger()) return;
  if (saveTimer) clearTimeout(saveTimer);
  const dir = activeDir;
  const writeFsa = Boolean(activeDir && writeEnabled);
  const writeLocal = localDiskWriteEnabled;
  const snap = snapshotFromState(state);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistSnapshot(snap, dir, writeFsa, writeLocal).catch(() => {
      /* Permission can lapse; Sync will request it again. */
    });
  }, SAVE_DEBOUNCE_MS);
}
