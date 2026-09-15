#!/usr/bin/env node
/**
 * Add, update, or remove a categorize rule in the attached ledger, from the
 * terminal — the bulk-editing path the editor deliberately does not have.
 *
 *   omakei-categorize.mjs <pattern> <category-id>      add or update a user rule
 *   omakei-categorize.mjs --remove <pattern>           drop a user rule
 *   omakei-categorize.mjs --list                       merchants with no category yet
 *   omakei-categorize.mjs --list --json                the same list, as JSON
 *   omakei-categorize.mjs --dry-run <pattern> <id>     show what would change, write nothing
 *
 * A <pattern> is a key identifier ("safeway"), not the whole bank line, matched
 * the way the app matches: case-insensitive, town and store number ignored.
 * Wrap it in /slashes/ for a regex. Every rule written is source "user"; the
 * built-in patterns ship with the app and are never persisted here.
 *
 * The rule takes effect immediately — every transaction is re-categorized with
 * the shipped engine, the ledger is rewritten, and the bar's revision file is
 * bumped.
 *
 * Safe to run with the editor open. The read, the re-categorize, and the write
 * are one SQLite transaction, so nothing -- the editor's server included -- can
 * write in between. The editor's next save is derived from the version before
 * this one, so the server refuses it and the editor merges this rule in; reload
 * the tab to see it sooner.
 *
 * A folder that still holds only `omakei-ledger.json` is imported into
 * `omakei-ledger.sqlite` the first time this runs. The JSON is not written.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bumpRevisionAt,
  DB_FILENAME,
  LEDGER_FILENAME,
  MAX_STATE_BYTES,
  parseStateFile,
  readCapped,
  stateDirFor,
} from "./ledger-api.mjs";
import { jsonChangedSinceImport, readLedgerDb, updateLedgerDb } from "./ledger-db.mjs";
import { CATEGORIES } from "../src/lib/finance/categories.ts";
import { refreshCategories, seedRules, upsertRule } from "../src/lib/finance/ledger.ts";
import { uncategorizedMerchants } from "../src/lib/finance/uncategorized.ts";

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

async function resolveStatementsDir(env, home) {
  const raw = await readCapped(join(stateDirFor(env, home), "state.json"), MAX_STATE_BYTES);
  if (!raw) return "";
  return parseStateFile(raw.toString("utf8"))?.statementsDir ?? "";
}

/** The user's own rules, as they sit on disk (the defaults are not persisted). */
function userRules(snapshot) {
  return (snapshot.rules ?? []).filter(
    (r) => r && r.source === "user" && r.pattern && r.categoryId,
  );
}

/** Re-run the shipped categorizer: user rules first, then the built-ins. */
function derive(transactions, users) {
  return refreshCategories(transactions, [...users, ...seedRules()]);
}

function retagged(before, after) {
  let n = 0;
  for (let i = 0; i < after.length; i++) {
    if ((before[i]?.categoryId ?? null) !== (after[i].categoryId ?? null)) n += 1;
  }
  return n;
}

