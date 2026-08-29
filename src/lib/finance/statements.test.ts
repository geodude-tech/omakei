import assert from "node:assert/strict";
import { test } from "node:test";
import { isStatementFileName, kindFromLocalPath, mergePreviews } from "./statements.ts";
import type { ImportFileResult } from "./types.ts";

function preview(filename: string, rowCount: number): ImportFileResult {
  return {
    filename,
    accountName: filename.replace(/\.[^.]+$/, ""),
    accountKind: "checking",
    rows: Array.from({ length: rowCount }, (_, i) => ({
      date: "2026-03-01",
      description: `row ${i}`,
      amount: -1,
      raw: {},
    })),
    warnings: [],
  };
}

test("isStatementFileName accepts known extensions and rejects the rest", () => {
  assert.equal(isStatementFileName("march.csv"), true);
  assert.equal(isStatementFileName("Checking/march.OFX"), true);
  assert.equal(isStatementFileName("statement.pdf"), false);
  assert.equal(isStatementFileName(".hidden.csv"), false);
  assert.equal(isStatementFileName("no-extension"), false);
});

test("kindFromLocalPath reads the top folder name, else keeps the fallback", () => {
  assert.equal(kindFromLocalPath("Mortgage/2026.csv", "other"), "mortgage");
  assert.equal(kindFromLocalPath("Credit Card/feb.qfx", "other"), "credit");
  assert.equal(kindFromLocalPath("Savings/x.csv", "other"), "savings");
  assert.equal(kindFromLocalPath("Downloads/x.csv", "checking"), "checking");
});

test("mergePreviews appends files it has not seen", () => {
  const merged = mergePreviews([preview("a.csv", 1)], [preview("b.csv", 2)]);
  assert.deepEqual(
    merged.map((p) => p.filename),
    ["a.csv", "b.csv"],
  );
});

test("mergePreviews replaces a file re-parsed under the same name, in place", () => {
  const merged = mergePreviews([preview("a.csv", 1), preview("b.csv", 1)], [preview("a.csv", 9)]);
  assert.deepEqual(
    merged.map((p) => p.filename),
    ["a.csv", "b.csv"],
    "order is unchanged",
  );
  assert.equal(merged[0]!.rows.length, 9, "a.csv now holds the re-parsed rows");
});
