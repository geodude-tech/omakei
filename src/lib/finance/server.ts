/**
 * Talks to the local Omakei server, which owns the attached folder.
 *
 * The browser has no filesystem of its own, so every read and write goes
 * through here. The server knows the folder's real path, which is what lets
 * the bar widget find the ledger without anyone typing a path into settings.
 */
import type { LedgerSnapshot } from "./ledger-file.ts";
import { parseLedgerData } from "./ledger-file.ts";

export const API_PREFIX = "/__omakei";

export type AttachedFolder = { path: string; name: string };

export type ServerState = {
  folder: AttachedFolder | null;
  ledger: LedgerSnapshot | null;
  ledgerPath: string;
  home: string;
};

export type BrowseResult = {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
};

const EMPTY_STATE: ServerState = { folder: null, ledger: null, ledgerPath: "", home: "" };

declare global {
  interface Window {
    /** Injected into the page by the server so the first render has real data. */
    __OMAKEI_STATE?: unknown;
  }
}

export class ServerError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ServerError(
      (body as { error?: string })?.error || `Omakei server returned ${res.status}`,
    );
  }
  return body as T;
}

function normalizeState(raw: unknown): ServerState {
  if (!raw || typeof raw !== "object") return EMPTY_STATE;
  const data = raw as Partial<ServerState>;
  const folder =
    data.folder && typeof data.folder.path === "string" && data.folder.path
      ? { path: data.folder.path, name: data.folder.name || data.folder.path }
      : null;
  return {
    folder,
    ledger: data.ledger ? parseLedgerData(data.ledger) : null,
    ledgerPath: typeof data.ledgerPath === "string" ? data.ledgerPath : "",
    home: typeof data.home === "string" ? data.home : "",
  };
}

/**
 * The server inlines the state into the page, so the common case costs no
 * round-trip at all. The fetch is the fallback for a ledger too large to
 * inline, and for the dev server before it has warmed up.
 */
export async function readState(): Promise<ServerState> {
  const inlined = typeof window !== "undefined" ? window.__OMAKEI_STATE : undefined;
  if (inlined !== undefined) {
    delete window.__OMAKEI_STATE;
    return normalizeState(inlined);
  }
  try {
    return normalizeState(await request<unknown>("/state"));
  } catch {
    return EMPTY_STATE;
  }
}

export async function attachFolder(path: string): Promise<ServerState> {
  return normalizeState(
    await request<unknown>("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function detachFolder(): Promise<ServerState> {
  return normalizeState(await request<unknown>("/folder", { method: "DELETE" }));
}

export function browseFolders(path: string): Promise<BrowseResult> {
  return request<BrowseResult>(`/browse?path=${encodeURIComponent(path)}`);
}

export function listStatements(): Promise<{ files: Array<{ path: string; name: string }> }> {
  return request<{ files: Array<{ path: string; name: string }> }>("/statements");
}

export function readStatement(path: string): Promise<{ path: string; text: string }> {
  return request<{ path: string; text: string }>(
    `/statements/file?path=${encodeURIComponent(path)}`,
  );
}

export async function writeLedger(snapshot: LedgerSnapshot): Promise<boolean> {
  try {
    await request<{ ok: boolean }>("/ledger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: `${JSON.stringify(snapshot)}\n`,
    });
    return true;
  } catch {
    return false;
  }
}