function money(n) {
  return `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

function takeFlag(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

export async function run(argv, { env = process.env, home = homedir() } = {}) {
  const args = [...argv];
  const list = takeFlag(args, "--list");
  const json = takeFlag(args, "--json");
  const dryRun = takeFlag(args, "--dry-run");
  const remove = takeFlag(args, "--remove");
  const [pattern, categoryId] = args;

  // Everything that can be wrong with the command is refused before the
  // ledger is opened, so a mistyped command cannot so much as import it.
  if (json && !list) return fail("--json only applies to --list.");
  if (!list && remove && !pattern) return fail("Usage: omakei-categorize.mjs --remove <pattern>");
  if (!list && !remove) {
    if (!pattern || !categoryId) {
      return fail(
        "Usage: omakei-categorize.mjs <pattern> <category-id>  (also --list [--json], --remove, --dry-run)",
      );
    }
    if (!CATEGORY_IDS.includes(categoryId)) {
      return fail(`Unknown category "${categoryId}". One of: ${CATEGORY_IDS.join(", ")}`);
    }
  }

  const dir = await resolveStatementsDir(env, home);
  if (!dir) return fail("No ledger found. Attach a folder in the editor first.");
  const path = join(dir, DB_FILENAME);

  if (list) {
    const found = await readLedgerDb(dir, { importJson: true });
    if (!found?.ledger) return fail(`Could not read ${path}`);
    await warnIfJsonChanged(dir);
    return printList(derive(found.ledger.transactions, userRules(found.ledger)), json);
  }

  // The decision runs inside the write lock, against the ledger as it is at
  // that moment. There is no earlier read for it to be stale against.
  let outcome;
  const result = await updateLedgerDb(
    dir,
    ({ ledger }) => {
      if (!ledger) return null;
      const users = userRules(ledger);
      let nextUsers;
      let note;
      if (remove) {
        const needle = pattern.trim().toLowerCase();
        nextUsers = users.filter((r) => r.pattern.trim().toLowerCase() !== needle);
        if (nextUsers.length === users.length) {
          outcome = { error: `No user rule matches "${pattern}".` };
          return null;
        }
        note = `Removed rule "${pattern.trim()}"`;
      } else {
        nextUsers = upsertRule(users, pattern, categoryId);
        note = `Rule "${pattern.trim()}" → ${categoryId}`;
      }
      const before = derive(ledger.transactions, users);
      const after = derive(ledger.transactions, nextUsers);
      outcome = { note, before, after };
      if (dryRun) return null;
      return {
        version: 1,
        savedAt: new Date().toISOString(),
        selectedMonth: typeof ledger.selectedMonth === "string" ? ledger.selectedMonth : "",
        transactions: after,
        rules: nextUsers,
        setAsides: Array.isArray(ledger.setAsides) ? ledger.setAsides : [],
      };
    },
    { create: false },
  );

  if (!result?.ledger && !outcome) return fail(`Could not read ${path}`);
  await warnIfJsonChanged(dir);
  if (outcome.error) return fail(outcome.error);
  if (result.written) await bumpRevisionAt(stateDirFor(env, home));
  report(outcome.note, outcome.before, outcome.after);
  if (dryRun) process.stdout.write("(dry run — nothing written)\n");
  return 0;
}

function printList(transactions, json) {
  const rows = uncategorizedMerchants(transactions);
  // `--json` is for a caller that is going to do something with the answer
  // rather than read it: an agent picking merchants to write rules for. The
  // empty case is an empty array, not a sentence.
  if (json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("Nothing uncategorized.\n");
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.merchant.length));
  for (const r of rows) {
    process.stdout.write(
      `${r.merchant.padEnd(width)}  ${String(r.count).padStart(4)}  ${money(r.total)}\n`,
    );
  }
  return 0;
}

/**
 * The ledger is the database now, so a rule written to the old JSON by an
 * out-of-date copy of this command is not in it. Say so on stderr, where it
 * does not disturb `--list --json`.
 */
async function warnIfJsonChanged(dir) {
  if (await jsonChangedSinceImport(dir)) {
    process.stderr.write(
      `warning: ${join(dir, LEDGER_FILENAME)} changed after it was imported; ` +
        `those changes are not in ${join(dir, DB_FILENAME)}\n`,
    );
  }
}

function report(note, before, after) {
  const changed = retagged(before, after);
  const stillNull = after.filter((t) => !t.categoryId).length;
  process.stdout.write(`${note}\n`);
  process.stdout.write(
    `${changed} transaction${changed === 1 ? "" : "s"} re-tagged, ${stillNull} still uncategorized\n`,
  );
}

if (process.argv[1]?.endsWith("omakei-categorize.mjs")) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exitCode = 1;
    });
}
