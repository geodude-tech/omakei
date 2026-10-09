import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyImport,
  isImportable,
  noticeText,
  planFiles,
  REASONS,
  type ImportLedger,
  type ReadFile,
} from "./auto-import.ts";
import { parseStatementAtPath } from "./statements.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const sha = (c: string) => c.repeat(64).slice(0, 64);

function csv(path: string, rows: Array<[string, string, string]>, hash: string): ReadFile {
  const text = ["Date,Description,Amount", ...rows.map((r) => r.join(","))].join("\n");
  return { path, sha256: hash, size: text.length, parsed: parseStatementAtPath(path, text) };
}

const AUGUST = csv(
  "Credit_Card/2026-08.csv",
  [
    ["2026-08-02", "SAFEWAY #1234", "-54.12"],
    ["2026-08-05", "ZORP WIDGETS 5567", "-12.50"],
    ["2026-08-09", "NETFLIX.COM", "-15.49"],
  ],
  sha("1"),
);

test("only statement files are importable", () => {
  assert.equal(isImportable("Credit_Card/a.CSV"), true);
  assert.equal(isImportable("Checking/eStmt 2026-08.pdf"), true);
  assert.equal(isImportable("Mortgage/x.ofx"), true);
  assert.equal(isImportable("a/.hidden.csv"), false);
  assert.equal(isImportable("a/.csv"), false);
  assert.equal(isImportable("a/notes.docx"), false);
  assert.equal(isImportable("a/README"), false);
});

test("a file still changing waits; a settled one is ready", () => {
  const { ready, waiting } = planFiles(
    [
      { path: "a/new.csv", size: 10, mtimeMs: NOW - 5_000 },
      { path: "a/old.csv", size: 10, mtimeMs: NOW - 10 * 60_000 },
    ],
    NOW,
  );
  assert.deepEqual(
    ready.map((f) => f.path),
    ["a/old.csv"],
  );
  assert.deepEqual(
    waiting.map((f) => f.path),
    ["a/new.csv"],
  );
});

test("a PDF with its converted CSV beside it is not read twice", () => {
  const old = NOW - 3_600_000;
  const plan = planFiles(
    [
      { path: "Credit_Card/stmt.pdf", size: 1, mtimeMs: old },
      { path: "Credit_Card/stmt.csv", size: 1, mtimeMs: old },
      { path: "Credit_Card/other.PDF", size: 1, mtimeMs: old },
    ],
    NOW,
  );
  assert.deepEqual(
    plan.ready.map((f) => f.path),
    ["Credit_Card/other.PDF", "Credit_Card/stmt.csv"],
  );
  assert.deepEqual(
    plan.shadowed.map((f) => f.path),
    ["Credit_Card/stmt.pdf"],
  );
});

test("a first import adds, categorizes, and records the file", () => {
  const { next, summary } = applyImport(null, [AUGUST], NOW);
  assert.ok(next);
  assert.equal(summary.added, 3);
  assert.equal(summary.uncategorized, 1, "ZORP WIDGETS has no rule");
  assert.equal(
    next.transactions.find((t) => t.description.startsWith("SAFEWAY"))?.categoryId,
    "groceries",
  );
  assert.equal(
    next.transactions[0]?.accountKind,
    "credit",
    "the Credit_Card folder decides the kind",
  );
  assert.deepEqual(
    next.importedFiles?.map((r) => [r.path, r.status, r.added]),
    [["Credit_Card/2026-08.csv", "imported", 3]],
  );
  assert.deepEqual(next.rules, [], "the shipped defaults are not stored");
});

test("the same file again — or renamed, or copied — imports nothing and writes nothing", () => {
  const first = applyImport(null, [AUGUST], NOW).next!;
  const again = applyImport(first, [AUGUST], NOW + 1);
  assert.equal(again.next, null);
  assert.deepEqual(again.summary.alreadySeen, ["Credit_Card/2026-08.csv"]);
  const renamed = applyImport(
    first,
    [{ ...AUGUST, path: "Credit_Card/copy of 2026-08.csv" }],
    NOW + 1,
  );
  assert.equal(renamed.next, null);
});

