/**
 * The parser decides every number the bar pill shows, so a silent misread here
 * is invisible until the month's total looks wrong.
 *
 * Fixtures are inline strings on purpose: the repo blocks committing `.csv`,
 * `.ofx`, and friends so nobody's real statements can ever land in git.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDate, parseDelimited, parseStatementFile } from "./parse.ts";

test("parseDate reads the formats banks actually export", () => {
  assert.equal(parseDate("2026-08-04"), "2026-08-04");
  assert.equal(parseDate("2026-08-04T12:30:00"), "2026-08-04");
  assert.equal(parseDate("20260804"), "2026-08-04"); // OFX
  assert.equal(parseDate("20260804120000"), "2026-08-04"); // OFX with time
  // OFX zone suffixes: the minus in "[-7:MST]" once made these look like a
  // dashed date, and every such transaction was silently dropped.
  assert.equal(parseDate("20260804120000[-7:MST]"), "2026-08-04");
  assert.equal(parseDate("20260804120000.000[-5:EST]"), "2026-08-04");
  assert.equal(parseDate("20260804[0:GMT]"), "2026-08-04");
  assert.equal(parseDate("8/4/2026"), "2026-08-04");
  assert.equal(parseDate("08/04/26"), "2026-08-04");
  assert.equal(parseDate("8-4-2026"), "2026-08-04");
  assert.equal(parseDate("August 4, 2026"), "2026-08-04");

  // Two-digit years pivot at 70, so statements from the 90s stay in the 90s.
  assert.equal(parseDate("01/02/99"), "1999-01-02");
  assert.equal(parseDate("01/02/69"), "2069-01-02");

  assert.equal(parseDate("13/45/2026"), null);
  assert.equal(parseDate(""), null);
  assert.equal(parseDate("not a date"), null);
});

test("parseDelimited handles quotes, embedded commas, and CRLF", () => {
  const grid = parseDelimited(
    'Date,Description,Amount\r\n2026-08-04,"COFFEE SHOP, DOWNTOWN",-4.50\r\n2026-08-05,"SAID ""HELLO""",-1.00\r\n',
  );
  assert.deepEqual(grid[0], ["Date", "Description", "Amount"]);
  assert.deepEqual(grid[1], ["2026-08-04", "COFFEE SHOP, DOWNTOWN", "-4.50"]);
  assert.deepEqual(grid[2], ["2026-08-05", 'SAID "HELLO"', "-1.00"]);
});

test("parseDelimited detects tab and semicolon files", () => {
  assert.deepEqual(parseDelimited("Date\tDescription\tAmount\n2026-08-04\tSTORE\t-9.99\n")[1], [
    "2026-08-04",
    "STORE",
    "-9.99",
  ]);
  assert.deepEqual(parseDelimited("Date;Description;Amount\n2026-08-04;STORE;-9,99\n")[1], [
    "2026-08-04",
    "STORE",
    "-9,99",
  ]);
});

test("a plain checking CSV keeps signs and drops balance rows", () => {
  const result = parseStatementFile(
    "checking-2026-08.csv",
    [
      "Date,Description,Amount",
      "2026-08-01,Beginning Balance,1000.00",
      "2026-08-02,COFFEE SHOP #12,-4.50",
      "2026-08-03,PAYROLL DIRECT DEP,3000.00",
      "2026-08-31,Ending Balance,3995.50",
      "",
    ].join("\n"),
  );
  assert.equal(result.accountKind, "checking");
  assert.deepEqual(
    result.rows.map((r) => [r.date, r.amount]),
    [
      ["2026-08-02", -4.5],
      ["2026-08-03", 3000],
    ],
  );
});

test("separate debit and credit columns become one signed amount", () => {
  const result = parseStatementFile(
    "export.csv",
    [
      "Posting Date,Payee,Debit,Credit",
      "08/02/2026,GROCERY STORE,52.10,",
      "08/03/2026,REFUND,,12.00",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    result.rows.map((r) => [r.description, r.amount]),
    [
      ["GROCERY STORE", -52.1],
      ["REFUND", 12],
    ],
  );
});

test("parentheses, trailing minus, and currency symbols all mean negative", () => {
  const result = parseStatementFile(
    "export.csv",
    [
      "Date,Description,Amount",
      '2026-08-02,A,"($1,234.56)"',
      "2026-08-03,B,45.00-",
      '2026-08-04,C,"$1,000.00"',
      "2026-08-05,D,($9.99)",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    result.rows.map((r) => r.amount),
    [-1234.56, -45, 1000, -9.99],
  );
});

test("a headerless file is read by column shape", () => {
  const result = parseStatementFile(
    "export.csv",
    ["2026-08-02,COFFEE SHOP,-4.50", "2026-08-03,BOOK STORE,-18.00", ""].join("\n"),
  );
  assert.deepEqual(
    result.rows.map((r) => [r.date, r.description, r.amount]),
    [
      ["2026-08-02", "COFFEE SHOP", -4.5],
      ["2026-08-03", "BOOK STORE", -18],
    ],
  );
});

test("OFX transactions are read from the tags, name and memo joined", () => {
  const result = parseStatementFile(
    "download.qfx",
    `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260802120000[-7:MST]<TRNAMT>-4.50<FITID>1<NAME>COFFEE SHOP<MEMO>STORE 12</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260803<TRNAMT>3000.00<FITID>2<NAME>PAYROLL</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
  );
  assert.deepEqual(
    result.rows.map((r) => [r.date, r.description, r.amount]),
    [
      ["2026-08-02", "COFFEE SHOP - STORE 12", -4.5],
      ["2026-08-03", "PAYROLL", 3000],
    ],
  );
  assert.deepEqual(result.warnings, []);
});

test("a credit card export that lists charges as positive is flipped", () => {
  const result = parseStatementFile(
    "visa-credit-2026-08.csv",
    [
      "Date,Description,Amount",
      "2026-08-02,GROCERY STORE,52.10",
      "2026-08-03,GAS STATION,41.00",
      "2026-08-04,BOOK STORE,18.00",
      "2026-08-15,PAYMENT THANK YOU,300.00",
      "",
    ].join("\n"),
  );
  assert.equal(result.accountKind, "credit");
  assert.deepEqual(
    result.rows.map((r) => r.amount),
    [-52.1, -41, -18, 300],
  );
});

test("a credit export that already signs charges is left alone", () => {
  const result = parseStatementFile(
    "visa-credit-2026-08.csv",
    [
      "Date,Description,Amount",
      "2026-08-02,GROCERY STORE,-52.10",
      "2026-08-03,GAS STATION,-41.00",
      "2026-08-15,PAYMENT THANK YOU,300.00",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    result.rows.map((r) => r.amount),
    [-52.1, -41, 300],
  );
});

test("the account kind is inferred from the file name", () => {
  const csv = "Date,Description,Amount\n2026-08-02,X,-1.00\n";
  const kindOf = (name: string) => parseStatementFile(name, csv).accountKind;
  assert.equal(kindOf("mortgage-statement.csv"), "mortgage");
  assert.equal(kindOf("amex-2026.csv"), "credit");
  assert.equal(kindOf("savings.csv"), "savings");
  assert.equal(kindOf("checking.csv"), "checking");
  assert.equal(kindOf("statement.csv"), "other");
});

test("an unreadable file reports a warning instead of inventing rows", () => {
  const result = parseStatementFile("notes.csv", "just some prose\nwith no columns at all\n");
  assert.equal(result.rows.length, 0);
  assert.equal(result.warnings.length > 0, true);

  const empty = parseStatementFile("empty.csv", "");
  assert.equal(empty.rows.length, 0);
  assert.deepEqual(empty.warnings, ["No rows found"]);

  const emptyOfx = parseStatementFile("empty.ofx", "<OFX></OFX>");
  assert.deepEqual(emptyOfx.warnings, ["No OFX transactions found"]);
});

test("rows missing a date or an amount are skipped, not guessed", () => {
  const result = parseStatementFile(
    "export.csv",
    [
      "Date,Description,Amount",
      "2026-08-02,GOOD ROW,-4.50",
      ",NO DATE,-1.00",
      "2026-08-03,NO AMOUNT,",
      "2026-08-04,,-9.00",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    result.rows.map((r) => r.description),
    ["GOOD ROW"],
  );
});
