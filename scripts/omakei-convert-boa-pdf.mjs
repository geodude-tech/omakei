#!/usr/bin/env node
/**
 * Turn a Bank of America credit-card statement PDF into a CSV the importer
 * already understands.
 *
 *   omakei-convert-boa-pdf.mjs <statement.pdf> [--out file.csv] [--stdout]
 *
 * Omakei does not read PDFs and should not learn to. `STATEMENT_EXTS` in
 * `src/lib/finance/statements.ts` is an allowlist of text formats, and the
 * import spec commits the ledger server to hand-written parsers with no
 * dependencies so `omarchy plugin add` never runs `npm install`. Every usable
 * PDF text extractor is a dependency. So this converts *outside* the plugin and
 * writes a file the normal import path picks up unchanged.
 *
 * This is deliberately not a general PDF importer. It reads one layout: the
 * Bank of America consumer card statement. A statement from another bank, or
 * another product from this one, has a different shape and must not be guessed
 * at. Everything below refuses rather than approximates.
 *
 * ## Why it can be trusted month to month
 *
 * A converter that half-works silently is worse than none, because the ledger
 * looks populated while it is wrong. Three things make a bad parse loud:
 *
 *  1. Rows are anchored on the account's last four digits, which every real
 *     transaction line carries between its reference number and its amount.
 *     A line that does not have that shape is not treated as a transaction.
 *  2. The statement prints its own section totals. The rows we parsed must sum
 *     to them exactly, in cents.
 *  3. Those totals must in turn reconcile against the balance arithmetic the
 *     statement also prints: previous + purchases + credits + interest == new.
 *
 * A layout change breaks one of those and the script exits non-zero having
 * written nothing. It never emits a partial CSV.
 *
 * ## Two conversions that are easy to get wrong
 *
 * **Sign.** The PDF is written from the card's point of view: a purchase is
 * positive because it increases what you owe, and a payment or refund is
 * negative. The ledger uses the opposite convention, where negative is money
 * leaving you. Every amount is therefore negated. The bank's own CSV export
 * does the same, which is why a refund shows there as a positive number.
 *
 * **Year.** Transaction rows carry only month and day. The year comes from the
 * statement closing date, and a row whose month is *after* the closing month
 * belongs to the previous year. That is what makes a December-to-January
 * statement come out right instead of twelve months adrift.
 */
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

/** Statement text we refuse to read at all, rather than guess about. */
export class UnrecognizedStatement extends Error {}

const AMOUNT = String.raw`-?\$?[\d,]+\.\d{2}`;

/** "-$5,491.51" -> -549151, in whole cents, so totals compare exactly. */
function cents(text) {
  const negative = text.trim().startsWith("-");
  const digits = text.replace(/[^\d.]/g, "");
  const value = Math.round(Number(digits) * 100);
  if (!Number.isFinite(value)) throw new UnrecognizedStatement(`Unreadable amount: ${text}`);
  return negative ? -value : value;
}

function findTotal(text, label) {
  const pattern = new RegExp(`${label}\\s+(${AMOUNT})`, "i");
  const hit = text.match(pattern);
  if (!hit) throw new UnrecognizedStatement(`Statement has no "${label}" line.`);
  return cents(hit[1]);
}

/**
 * Parse `pdftotext -layout` output. Kept separate from the CLI so the tests can
 * feed it inline strings — statement files are gitignored and never fixtures.
 */
