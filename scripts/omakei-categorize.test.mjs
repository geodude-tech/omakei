/**
 * The terminal path for bulk categorize edits. Each test drives the real CLI
 * against a throwaway home whose state file points at a throwaway ledger.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { renderStateFile } from "./ledger-api.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const TX = [
  txOf("a", "STARBUCKS STORE 09876 SAN JOSE CA", -6.25),
  txOf("b", "ZORP WIDGETS 5567", -12.5),
  txOf("c", "ZORP WIDGETS 1180", -30),
  txOf("d", "NETFLIX.COM 866-579-7172 CA", -15.99),
];

function txOf(id, description, amount) {
  return {
    id,
    date: "2026-08-10",
    description,
    amount,
    accountName: "checking",
    accountKind: "checking",
    sourceFile: "f.csv",
    fingerprint: `fp:${id}`,
    categoryId: null,
    importedAt: 0,
  };
}

/** A home with a state file pointing at a statements folder that holds a ledger. */
function attachedLedger(snapshot) {
  const root = mkdtempSync(join(tmpdir(), "omakei-cat-"));
  temps.push(root);
  const home = join(root, "home");
  const statements = join(home, "Statements");
  mkdirSync(statements, { recursive: true });
  const stateDir = join(home, ".local", "state", "omakei");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), renderStateFile(statements));
  const ledgerPath = join(statements, "omakei-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify({ version: 1, selectedMonth: "2026-08", transactions: snapshot, rules: [] }),
  );
  return { home, ledgerPath, revisionPath: join(stateDir, "ledger-revision") };
}

/** Run the CLI; returns { status, stdout, stderr }. */
function cli(args, home) {
  try {
    const stdout = execFileSync("node", ["scripts/omakei-categorize.mjs", ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state") },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function readLedger(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function categories(path) {
  return Object.fromEntries(readLedger(path).transactions.map((t) => [t.id, t.categoryId]));
}

test("adding a rule re-tags matching rows and leaves the defaults alone", () => {
  const { home, ledgerPath, revisionPath } = attachedLedger(TX);
  const { status, stdout } = cli(["zorp widgets", "shopping"], home);
  assert.equal(status, 0);
  assert.match(stdout, /2 transactions re-tagged/);

  assert.deepEqual(categories(ledgerPath), {
    a: "dining", // default, untouched
    b: "shopping", // the new rule
    c: "shopping",
    d: "subscriptions", // default, untouched
  });
  const written = readLedger(ledgerPath);
  assert.deepEqual(
    written.rules.map((r) => [r.pattern, r.categoryId, r.source]),
    [["zorp widgets", "shopping", "user"]],
  );
  assert.ok(readFileSync(revisionPath, "utf8").trim().length > 0, "revision bumped");
});

test("running the same command again changes nothing", () => {
  const { home, ledgerPath } = attachedLedger(TX);
  cli(["zorp widgets", "shopping"], home);
  const first = readLedger(ledgerPath);
  const { status, stdout } = cli(["zorp widgets", "shopping"], home);
  assert.equal(status, 0);
  assert.match(stdout, /0 transactions re-tagged/);
  const second = readLedger(ledgerPath);
  assert.deepEqual(second.transactions, first.transactions);
  assert.deepEqual(second.rules, first.rules);
});

test("--remove drops the rule and reverts its rows", () => {
  const { home, ledgerPath } = attachedLedger(TX);
  cli(["zorp widgets", "shopping"], home);
  const { status } = cli(["--remove", "zorp widgets"], home);
  assert.equal(status, 0);
  assert.deepEqual(categories(ledgerPath), {
    a: "dining",
    b: null,
    c: null,
    d: "subscriptions",
  });
  assert.deepEqual(readLedger(ledgerPath).rules, []);
});

test("--remove on an unknown pattern fails and writes nothing", () => {
  const { home, ledgerPath } = attachedLedger(TX);
  const before = readFileSync(ledgerPath, "utf8");
  const { status, stderr } = cli(["--remove", "never-added"], home);
  assert.equal(status, 1);
  assert.match(stderr, /No user rule matches/);
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
});

test("--dry-run reports the change but leaves the file byte-identical", () => {
  const { home, ledgerPath } = attachedLedger(TX);
  const before = readFileSync(ledgerPath, "utf8");
  const { status, stdout } = cli(["--dry-run", "zorp widgets", "shopping"], home);
  assert.equal(status, 0);
  assert.match(stdout, /2 transactions re-tagged/);
  assert.match(stdout, /nothing written/);
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
});

test("--list prints uncategorized merchants, biggest first", () => {
  const { home } = attachedLedger(TX);
  const { status, stdout } = cli(["--list"], home);
  assert.equal(status, 0);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, "STARBUCKS and NETFLIX resolve to defaults; only ZORP is left");
  assert.match(lines[0], /ZORP/);
  assert.match(lines[0], /2/);
  assert.match(lines[0], /-\$42\.50/);
});

test("an unknown category id fails and writes nothing", () => {
  const { home, ledgerPath } = attachedLedger(TX);
  const before = readFileSync(ledgerPath, "utf8");
  const { status, stderr } = cli(["zorp widgets", "nonsense"], home);
  assert.equal(status, 1);
  assert.match(stderr, /Unknown category/);
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
});

test("no attached folder fails cleanly", () => {
  const root = mkdtempSync(join(tmpdir(), "omakei-cat-"));
  temps.push(root);
  const { status, stderr } = cli(["zorp widgets", "shopping"], join(root, "home"));
  assert.equal(status, 1);
  assert.match(stderr, /No ledger found/);
});