test("a re-export with overlapping rows adds only the new ones", () => {
  const first = applyImport(null, [AUGUST], NOW).next!;
  const longer = csv(
    "Credit_Card/2026-08 (1).csv",
    [
      ["2026-08-02", "SAFEWAY #1234", "-54.12"],
      ["2026-08-05", "ZORP WIDGETS 5567", "-12.50"],
      ["2026-08-09", "NETFLIX.COM", "-15.49"],
      ["2026-08-20", "SAFEWAY #1234", "-61.00"],
    ],
    sha("2"),
  );
  const { next, summary } = applyImport(first, [longer], NOW);
  assert.equal(summary.added, 1);
  assert.equal(next?.transactions.length, 4);
});

test("a file with nothing new is recorded as a duplicate", () => {
  const first = applyImport(null, [AUGUST], NOW).next!;
  const sameRows = { ...AUGUST, path: "Credit_Card/again.csv", sha256: sha("3") };
  const { next, summary } = applyImport(first, [sameRows], NOW);
  assert.equal(summary.added, 0);
  assert.deepEqual(summary.duplicates, ["Credit_Card/again.csv"]);
  assert.equal(next?.importedFiles?.at(-1)?.status, "duplicate");
});

test("an unreadable file is recorded once with a fixed reason, and the run goes on", () => {
  const bad: ReadFile = {
    path: "Checking/junk.pdf",
    sha256: sha("4"),
    size: 3,
    parsed: null,
    reason: REASONS.unrecognized,
  };
  const empty: ReadFile = {
    path: "Checking/empty.csv",
    sha256: sha("5"),
    size: 3,
    parsed: parseStatementAtPath("Checking/empty.csv", "Date,Description,Amount\n"),
  };
  const { next, summary } = applyImport(null, [bad, empty, AUGUST], NOW);
  assert.equal(summary.added, 3);
  assert.deepEqual(summary.failed, [
    { path: "Checking/junk.pdf", reason: REASONS.unrecognized },
    { path: "Checking/empty.csv", reason: REASONS.empty },
  ]);
  const again = applyImport(next, [bad], NOW + 1);
  assert.equal(again.next, null, "not re-reported until the file changes");
  assert.deepEqual(again.summary.failed, []);
});

test("--rescan reads seen files again; dedupe still holds and the record is replaced", () => {
  const first = applyImport(null, [AUGUST], NOW).next!;
  const { next, summary } = applyImport(first, [AUGUST], NOW + 1, { rescan: true });
  assert.equal(summary.added, 0);
  assert.equal(next?.importedFiles?.length, 1);
  assert.equal(next?.importedFiles?.[0]?.status, "duplicate");
});

test("the user's rules apply, and the rest of the ledger is kept", () => {
  const ledger: ImportLedger = {
    version: 1,
    selectedMonth: "2026-07",
    transactions: [],
    rules: [
      { id: "r", pattern: "zorp widgets", categoryId: "shopping", createdAt: 1, source: "user" },
    ],
    setAsides: [{ id: "s", name: "Taxes", amount: 500 }],
  };
  const { next, summary } = applyImport(ledger, [AUGUST], NOW);
  assert.equal(summary.uncategorized, 0);
  assert.equal(
    next?.transactions.find((t) => t.description.startsWith("ZORP"))?.categoryId,
    "shopping",
  );
  assert.equal(next?.selectedMonth, "2026-07");
  assert.deepEqual(next?.setAsides, ledger.setAsides);
  assert.deepEqual(next?.rules, ledger.rules);
  assert.equal(
    "subscriptionMarks" in (next ?? {}),
    false,
    "marks are left to the database to keep",
  );
});

test("the notice says counts and nothing else", () => {
  assert.equal(
    noticeText({ added: 12, uncategorized: 2, failed: [] }),
    "12 new transactions, 2 need a category",
  );
  assert.equal(
    noticeText({ added: 1, uncategorized: 1, failed: [] }),
    "1 new transaction, 1 needs a category",
  );
  assert.equal(
    noticeText({ added: 3, uncategorized: 0, failed: [{ path: "x", reason: "y" }] }),
    "3 new transactions; 1 file could not be read",
  );
  assert.equal(noticeText({ added: 0, uncategorized: 0, failed: [] }), null);
});