export function parseBoaStatement(text) {
  if (!/BANK OF AMERICA/i.test(text)) {
    throw new UnrecognizedStatement("Not a Bank of America statement.");
  }

  const account = text.match(/Account\s*(?:Number:|#)\s*((?:\d{4}\s+){3}(\d{4}))/i);
  if (!account) throw new UnrecognizedStatement("Could not find the account number.");
  const last4 = account[2];

  const closing = text.match(/Statement Closing Date\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!closing) throw new UnrecognizedStatement("Could not find the statement closing date.");
  const closingMonth = Number(closing[1]);
  const closingYear = Number(closing[3]);

  // Month/day only. A month later than the closing month is last year's.
  const dated = (mmdd) => {
    const [mm, dd] = mmdd.split("/").map(Number);
    const year = mm > closingMonth ? closingYear - 1 : closingYear;
    return `${String(mm).padStart(2, "0")}/${String(dd).padStart(2, "0")}/${year}`;
  };

  // <trans date> <post date> <description> <ref> <account last 4> <amount>
  const row = new RegExp(
    String.raw`^\s*(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(.+?)\s+(\S+)\s+${last4}\s+(${AMOUNT})\s*$`,
  );
  // Interest lines carry no reference or account number, so they need their own
  // shape. They are usually 0.00 and dropped, but a month with a carried
  // balance has real ones and they are real spending.
  const interestRow = new RegExp(
    String.raw`^\s*(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(INTEREST CHARGED.+?)\s+(${AMOUNT})\s*$`,
    "i",
  );

  const transactions = [];
  let purchases = 0;
  let credits = 0;
  let interest = 0;

  for (const line of text.split("\n")) {
    const hit = line.match(row);
    const interestHit = hit ? null : line.match(interestRow);
    if (!hit && !interestHit) continue;

    const [, , postedRaw, descriptionRaw, reference, amountRaw] = hit ?? [
      null,
      null,
      interestHit[2],
      interestHit[3],
      "",
      interestHit[4],
    ];

    const onStatement = cents(amountRaw);
    if (hit) {
      if (onStatement >= 0) purchases += onStatement;
      else credits += onStatement;
    } else {
      interest += onStatement;
      if (onStatement === 0) continue; // a printed zero is not a transaction
    }

    transactions.push({
      postedDate: dated(postedRaw),
      reference,
      // The layout pads columns; the bank's CSV collapses that to single spaces.
      payee: descriptionRaw.replace(/\s+/g, " ").trim(),
      amount: -onStatement, // card's sign -> ledger's sign
    });
  }

  if (transactions.length === 0) {
    throw new UnrecognizedStatement("Found no transaction rows.");
  }

  // The statement's own totals, then the balance arithmetic tying them together.
  const declared = {
    purchases: findTotal(text, "TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD"),
    credits: findTotal(text, "TOTAL PAYMENTS AND OTHER CREDITS FOR THIS PERIOD"),
    interest: findTotal(text, "TOTAL INTEREST CHARGED FOR THIS PERIOD"),
    previousBalance: findTotal(text, "Previous Balance"),
    newBalance: findTotal(text, "New Balance Total"),
  };

  const mismatches = [];
  const check = (name, parsed, expected) => {
    if (parsed !== expected) {
      mismatches.push(`${name}: rows sum to ${money(parsed)}, statement says ${money(expected)}`);
    }
  };
  check("purchases", purchases, declared.purchases);
  check("payments and credits", credits, declared.credits);
  check("interest", interest, declared.interest);

  const balance = declared.previousBalance + declared.purchases + declared.credits + declared.interest;
  if (balance !== declared.newBalance) {
    mismatches.push(
      `balance: previous + purchases + credits + interest is ${money(balance)}, ` +
        `but new balance total is ${money(declared.newBalance)}`,
    );
  }

  return {
    accountLast4: last4,
    closingDate: `${closing[1]}/${closing[2]}/${closing[3]}`,
    transactions,
    mismatches,
  };
}

function money(c) {
  return `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
}

function csvField(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The same header the bank's own export uses, so the importer detects the
 * columns identically. `Address` is left empty: the PDF folds it into the
 * description and splitting it back out would be guesswork, and the importer
 * only needs a date, a description, and an amount. `Reference Number` carries
 * the four digits the PDF prints, not the bank's full-length one, which is not
 * on the statement. Neither field takes part in the dedupe fingerprint.
 */
export function toCsv(transactions) {
  const lines = ["Posted Date,Reference Number,Payee,Address,Amount"];
  for (const t of transactions) {
    lines.push(
      [t.postedDate, t.reference, t.payee, "", (t.amount / 100).toFixed(2)]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function extractText(pdfPath) {
  try {
    return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UnrecognizedStatement(
        "pdftotext is not installed. It ships with poppler, which Omarchy already has:\n" +
          "  sudo pacman -S --needed poppler",
      );
    }
    throw new UnrecognizedStatement(`pdftotext could not read ${pdfPath}: ${error.message}`);
  }
}

function main(argv) {
  const args = argv.slice(2);
  const toStdout = args.includes("--stdout");
  const outIndex = args.indexOf("--out");
  const explicitOut = outIndex >= 0 ? args[outIndex + 1] : null;
  const outValueIndex = outIndex >= 0 ? outIndex + 1 : -1;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== outValueIndex);
  const pdfPath = positional[0];

  if (!pdfPath) {
    process.stderr.write(
      "usage: omakei-convert-boa-pdf.mjs <statement.pdf> [--out file.csv] [--stdout]\n",
    );
    return 2;
  }

  const parsed = parseBoaStatement(extractText(pdfPath));

  if (parsed.mismatches.length > 0) {
    process.stderr.write(
      `Refusing to convert ${basename(pdfPath)}: the rows do not reconcile against the\n` +
        `statement's own totals, so the layout is not the one this script reads.\n\n` +
        parsed.mismatches.map((m) => `  ${m}\n`).join("") +
        `\nNothing was written.\n`,
    );
    return 1;
  }

  const csv = toCsv(parsed.transactions);
  if (toStdout) {
    process.stdout.write(csv);
    return 0;
  }

  const out =
    explicitOut ?? join(dirname(pdfPath), basename(pdfPath).replace(/\.pdf$/i, "") + ".csv");
  writeFileSync(out, csv);
  process.stderr.write(
    `${parsed.transactions.length} transactions -> ${out}\n` +
      `Reconciled against the statement closing ${parsed.closingDate} ` +
      `for account ending ${parsed.accountLast4}.\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv));
  } catch (error) {
    if (error instanceof UnrecognizedStatement) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
