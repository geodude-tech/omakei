/**
 * The PDF converter, driven through `parseBoaStatement` on inline text rather
 * than through `pdftotext` on a file. Statement extensions are gitignored and
 * fixtures are never files (docs/agents.md), so every statement below is a
 * synthetic string in the shape `pdftotext -layout` produces.
 *
 * The cases that matter are not "does it read a row". They are the two silent
 * corruptions: a sign kept the wrong way round, and a month/day pair filed
 * under the wrong year. Both produce a plausible-looking ledger.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBoaStatement, toCsv, UnrecognizedStatement } from "./omakei-convert-boa-pdf.mjs";

/** A statement whose totals are computed from its rows, so it always reconciles. */
function statement({ closing = "08/10/2026", rows = [], interest = "0.00", previous = 0 } = {}) {
  const amounts = rows.map((r) => Number(r.amount));
  const purchases = amounts.filter((a) => a >= 0).reduce((a, b) => a + b, 0);
  const credits = amounts.filter((a) => a < 0).reduce((a, b) => a + b, 0);
  const newBalance = previous + purchases + credits + Number(interest);
  const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

  const body = rows
    .map(
      (r) =>
        `${r.trans}         ${r.posted}      ${r.payee}                    ` +
        `${r.reference ?? "2940"}        4444        ${Number(r.amount).toFixed(2)}`,
    )
    .join("\n");

  return [
    "                 BANK OF AMERICA                   Account Number:      1111 2222 3333 4444",
    `Statement Closing Date                     ${closing}`,
    `Previous Balance                            ${money(previous)}`,
    body,
    `08/10         08/10      INTEREST CHARGED ON PURCHASES                        ${interest}`,
    `        TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD          ${money(purchases)}`,
    `        TOTAL PAYMENTS AND OTHER CREDITS FOR THIS PERIOD         ${money(credits)}`,
    `        TOTAL INTEREST CHARGED FOR THIS PERIOD                   ${money(Number(interest))}`,
    `New Balance Total                            ${money(newBalance)}`,
  ].join("\n");
}

test("a purchase becomes money out, a refund becomes money in", () => {
  const parsed = parseBoaStatement(
    statement({
      rows: [
        { trans: "07/20", posted: "07/21", payee: "GROCERY MART      ANYTOWN NY", amount: 42.5 },
        { trans: "07/22", posted: "07/23", payee: "GROCERY MART      ANYTOWN NY", amount: -10.25 },
      ],
    }),
  );

  assert.deepEqual(parsed.mismatches, []);
  assert.equal(parsed.transactions.length, 2);
  // The statement is written from the card's side; the ledger is written from
  // the user's. A purchase that reads +42.50 there is -42.50 here.
  assert.equal(parsed.transactions[0].amount, -4250);
  assert.equal(parsed.transactions[1].amount, 1025);
});

test("the posted date is the one that survives, not the transaction date", () => {
  const parsed = parseBoaStatement(
    statement({ rows: [{ trans: "07/20", posted: "07/21", payee: "GROCERY MART", amount: 1 }] }),
  );
  assert.equal(parsed.transactions[0].postedDate, "07/21/2026");
});

test("a month later than the closing month belongs to the previous year", () => {
  const parsed = parseBoaStatement(
    statement({
      closing: "01/10/2026",
      rows: [
        { trans: "12/28", posted: "12/29", payee: "GROCERY MART", amount: 5 },
        { trans: "01/04", posted: "01/05", payee: "COFFEE SHOP", amount: 3 },
      ],
    }),
  );
  assert.equal(parsed.transactions[0].postedDate, "12/29/2025");
  assert.equal(parsed.transactions[1].postedDate, "01/05/2026");
});

test("column padding collapses to single spaces, the way the bank's own export writes it", () => {
  const parsed = parseBoaStatement(
    statement({
      rows: [{ trans: "07/20", posted: "07/21", payee: "GROCERY MART      ANYTOWN     NY", amount: 1 }],
    }),
  );
  assert.equal(parsed.transactions[0].payee, "GROCERY MART ANYTOWN NY");
});

test("a printed zero interest line is not a transaction", () => {
  const parsed = parseBoaStatement(
    statement({ rows: [{ trans: "07/20", posted: "07/21", payee: "GROCERY MART", amount: 1 }] }),
  );
  assert.equal(parsed.transactions.length, 1);
});

test("interest actually charged is kept, because it is real spending", () => {
  const parsed = parseBoaStatement(
    statement({
      rows: [{ trans: "07/20", posted: "07/21", payee: "GROCERY MART", amount: 1 }],
      interest: "12.34",
    }),
  );
  assert.deepEqual(parsed.mismatches, []);
  assert.equal(parsed.transactions.length, 2);
  const charged = parsed.transactions.find((t) => /INTEREST/.test(t.payee));
  assert.equal(charged.amount, -1234);
});

test("rows that do not sum to the statement's own totals are reported, not written", () => {
  const text = statement({
    rows: [{ trans: "07/20", posted: "07/21", payee: "GROCERY MART", amount: 42.5 }],
  }).replace("TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD          $42.50",
             "TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD          $99.99");

  const parsed = parseBoaStatement(text);
  assert.ok(parsed.mismatches.length > 0);
  assert.match(parsed.mismatches.join("\n"), /purchases/);
});

test("a statement from another bank is refused rather than guessed at", () => {
  assert.throws(
    () => parseBoaStatement("SOME OTHER BANK\nStatement Closing Date 08/10/2026\n"),
    UnrecognizedStatement,
  );
});

test("a missing total is refused, because it is how a layout change shows up", () => {
  const text = statement({
    rows: [{ trans: "07/20", posted: "07/21", payee: "GROCERY MART", amount: 1 }],
  }).replace(/.*TOTAL INTEREST CHARGED FOR THIS PERIOD.*\n?/, "");
  assert.throws(() => parseBoaStatement(text), UnrecognizedStatement);
});

test("a payee containing a comma is quoted once, not twice", () => {
  const csv = toCsv([
    { postedDate: "07/31/2026", reference: "1234", payee: "BOOKS, MAPS & MORE", amount: -1234 },
  ]);
  assert.equal(csv.split("\n")[1], '07/31/2026,1234,"BOOKS, MAPS & MORE",,-12.34');
});
