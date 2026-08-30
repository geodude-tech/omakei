/**
 * Flattening a drag-and-drop into files.
 *
 * `DataTransfer.files` does not descend into a dropped folder — the entries API
 * does. This walks a `FileSystemEntry` tree into a flat file list, tagging each
 * file with its path relative to the drop (`DroppedFolder/Credit/aug.csv`) so
 * `droppedStatementPath` can hand a `Credit/` or `Mortgage/` subfolder to
 * `kindFromLocalPath`.
 *
 * The walk is written against a minimal interface rather than the DOM types so
 * it can be tested with a fake tree. `filesFromDataTransfer` is the thin DOM
 * adapter; it is exercised by hand.
 */

export interface EntryReader {
  readEntries(onOk: (entries: EntryLike[]) => void, onErr?: (err: unknown) => void): void;
}

export interface EntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  file?(onOk: (file: File) => void, onErr?: (err: unknown) => void): void;
  createReader?(): EntryReader;
}

/** Tag a file from the entries API with its drop-relative path. */
function tagRelativePath(file: File, path: string): void {
  try {
    Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
  } catch {
    /* Some engines lock this down; the file still imports via inferKindFromName. */
  }
}

/**
 * Depth-first flatten of a set of entries. `readEntries` yields at most ~100
 * children per call, so each directory is drained in a loop until it returns
 * an empty batch.
 */
export async function collectEntryFiles(entries: EntryLike[], prefix = ""): Promise<File[]> {
  const out: File[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      tagRelativePath(file, path);
      out.push(file);
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise<EntryLike[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        out.push(...(await collectEntryFiles(batch, path)));
      }
    }
  }
  return out;
}

/**
 * Turn a drop's items into a flat `File[]`, recursing into any dropped folder.
 * Falls back to `DataTransfer.files` when the entries API is unavailable.
 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? []).filter((item) => item.kind === "file");
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry != null);
  if (entries.length === 0) return Array.from(dt.files ?? []);
  return collectEntryFiles(entries as unknown as EntryLike[]);
}

/**
 * The real filesystem path behind a drop, when the desktop sends one.
 *
 * A dropped folder reaches the page as copies of its files with no path, which
 * is no use to a server whose whole job is recording *where* the folder is.
 * Linux file managers also put `file://` URIs on the drag, and those are real
 * paths — so when they are there, the picker can open on the folder that was
 * dropped instead of making the user find it a second time. When they are not,
 * nothing changes and the picker opens at home.
 *
 * `isDirectory` decides whether the path is the folder itself or the file that
 * sits in it; the caller knows, because the entries API already told it.
 *
 * Must be read synchronously in the drop handler: a `DataTransfer` is emptied
 * once the event finishes.
 */
export function droppedPath(dt: DataTransfer, isDirectory: boolean): string | null {
  let list = "";
  try {
    list = dt.getData("text/uri-list");
  } catch {
    return null;
  }
  for (const line of list.split(/\r?\n/)) {
    const uri = line.trim();
    // A uri-list comment, per RFC 2483.
    if (!uri || uri.startsWith("#") || !uri.startsWith("file://")) continue;
    let path;
    try {
      path = decodeURIComponent(new URL(uri).pathname);
    } catch {
      continue;
    }
    if (!path.startsWith("/")) continue;
    if (isDirectory) return path;
    const parent = path.slice(0, path.lastIndexOf("/"));
    return parent || "/";
  }
  return null;
}
