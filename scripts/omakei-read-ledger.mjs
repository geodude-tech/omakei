#!/usr/bin/env node
/**
 * Print what the widget should show, as one JSON object on stdout:
 *
 *   {"path": "/where/it/was/found",
 *    "ledger": {...} | null,
 *    "uncategorized": {"merchants": [{"merchant","count","total"}], "total": 9}}
 *
 * The path comes back because the panel shows it as a hint when there is no
 * data, and only this side knows where the ledger was actually resolved from.
 *
 * `uncategorized` is the popup's "Needs a category" section: the merchants with
 * no category yet, biggest first, each of which becomes a dropdown that runs
 * `omakei-categorize.mjs`. It is computed here rather than in `Model.js`
 * because the merchant key comes from `extractMerchant`, and a second
 * implementation of that in QML would name merchants the CLI does not
 * recognize. The grouping itself is `src/lib/finance/uncategorized.ts`, shared
 * with the editor and with `--list`, so all three name the same merchant.
 * `merchants` is capped; `total` is how many there really are.
 *
 * The bar widget used to read the state file and the ledger itself, through
 * QML's `FileView`. That was a second code path onto disk — the one thing
 * `ledger-api.mjs` is supposed to be — and `FileView` offers no way to refuse a
 * symlink, check the file is regular, or stop reading at a size. It also read
 * synchronously while the Omarchy bar was starting, so a large file or a stalled
 * mount hung the whole bar at login.
 *
 * So the widget spawns this instead. The read happens here, where the flags
 * exist, using the same `readCapped` the server uses. Nothing is duplicated:
 * change the safety rules in one place and both callers move together.
 *
 *   omakei-read-ledger.mjs [ledger-path-override]
 *
 * The override is the widget's `ledgerPath` setting, for a ledger kept
 * somewhere the editor did not put it. Empty or absent means "ask the state
 * file", which is the normal case.
 *
 * Always exits 0 and always prints valid JSON. The widget has no way to show an
 * error, and a bar that reads `null` and renders empty is the correct outcome
 * for every failure here.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_FILENAME,
  MAX_LEDGER_BYTES,
  MAX_STATE_BYTES,
  expandHome,
  isLedgerPayload,
  parseStateFile,
  readCapped,
  stateDirFor,
} from "./ledger-api.mjs";
import { uncategorizedMerchants } from "../src/lib/finance/uncategorized.ts";

/**
 * How many merchant rows the popup is handed. The popup is a glance, not the
 * rules table (docs/spec/bar-widget.md), and a ledger's long tail of one-off
 * merchants would turn it into one. The rest are `--list` in a terminal.
 */
const MAX_MERCHANTS = 6;

const NOTHING = { merchants: [], total: 0 };

/**
 * The section is the smallest thing here. A ledger the grouping cannot make
 * sense of costs the popup its "Needs a category" rows and nothing else -- the
 * month, the categories, and the activity still render.
 */
function uncategorizedFor(ledger) {
  if (!ledger || !Array.isArray(ledger.transactions)) return NOTHING;
  try {
    const rows = uncategorizedMerchants(ledger.transactions);
    return { merchants: rows.slice(0, MAX_MERCHANTS), total: rows.length };
  } catch {
    return NOTHING;
  }
}

async function resolveLedgerPath(override, env, home) {
  const wanted = expandHome(override, home);
  if (wanted) return wanted;
  const raw = await readCapped(join(stateDirFor(env, home), "state.json"), MAX_STATE_BYTES);
  if (!raw) return "";
  const state = parseStateFile(raw.toString("utf8"));
  return state ? join(state.statementsDir, LEDGER_FILENAME) : "";
}

/** `env` and `home` are parameters for the same reason they are in
 *  `createLedgerApi`: the state file's location depends on both, and a test
 *  that cannot move them ends up reading the real one. */
export async function readLedgerForWidget(override = "", { env = process.env, home = homedir() } = {}) {
  const path = await resolveLedgerPath(override, env, home);
  if (!path) return { path: "", ledger: null, uncategorized: NOTHING };
  const raw = await readCapped(path, MAX_LEDGER_BYTES);
  // The path is reported even when the read fails: "there should be a ledger
  // here and there is not" is exactly what the panel's empty state says.
  if (!raw) return { path, ledger: null, uncategorized: NOTHING };
  let ledger = null;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    ledger = isLedgerPayload(parsed) ? parsed : null;
  } catch {
    return { path, ledger: null, uncategorized: NOTHING };
  }
  // Outside the parse guard on purpose: grouping the merchants must never be
  // able to turn a ledger that parsed into one the widget is told is missing.
  return { path, ledger, uncategorized: uncategorizedFor(ledger) };
}

if (process.argv[1]?.endsWith("omakei-read-ledger.mjs")) {
  readLedgerForWidget(process.argv[2] ?? "")
    .then((out) => process.stdout.write(JSON.stringify(out)))
    .catch(() => process.stdout.write('{"path":"","ledger":null}'));
}
