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
  parseSubscriptionMarks,
  SUBSCRIPTION_KINDS,
} from "../src/lib/finance/subscriptions.ts";
import { homedir } from "node:os";
import { readLedgerForWidget } from "./omakei-read-ledger.mjs";

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const money = (n) => `$${n.toFixed(2)}`;

const HEADING = { subscription: "Subscriptions", bill: "Bills", other: "Other recurring" };

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
  const { subscriptions, hidden, totals, asOf } = result;
  if (subscriptions.length === 0) {
    out.write(`No recurring charges found (as of ${asOf || "no data"}).\n`);
    return 0;
  }
  const width = Math.min(32, Math.max(...subscriptions.map((s) => printable(s.merchant).length)));
  const name = (s) => printable(s.merchant).slice(0, 32).padEnd(width);
  const notes = (s, extra) => {
    const all = [...extra, ...s.flags.map(flagText)];
    return all.length ? `  [${all.join(", ")}]` : "";
  };
  for (const kind of SUBSCRIPTION_KINDS) {
    const rows = subscriptions.filter((s) => s.kind === kind);
    if (rows.length === 0) continue;
    out.write(`${HEADING[kind]}\n`);
    const unscheduled = rows.filter((s) => s.cadence === "unknown");
    for (const s of rows) {
      if (s.cadence === "unknown") continue;
      out.write(
        `${name(s)}  ${s.cadence.padEnd(7)}  ${money(s.typical).padStart(9)}  ` +
          `${money(s.monthly).padStart(9)}/mo  last ${s.lastDate}${s.stopped ? "" : `  next ${s.nextDate}`}` +
          `${notes(s, s.confidence === "tagged" ? ["tagged"] : [])}\n`,
      );
    }
    if (unscheduled.length) {
      out.write("Tagged, no schedule yet (not in the monthly total):\n");
      for (const s of unscheduled) {
        out.write(
          `${name(s)}  ${money(s.typical).padStart(9)}  ${s.count} ${s.count === 1 ? "charge" : "charges"}  ` +
            `last ${s.lastDate}${notes(s, [])}\n`,
        );
      }
    }
    const active = rows.filter((s) => !s.stopped && s.cadence !== "unknown").length;
    out.write(`${HEADING[kind]}: about ${money(totals[kind])} a month across ${active}.\n\n`);
  }
  const active = subscriptions.filter((s) => !s.stopped && s.cadence !== "unknown").length;
  const stopped = subscriptions.filter((s) => s.stopped).length;
  const waiting = subscriptions.filter((s) => s.cadence === "unknown").length;
  out.write(
    `${active} active, ${stopped} stopped, ${waiting ? `${waiting} tagged with no schedule yet, ` : ""}` +
      `${hidden.length} marked not a subscription (as of ${asOf}).\n`,
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
