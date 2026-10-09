/**
 * `omakei.mjs`: one JSON object on stdout per run, the dashboard's numbers,
 * the ledger found the way the widget finds it, and nothing written.
 *
 * Every row here is invented.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { ledgerDirFor, renderStateFile } from "./ledger-api.mjs";
import { updateLedgerDb } from "./ledger-db.mjs";
import { run } from "./omakei.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function privateDir() {
  const dir = mkdtempSync(join(tmpdir(), "omakei-cli-"));
  temps.push(dir);
  return dir;
}

let seq = 0;
function row(
  date,
  description,
  amount,
  categoryId,
  accountName = "Checking",
  accountKind = "checking",
) {
  seq += 1;
  return {
    id: `t${seq}`,
    date,
    description,
    amount,
    accountName,
    accountKind,
    sourceFile: `${accountName.toLowerCase().replace(/\s+/g, "-")}.csv`,
    fingerprint: `f${seq}`,
    categoryId,
    importedAt: 0,
  };
}

/** Two months, two accounts, a card payment on both sides, and loose ends. */
function syntheticLedger() {
  seq = 0;
  const card = (date, description, amount, categoryId) =>
    row(date, description, amount, categoryId, "Credit Card", "credit");
  return {
    version: 1,
    savedAt: "2026-09-30T12:00:00.000Z",
    selectedMonth: "2026-09",
    transactions: [
      row("2026-08-01", "ACME PAYROLL", 3000, "income"),
      card("2026-08-04", "CORNER BISTRO", -60, "dining"),
      card("2026-08-09", "GREENLEAF MARKET", -140, "groceries"),
      row("2026-08-20", "CARD PAYMENT THANK YOU", -200, "transfers"),
      card("2026-08-20", "PAYMENT RECEIVED", 200, "transfers"),
      row("2026-09-01", "ACME PAYROLL", 3000, "income"),
      row("2026-09-02", "MAPLE APARTMENTS RENT", -1500, "housing"),
      card("2026-09-05", "CORNER BISTRO", -45.5, "dining"),
      card("2026-09-12", "GREENLEAF MARKET", -120.25, "groceries"),
      card("2026-09-14", "CORNER BISTRO", -30, "dining"),
      card("2026-09-18", "MYSTERY SHOP 42", -19.99, null),
      row("2026-09-21", "CARD PAYMENT THANK YOU", -215.74, "transfers"),
      card("2026-09-21", "PAYMENT RECEIVED", 215.74, "transfers"),
      row("2026-09-25", "REFUND FROM NOWHERE", 10, null),
    ],
    rules: [],
    setAsides: [{ id: "s1", name: "Taxes", amount: 500 }],
  };
}

/** A home whose state file points at a statements folder, with the ledger where the editor puts it. */
async function attachedHome() {
  const home = privateDir();
  const env = { XDG_STATE_HOME: join(home, "state") };
  const statements = join(home, "statements");
  mkdirSync(statements, { recursive: true });
  const ledgerDir = ledgerDirFor(statements, env, home);
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  assert.ok(await updateLedgerDb(ledgerDir, () => syntheticLedger()));
  writeFileSync(
    join(env.XDG_STATE_HOME, "omakei", "state.json"),
    renderStateFile(statements, ledgerDir),
  );
  return { home, env, ledgerDir, file: join(ledgerDir, "omakei-ledger.sqlite") };
}

async function call(argv, opts) {
  let text = "";
  const out = { write: (s) => (text += s) };
  const code = await run(argv, { today: "2026-09-28", ...opts, out });
  assert.equal(text.trim().split("\n").length, 1, "exactly one line of output");
  return { code, body: JSON.parse(text) };
}

