import assert from "node:assert/strict";
import { test } from "node:test";
import {
  droppedStatementPath,
  isStatementFileName,
  kindFromLocalPath,
  mergePreviews,
  parseStatementAtPath,
  statementAccount,
} from "./statements.ts";
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

test("droppedStatementPath keeps a loose file's name and strips a folder's container segment", () => {
  // Dragged in loose: no relative path, the name is the whole story.
  assert.equal(droppedStatementPath("", "aug.csv"), "aug.csv");
  assert.equal(droppedStatementPath("aug.csv", "aug.csv"), "aug.csv");

  // Came in as part of a folder: the first segment is the folder the user
  // picked, not a category — drop it so Credit/ lands where kindFromLocalPath reads.
  assert.equal(droppedStatementPath("MyStatements/Credit/aug.csv", "aug.csv"), "Credit/aug.csv");
  assert.equal(droppedStatementPath("MyStatements/aug.csv", "aug.csv"), "aug.csv");

  // Normalize Windows separators and a leading slash from the entries API.
  assert.equal(droppedStatementPath("My\\Credit\\aug.csv", "aug.csv"), "Credit/aug.csv");
  assert.equal(droppedStatementPath("/Folder/Credit/aug.csv", "aug.csv"), "Credit/aug.csv");
});

test("a folder-relative path still drives the account kind after the container strip", () => {
  const csv = "Date,Description,Amount\n2026-08-01,COFFEE SHOP,-4.50\n";
  const dropped = parseStatementAtPath(
    droppedStatementPath("MyStatements/Credit/aug.csv", "aug.csv"),
    csv,
  );
  assert.equal(dropped.accountKind, "credit");
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

test("statementAccount drops the period a statement's name covers and keeps the account", () => {
  const names = [
    "Mortgage/Zorp Lending Transactions 2025 12 through 2026 08",
    "Mortgage/Zorp Lending Transactions 2025-12-01 to 2026-09-30",
    "Zorp Home Loan Jan 2026 - Mar 2026",
    "Zorp Home Loan 20260131",
    "Zorp Card x4417 2026 03",
    "Zorp Cabin Loan",
    "Mortgage/2026 01 through 2026 08",
  ];
  assert.deepEqual(names.map(statementAccount), [
    "Mortgage/Zorp Lending Transactions",
    "Mortgage/Zorp Lending Transactions",
    "Zorp Home Loan",
    "Zorp Home Loan",
    "Zorp Card x4417",
    "Zorp Cabin Loan",
    "Mortgage",
  ]);
});

test("two statement files for one account, named for different periods, name one account", () => {
  const csv = "Date,Description,Amount\n2026-08-07,ZORPLEND PMT,-1843.27\n";
  const august = parseStatementAtPath(
    "Mortgage/Zorp_Lending_Transactions_2025-12_through_2026-08.csv",
    csv,
  );
  const september = parseStatementAtPath(
    "Mortgage/Zorp_Lending_Transactions_2025-12_through_2026-09.csv",
    csv,
  );
  assert.notEqual(august.accountName, september.accountName);
  assert.equal(statementAccount(august.accountName), "Mortgage/Zorp Lending Transactions");
  assert.equal(statementAccount(september.accountName), "Mortgage/Zorp Lending Transactions");
});
