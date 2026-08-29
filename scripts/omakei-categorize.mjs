#!/usr/bin/env node
/**
 * Add, update, or remove a categorize rule in the attached ledger, from the
 * terminal — the bulk-editing path the editor deliberately does not have.
 *
 *   omakei-categorize.mjs <pattern> <category-id>      add or update a user rule
 *   omakei-categorize.mjs --remove <pattern>           drop a user rule
 *   omakei-categorize.mjs --list                       merchants with no category yet
 *   omakei-categorize.mjs --dry-run <pattern> <id>     show what would change, write nothing
 *
 * A <pattern> is a key identifier ("safeway"), not the whole bank line, matched
 * the way the app matches: case-insensitive, town and store number ignored.
 * Wrap it in /slashes/ for a regex. Every rule written is source "user"; the
 * built-in patterns ship with the app and are never persisted here.
 *
 * The rule takes effect immediately — every transaction is re-categorized with
 * the shipped engine, the ledger is rewritten, and the bar's revision file is
 * bumped. Run this with the editor closed: an open tab holds the ledger in
 * memory and overwrites the file on its next edit. Reload the tab afterwards.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bumpRevisionAt,
  LEDGER_FILENAME,
  MAX_LEDGER_BYTES,
  MAX_STATE_BYTES,
  parseStateFile,
  readCapped,
  stateDirFor,
  writeAtomic,
} from "./ledger-api.mjs";
import { CATEGORIES } from "../src/lib/finance/categories.ts";
import { refreshCategories, seedRules, upsertRule } from "../src/lib/finance/ledger.ts";
import { extractMerchant } from "../src/lib/finance/fingerprint.ts";

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

async function resolveLedgerPath(env, home) {
  const raw = await readCapped(join(stateDirFor(env, home), "state.json"), MAX_STATE_BYTES);
  if (!raw) return "";
  const state = parseStateFile(raw.toString("utf8"));
  return state ? join(state.statementsDir, LEDGER_FILENAME) : "";
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

/** Mirrors store.ts `unknownMerchants`: null-category rows, grouped, biggest first. */
function uncategorizedMerchants(transactions) {
  const map = new Map();
  for (const tx of transactions) {
    if (tx.categoryId) continue;
    const merchant = extractMerchant(tx.description);
    const cur = map.get(merchant) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += tx.amount;
    map.set(merchant, cur);
  }
  return [...map.entries()]
    .map(([merchant, v]) => ({ merchant, ...v }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
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

function serialize(snapshot, transactions, users) {
  return `${JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    selectedMonth: typeof snapshot.selectedMonth === "string" ? snapshot.selectedMonth : "",
    transactions,
    rules: users,
    setAsides: Array.isArray(snapshot.setAsides) ? snapshot.setAsides : [],
  })}\n`;
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
  const dryRun = takeFlag(args, "--dry-run");
  const remove = takeFlag(args, "--remove");

  const path = await resolveLedgerPath(env, home);
  if (!path) return fail("No ledger found. Attach a folder in the editor first.");

  const raw = await readCapped(path, MAX_LEDGER_BYTES);
  if (!raw) return fail(`Could not read ${path}`);

  let snapshot;
  try {
    snapshot = JSON.parse(raw.toString("utf8"));
  } catch {
    return fail(`${path} is not valid JSON`);
  }
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.transactions)) {
    return fail(`${path} is not an Omakei ledger`);
  }

  const users = userRules(snapshot);
  const before = derive(snapshot.transactions, users);

  if (list) {
    const rows = uncategorizedMerchants(before);
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

  const [pattern, categoryId] = args;

  if (remove) {
    if (!pattern) return fail("Usage: omakei-categorize.mjs --remove <pattern>");
    const needle = pattern.trim().toLowerCase();
    const nextUsers = users.filter((r) => r.pattern.trim().toLowerCase() !== needle);
    if (nextUsers.length === users.length) {
      return fail(`No user rule matches "${pattern}".`);
    }
    return commit({
      env, home, path, snapshot, users: nextUsers,
      after: derive(snapshot.transactions, nextUsers),
      before, dryRun, note: `Removed rule "${pattern.trim()}"`,
    });
  }

  if (!pattern || !categoryId) {
    return fail(
      "Usage: omakei-categorize.mjs <pattern> <category-id>  (also --list, --remove, --dry-run)",
    );
  }
  if (!CATEGORY_IDS.includes(categoryId)) {
    return fail(`Unknown category "${categoryId}". One of: ${CATEGORY_IDS.join(", ")}`);
  }

  const nextUsers = upsertRule(users, pattern, categoryId);
  return commit({
    env, home, path, snapshot, users: nextUsers,
    after: derive(snapshot.transactions, nextUsers),
    before, dryRun, note: `Rule "${pattern.trim()}" → ${categoryId}`,
  });
}

async function commit({ env, home, path, snapshot, users, after, before, dryRun, note }) {
  const changed = retagged(before, after);
  const stillNull = after.filter((t) => !t.categoryId).length;
  process.stdout.write(`${note}\n`);
  process.stdout.write(
    `${changed} transaction${changed === 1 ? "" : "s"} re-tagged, ${stillNull} still uncategorized\n`,
  );
  if (dryRun) {
    process.stdout.write("(dry run — nothing written)\n");
    return 0;
  }
  await writeAtomic(path, serialize(snapshot, after, users));
  await bumpRevisionAt(stateDirFor(env, home));
  return 0;
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
