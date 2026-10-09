#!/usr/bin/env node
/**
 * Every run prints exactly one JSON object on stdout and nothing on stderr, so
 * a caller only ever parses stdout. Exit codes: 0 ok, 1 no ledger, 2 usage.
 * The numbers come from the code the dashboard runs, so they follow
 * docs/ledger.md. See the README section "Asking from a script".
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SCHEMA_VERSION } from "./ledger-db.mjs";
import { readLedgerForWidget } from "./omakei-read-ledger.mjs";
import { CATEGORY_BY_ID } from "../src/lib/finance/categories.ts";
import { isIncome, isSpend } from "../src/lib/finance/ledger.ts";
import { parseSetAsides, roundMoney } from "../src/lib/finance/set-asides.ts";
import { categoryTotals, monthSummary } from "../src/lib/finance/summaries.ts";
import { monthKey, todayIso } from "../src/lib/dates.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const DEFAULT_TOP = 5;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

class CliError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}
const usage = (message) => new CliError("usage", message, 2);

function parseArgs(argv, { values = [], flags = [] } = {}) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw usage(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (Object.hasOwn(out, name)) throw usage(`--${name} given twice`);
    if (flags.includes(name)) {
      if (eq !== -1) throw usage(`--${name} takes no value`);
      out[name] = true;
    } else if (values.includes(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (!value || (eq === -1 && value.startsWith("--"))) {
        throw usage(`--${name} needs a value`);
      }
      out[name] = value;
    } else {
      throw usage(`Unknown option: --${name}`);
    }
  }
  return out;
}

function positiveInt(name, raw, max) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1)
    throw usage(`--${name} must be a whole number of 1 or more`);
  return Math.min(Number(raw), max);
}

function categoryId(raw) {
  const id = String(raw).trim().toLowerCase();
  if (!Object.hasOwn(CATEGORY_BY_ID, id)) {
    throw usage(`Unknown category: ${raw}. Use one of: ${Object.keys(CATEGORY_BY_ID).join(", ")}`);
  }
  return id;
}

async function loadLedger(override, { env, home }) {
  const { path, ledger } = await readLedgerForWidget(override ?? "", { env, home });
  if (!path) {
    throw new CliError("no-ledger", "No folder is attached yet, so there is no ledger to read.", 1);
  }
  if (!ledger || !Array.isArray(ledger.transactions)) {
    throw new CliError("no-ledger", `No readable ledger at ${path}.`, 1);
  }
  return { path, ledger };
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function dateRange(rows) {
  if (rows.length === 0) return null;
  let first = rows[0].date;
  let last = rows[0].date;
  for (const tx of rows) {
    if (tx.date < first) first = tx.date;
    if (tx.date > last) last = tx.date;
  }
  return { first, last };
}

function infoData({ path, ledger }) {
  const rows = ledger.transactions;
  const accounts = new Map();
  for (const tx of rows) {
    const key = `${tx.accountName}\u0000${tx.accountKind}`;
    const a = accounts.get(key) ?? {
      name: tx.accountName,
      kind: tx.accountKind,
      count: 0,
      first: tx.date,
      last: tx.date,
    };
    a.count += 1;
    if (tx.date < a.first) a.first = tx.date;
    if (tx.date > a.last) a.last = tx.date;
    accounts.set(key, a);
  }
  const imports = Array.isArray(ledger.importedFiles) ? ledger.importedFiles : [];
  const lastImportMs = imports.reduce(
    (max, f) => (Number(f.importedAt) > max ? Number(f.importedAt) : max),
    0,
  );
  return {
    ledgerPath: path,
    transactionCount: rows.length,
    dateRange: dateRange(rows),
    accounts: [...accounts.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
    uncategorizedCount: rows.filter((tx) => !tx.categoryId).length,
    savedAt: typeof ledger.savedAt === "string" && ledger.savedAt ? ledger.savedAt : null,
    lastImportAt: lastImportMs > 0 ? new Date(lastImportMs).toISOString() : null,
  };
}

function summaryData({ ledger }, { month, top = DEFAULT_TOP }) {
  const rows = ledger.transactions.filter((tx) => monthKey(tx.date) === month);
  const setAsides = parseSetAsides(ledger.setAsides);
  const stats = monthSummary(rows, setAsides);
  const uncategorizedSpent = rows.reduce(
    (sum, tx) => (isSpend(tx) && !tx.categoryId ? sum + Math.abs(tx.amount) : sum),
    0,
  );
  const categories = categoryTotals(rows);
  const spent = roundMoney(stats.spent);
  return {
    month,
    transactionCount: rows.length,
    income: roundMoney(stats.income),
    spent,
    cashflow: roundMoney(stats.cashflow),
    setAsides: stats.allocated,
    net: stats.net,
    uncategorized: { count: stats.uncategorized, spent: roundMoney(uncategorizedSpent) },
    topCategories: categories.slice(0, top).map((c) => ({
      id: c.id,
      name: c.name,
      spent: roundMoney(c.total),
      share: spent > 0 ? Math.round((c.total / stats.spent) * 1000) / 1000 : 0,
    })),
    categoryCount: categories.length,
  };
}

function txData({ ledger }, filters) {
  const { from, to, account, category, uncategorized, search, limit = DEFAULT_LIMIT } = filters;
  const accountNeedle = account?.toLowerCase();
  const searchNeedle = search?.toLowerCase();
  const matched = ledger.transactions
    .filter((tx) => {
      if (from && tx.date < from) return false;
      if (to && tx.date > to) return false;
      if (accountNeedle && String(tx.accountName).toLowerCase() !== accountNeedle) return false;
      if (category && tx.categoryId !== category) return false;
      if (uncategorized && tx.categoryId) return false;
      if (searchNeedle && !String(tx.description).toLowerCase().includes(searchNeedle))
        return false;
      return true;
    })
    .sort((a, b) => byDate(b, a) || String(a.id).localeCompare(String(b.id)));
  let spent = 0;
  let income = 0;
  for (const tx of matched) {
    if (isSpend(tx)) spent += Math.abs(tx.amount);
    if (isIncome(tx)) income += tx.amount;
  }
  const returned = matched.slice(0, limit);
  return {
    filters: Object.fromEntries(
      Object.entries({ from, to, account, category, uncategorized, search }).filter(
        ([, v]) => v !== undefined,
      ),
    ),
    matched: matched.length,
    returned: returned.length,
    truncated: matched.length > returned.length,
    totals: { spent: roundMoney(spent), income: roundMoney(income) },
    transactions: returned.map((tx) => ({
      id: tx.id,
      date: tx.date,
      description: tx.description,
      amount: tx.amount,
      accountName: tx.accountName,
      accountKind: tx.accountKind,
      categoryId: tx.categoryId ?? null,
      categoryName: tx.categoryId ? (CATEGORY_BY_ID[tx.categoryId]?.name ?? null) : null,
    })),
  };
}

const COMMANDS = {
  async info(argv, ctx) {
    const args = parseArgs(argv, { values: ["ledger"] });
    return infoData(await loadLedger(args.ledger, ctx));
  },
  async summary(argv, ctx) {
    const args = parseArgs(argv, { values: ["ledger", "month", "top"] });
    const month = args.month ?? monthKey(ctx.today);
    if (!MONTH.test(month)) throw usage("--month must look like YYYY-MM");
    const top = positiveInt("top", args.top, 20) ?? DEFAULT_TOP;
    return summaryData(await loadLedger(args.ledger, ctx), { month, top });
  },
  async tx(argv, ctx) {
    const args = parseArgs(argv, {
      values: ["ledger", "from", "to", "account", "category", "search", "limit"],
      flags: ["uncategorized"],
    });
    for (const name of ["from", "to"]) {
      if (args[name] !== undefined && !DAY.test(args[name]))
        throw usage(`--${name} must look like YYYY-MM-DD`);
    }
    if (args.from && args.to && args.from > args.to) throw usage("--from is after --to");
    if (args.category !== undefined && args.uncategorized) {
      throw usage("--category and --uncategorized cannot be used together");
    }
    for (const name of ["account", "search"]) {
      if (args[name] !== undefined && args[name].trim() === "")
        throw usage(`--${name} needs a value`);
    }
    const filters = {
      from: args.from,
      to: args.to,
      account: args.account?.trim(),
      category: args.category === undefined ? undefined : categoryId(args.category),
      uncategorized: args.uncategorized || undefined,
      search: args.search?.trim(),
      limit: positiveInt("limit", args.limit, MAX_LIMIT),
    };
    return txData(await loadLedger(args.ledger, ctx), filters);
  },
};

const USAGE =
  "omakei.mjs <info|summary|tx> [options]  (summary: --month YYYY-MM --top N; " +
  "tx: --from --to --account --category --uncategorized --search --limit; all: --ledger PATH)";

export async function run(
  argv,
  { env = process.env, home = homedir(), out = process.stdout, today = todayIso() } = {},
) {
  const [command, ...rest] = argv;
  const envelope = {
    ok: true,
    version: readVersion(),
    schemaVersion: SCHEMA_VERSION,
    command: command ?? null,
  };
  let code = 0;
  try {
    const handler = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!handler) throw usage(command ? `Unknown command: ${command}. ${USAGE}` : USAGE);
    envelope.data = await handler(rest, { env, home, today });
  } catch (err) {
    const known = err instanceof CliError;
    envelope.ok = false;
    envelope.error = { code: known ? err.code : "internal", message: String(err?.message ?? err) };
    code = known ? err.exitCode : 1;
  }
  out.write(`${JSON.stringify(envelope)}\n`);
  return code;
}

if (process.argv[1]?.endsWith("omakei.mjs")) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "internal", message: String(err?.message ?? err) } })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