test("info finds the ledger through state.json, under ledgers/<id>/", async () => {
  const { home, env, file } = await attachedHome();
  const { code, body } = await call(["info"], { home, env });
  assert.equal(code, 0);
  assert.equal(body.ok, true);
  assert.equal(body.command, "info");
  assert.equal(body.version, JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")).version);
  assert.equal(typeof body.schemaVersion, "number");
  assert.equal(body.data.ledgerPath, file);
  assert.match(body.data.ledgerPath, /\/omakei\/ledgers\/[0-9a-f]{16}\/omakei-ledger\.sqlite$/);
  assert.equal(body.data.transactionCount, 14);
  assert.deepEqual(body.data.dateRange, { first: "2026-08-01", last: "2026-09-25" });
  assert.deepEqual(body.data.accounts, [
    { name: "Credit Card", kind: "credit", count: 8, first: "2026-08-04", last: "2026-09-21" },
    { name: "Checking", kind: "checking", count: 6, first: "2026-08-01", last: "2026-09-25" },
  ]);
  assert.equal(body.data.uncategorizedCount, 2);
  assert.equal(body.data.savedAt, "2026-09-30T12:00:00.000Z");
});

test("summary matches the dashboard: transfers left out, uncategorized counted, set-asides off net", async () => {
  const { home, env } = await attachedHome();
  const { code, body } = await call(["summary"], { home, env });
  assert.equal(code, 0);
  const d = body.data;
  assert.equal(d.month, "2026-09", "defaults to the current month");
  assert.equal(d.income, 3010);
  assert.equal(d.spent, 1715.74);
  assert.equal(d.cashflow, 1294.26);
  assert.equal(d.setAsides, 500);
  assert.equal(d.net, 794.26);
  assert.deepEqual(d.uncategorized, { count: 2, spent: 19.99 });
  assert.deepEqual(
    d.topCategories.map((c) => [c.id, c.name, c.spent]),
    [
      ["housing", "Housing", 1500],
      ["groceries", "Groceries", 120.25],
      ["dining", "Dining", 75.5],
      ["other", "Other", 19.99],
    ],
  );
  assert.equal(d.topCategories[0].share, 0.874);
});

test("summary --month picks another month, and --top trims the categories", async () => {
  const { file } = await attachedHome();
  const { body } = await call(["summary", "--month", "2026-08", "--top=1", "--ledger", file], {
    home: privateDir(),
    env: {},
  });
  assert.equal(body.data.month, "2026-08");
  assert.equal(body.data.spent, 200);
  assert.equal(body.data.income, 3000);
  assert.deepEqual(
    body.data.topCategories.map((c) => c.id),
    ["groceries"],
  );
  assert.equal(body.data.categoryCount, 2);
});

test("an empty month is zeros, not an error", async () => {
  const { home, env } = await attachedHome();
  const { code, body } = await call(["summary", "--month", "2025-01"], { home, env });
  assert.equal(code, 0);
  assert.equal(body.data.transactionCount, 0);
  assert.equal(body.data.spent, 0);
  assert.equal(body.data.net, -500);
  assert.deepEqual(body.data.topCategories, []);
});

test("tx filters by date, category, account, and text, newest first, with totals", async () => {
  const { home, env } = await attachedHome();
  const ctx = { home, env };

  const dining = (await call(["tx", "--category", "Dining", "--from", "2026-09-01"], ctx)).body
    .data;
  assert.deepEqual(
    dining.transactions.map((t) => [t.date, t.amount]),
    [
      ["2026-09-14", -30],
      ["2026-09-05", -45.5],
    ],
  );
  assert.equal(dining.transactions[0].categoryName, "Dining");
  assert.deepEqual(dining.totals, { spent: 75.5, income: 0 });
  assert.deepEqual(dining.filters, { from: "2026-09-01", category: "dining" });

  const checking = (await call(["tx", "--account", "checking", "--to", "2026-08-31"], ctx)).body
    .data;
  assert.equal(checking.matched, 2);
  assert.ok(checking.transactions.every((t) => t.accountName === "Checking"));
  assert.deepEqual(
    checking.totals,
    { spent: 0, income: 3000 },
    "the card payment is a transfer, not spend",
  );

  const loose = (await call(["tx", "--uncategorized"], ctx)).body.data;
  assert.deepEqual(
    loose.transactions.map((t) => t.description),
    ["REFUND FROM NOWHERE", "MYSTERY SHOP 42"],
  );
  assert.ok(loose.transactions.every((t) => t.categoryId === null && t.categoryName === null));

  const bistro = (await call(["tx", "--search", "bistro", "--limit", "2"], ctx)).body.data;
  assert.equal(bistro.matched, 3);
  assert.equal(bistro.returned, 2);
  assert.equal(bistro.truncated, true);
  assert.deepEqual(
    bistro.totals,
    { spent: 135.5, income: 0 },
    "totals cover every match, not just the page",
  );
});

test("bad input is a JSON usage error with exit 2", async () => {
  const { home, env } = await attachedHome();
  for (const argv of [
    [],
    ["nope"],
    ["summary", "--month", "2026-13"],
    ["summary", "--frobnicate"],
    ["tx", "--from", "yesterday"],
    ["tx", "--from", "2026-09-10", "--to", "2026-09-01"],
    ["tx", "--category", "lottery"],
    ["tx", "--category", "dining", "--uncategorized"],
    ["tx", "--limit", "0"],
    ["tx", "--search"],
    ["info", "--month", "2026-01", "--month", "2026-02"],
  ]) {
    const { code, body } = await call(argv, { home, env });
    assert.equal(code, 2, argv.join(" "));
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "usage");
    assert.equal(typeof body.error.message, "string");
    assert.equal(body.data, undefined);
  }
});

test("no attached folder is a JSON error with exit 1, not a search of the disk", async () => {
  const home = privateDir();
  const { code, body } = await call(["info"], {
    home,
    env: { XDG_STATE_HOME: join(home, "state") },
  });
  assert.equal(code, 1);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "no-ledger");
});

test("the CLI leaves the ledger byte for byte alone", async () => {
  const { home, env, ledgerDir, file } = await attachedHome();
  const before = {
    bytes: readFileSync(file),
    mtime: statSync(file).mtimeMs,
    entries: readdirSync(ledgerDir),
  };
  for (const argv of [["info"], ["summary"], ["tx", "--limit", "3"]])
    await call(argv, { home, env });
  assert.deepEqual(readFileSync(file), before.bytes);
  assert.equal(statSync(file).mtimeMs, before.mtime);
  assert.deepEqual(readdirSync(ledgerDir), before.entries);
});

test("runs from a copy with no node_modules, as an installed plugin would", async () => {
  const { home, env } = await attachedHome();
  const copy = privateDir();
  cpSync(join(ROOT, "scripts"), join(copy, "scripts"), { recursive: true });
  cpSync(join(ROOT, "src", "lib"), join(copy, "src", "lib"), { recursive: true });
  cpSync(join(ROOT, "manifest.json"), join(copy, "manifest.json"));
  const res = spawnSync(
    process.execPath,
    [join(copy, "scripts", "omakei.mjs"), "summary", "--month", "2026-09"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: env.XDG_STATE_HOME },
    },
  );
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.data.net, 794.26);
});

test("a failure still prints one JSON object and exits nonzero", () => {
  const home = privateDir();
  const res = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "omakei.mjs"), "tx", "--limit", "-1"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, "state") },
    },
  );
  assert.equal(res.status, 2);
  const body = JSON.parse(res.stdout);
  assert.equal(body.ok, false);
});
