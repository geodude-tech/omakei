#!/usr/bin/env node
/**
 * List the recurring charges in the ledger -- the editor's "Recurring charges"
 * card, in a terminal:
 *
 *   omakei-subscriptions.mjs [--json] [ledger-path]
 *
 * `ledger-path` names `omakei-ledger.sqlite` or the folder holding it; absent,
 * the attached folder's ledger is used, found the same way the bar widget finds
 * it. Read-only: the database is opened read-only and nothing is written
 * anywhere -- output goes to stdout only. "Not a subscription" and dismissed
 * flags already in the ledger are honoured; marking is done in the editor.
 *
 * The detection is `src/lib/finance/subscriptions.ts`, the same function the
 * editor runs, so the two never disagree. No network, ever.
 */
import {
  findSubscriptions,
  monthlyTotal,
  parseSubscriptionMarks,
} from "../src/lib/finance/subscriptions.ts";
import { homedir } from "node:os";
import { readLedgerForWidget } from "./omakei-read-ledger.mjs";

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const money = (n) => `$${n.toFixed(2)}`;

/**
 * Merchant names are bank text a merchant chooses. Printed raw, an escape
 * sequence in one could rewrite or hide lines in the user's terminal, so
 * control characters are dropped from the table. `--json` escapes them anyway.
 */
// eslint-disable-next-line no-control-regex
const printable = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

function flagText(flag) {
  if (flag.kind === "price-up") return `up from ${money(flag.from ?? 0)}`;
  if (flag.kind === "new") return "new";
  return "seems to have stopped";
}

export async function run(
  argv,
  { env = process.env, home = homedir(), out = process.stdout, today = todayIso() } = {},
) {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  if (rest.length > 1 || rest.some((a) => a.startsWith("--"))) {
    process.stderr.write("Usage: omakei-subscriptions.mjs [--json] [ledger-path]\n");
    return 1;
  }
  const { path, ledger } = await readLedgerForWidget(rest[0] ?? "", { env, home });
  if (!ledger) {
    process.stderr.write(`No readable ledger${path ? ` at ${path}` : ""}.\n`);
    return 1;
  }
  const result = findSubscriptions(ledger.transactions, {
    today,
    marks: parseSubscriptionMarks(ledger.subscriptionMarks),
  });
  if (json) {
    out.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const { subscriptions, hidden, asOf } = result;
  if (subscriptions.length === 0) {
    out.write(`No recurring charges found (as of ${asOf || "no data"}).\n`);
    return 0;
  }
  const width = Math.min(32, Math.max(...subscriptions.map((s) => printable(s.merchant).length)));
  for (const s of subscriptions) {
    const flags = s.flags.length ? `  [${s.flags.map(flagText).join(", ")}]` : "";
    out.write(
      `${printable(s.merchant).slice(0, 32).padEnd(width)}  ${s.cadence.padEnd(7)}  ${money(s.typical).padStart(9)}  ` +
        `${money(s.monthly).padStart(9)}/mo  last ${s.lastDate}${s.stopped ? "" : `  next ${s.nextDate}`}${flags}\n`,
    );
  }
  const active = subscriptions.filter((s) => !s.stopped).length;
  out.write(
    `\n${active} active, ${subscriptions.length - active} stopped, ${hidden.length} marked not a subscription; ` +
      `about ${money(monthlyTotal(subscriptions))} a month (as of ${asOf}).\n`,
  );
  return 0;
}

if (process.argv[1]?.endsWith("omakei-subscriptions.mjs")) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exitCode = 1;
    });
}
