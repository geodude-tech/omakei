#!/usr/bin/env node
/**
 * Print the ledger the widget should show, as JSON on stdout, or `null`.
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
  if (!path) return null;
  const raw = await readCapped(path, MAX_LEDGER_BYTES);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return isLedgerPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

if (process.argv[1]?.endsWith("omakei-read-ledger.mjs")) {
  readLedgerForWidget(process.argv[2] ?? "")
    .then((ledger) => process.stdout.write(JSON.stringify(ledger)))
    .catch(() => process.stdout.write("null"));
}
