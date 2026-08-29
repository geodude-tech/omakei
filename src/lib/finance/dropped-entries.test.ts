import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEntryFiles, type EntryLike } from "./dropped-entries.ts";

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
