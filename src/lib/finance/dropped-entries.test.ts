import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEntryFiles, droppedPath, type EntryLike } from "./dropped-entries.ts";

function fileEntry(name: string): EntryLike {
  return { isFile: true, isDirectory: false, name, file: (ok) => ok(new File(["x"], name)) };
}

/** A directory whose reader hands back `batches` in order, then an empty array. */
function dirEntry(name: string, batches: EntryLike[][]): EntryLike {
  let i = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({ readEntries: (ok) => ok(i < batches.length ? batches[i++]! : []) }),
  };
}

test("collectEntryFiles flattens a dropped folder and tags each file's path", async () => {
  const tree = [
    dirEntry("Statements", [[dirEntry("Credit", [[fileEntry("aug.csv")]]), fileEntry("root.csv")]]),
  ];
  const files = await collectEntryFiles(tree);
  assert.deepEqual(
    files.map((f) => f.webkitRelativePath).sort(),
    ["Statements/Credit/aug.csv", "Statements/root.csv"],
  );
});

test("collectEntryFiles keeps a loose top-level file's bare name", async () => {
  const files = await collectEntryFiles([fileEntry("march.csv")]);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.webkitRelativePath, "march.csv");
});

test("collectEntryFiles drains a directory reader across multiple batches", async () => {
  // Browsers return readEntries results ~100 at a time; the walk must loop.
  const dir = dirEntry("Big", [
    [fileEntry("a.csv"), fileEntry("b.csv")],
    [fileEntry("c.csv")],
  ]);
  const files = await collectEntryFiles([dir]);
  assert.deepEqual(
    files.map((f) => f.webkitRelativePath),
    ["Big/a.csv", "Big/b.csv", "Big/c.csv"],
  );
});

/** Just enough DataTransfer for `droppedPath`, which only ever reads one type. */
function transfer(uriList: string | null): DataTransfer {
  return {
    getData: (type: string) => {
      if (uriList === null) throw new Error("no data");
      return type === "text/uri-list" ? uriList : "";
    },
  } as unknown as DataTransfer;
}

test("droppedPath reads the folder a file manager dragged from", () => {
  assert.equal(
    droppedPath(transfer("file:///home/you/Bank%20Exports\r\n"), true),
    "/home/you/Bank Exports",
  );
  // A dropped file names the folder that holds it, which is what gets attached.
  assert.equal(
    droppedPath(transfer("file:///home/you/Bank/aug.csv"), false),
    "/home/you/Bank",
  );
  // RFC 2483 comments are not paths.
  assert.equal(
    droppedPath(transfer("# comment\nfile:///home/you/Bank"), true),
    "/home/you/Bank",
  );
});

test("droppedPath gives nothing rather than a guess", () => {
  // A drag from inside a browser: a real URL, not a place on this disk.
  assert.equal(droppedPath(transfer("https://example.com/statements"), true), null);
  assert.equal(droppedPath(transfer(""), true), null);
  // Some engines refuse getData outside a drop handler; that is not a path.
  assert.equal(droppedPath(transfer(null), true), null);
});
