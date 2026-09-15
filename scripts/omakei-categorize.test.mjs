/**
 * The terminal path for bulk categorize edits. Each test drives the real CLI
 * against a throwaway home whose state file points at a throwaway ledger.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { renderStateFile } from "./ledger-api.mjs";
import { readLedgerDb, updateLedgerDb } from "./ledger-db.mjs";

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
async function attachedLedger(snapshot) {
  const found = attachedFolder();
  await updateLedgerDb(found.statements, () => ({
    version: 1,
    selectedMonth: "2026-08",
    transactions: snapshot,
    rules: [],
  }));
  return found;
}

/** The same home with nothing in the folder yet. */
function attachedFolder() {
  const root = mkdtempSync(join(tmpdir(), "omakei-cat-"));
  temps.push(root);
  const home = join(root, "home");
  const statements = join(home, "Statements");
  mkdirSync(statements, { recursive: true });
  const stateDir = join(home, ".local", "state", "omakei");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), renderStateFile(statements));
  return { home, statements, revisionPath: join(stateDir, "ledger-revision") };
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

async function readLedger(dir) {
  return (await readLedgerDb(dir)).ledger;
}
async function categories(dir) {
  return Object.fromEntries((await readLedger(dir)).transactions.map((t) => [t.id, t.categoryId]));
}
/** Proof a command wrote nothing: the same version, holding the same ledger. */
async function unchanged(dir, before) {
  const now = await readLedgerDb(dir);
  assert.equal(now.etag, before.etag, "the version did not move");
  assert.deepEqual(now.ledger, before.ledger);
}

test("adding a rule re-tags matching rows and leaves the defaults alone", async () => {
  const { home, statements, revisionPath } = await attachedLedger(TX);
  const { status, stdout } = cli(["zorp widgets", "shopping"], home);
  assert.equal(status, 0);
  assert.match(stdout, /2 transactions re-tagged/);

  assert.deepEqual(await categories(statements), {
    a: "coffee", // default, untouched
    b: "shopping", // the new rule
    c: "shopping",
    d: "subscriptions", // default, untouched
  });
  const written = await readLedger(statements);
  assert.deepEqual(
    written.rules.map((r) => [r.pattern, r.categoryId, r.source]),
    [["zorp widgets", "shopping", "user"]],
  );
  assert.ok(readFileSync(revisionPath, "utf8").trim().length > 0, "revision bumped");
});

test("running the same command again changes nothing", async () => {
  const { home, statements } = await attachedLedger(TX);
  cli(["zorp widgets", "shopping"], home);
  const first = await readLedger(statements);
  const { status, stdout } = cli(["zorp widgets", "shopping"], home);
  assert.equal(status, 0);
  assert.match(stdout, /0 transactions re-tagged/);
  const second = await readLedger(statements);
  assert.deepEqual(second.transactions, first.transactions);
  assert.deepEqual(second.rules, first.rules);
});

test("--remove drops the rule and reverts its rows", async () => {
  const { home, statements } = await attachedLedger(TX);
  cli(["zorp widgets", "shopping"], home);
  const { status } = cli(["--remove", "zorp widgets"], home);
  assert.equal(status, 0);
  assert.deepEqual(await categories(statements), {
    a: "coffee",
    b: null,
    c: null,
    d: "subscriptions",
  });
  assert.deepEqual((await readLedger(statements)).rules, []);
});

test("--remove on an unknown pattern fails and writes nothing", async () => {
  const { home, statements } = await attachedLedger(TX);
  const before = await readLedgerDb(statements);
  const { status, stderr } = cli(["--remove", "never-added"], home);
  assert.equal(status, 1);
  assert.match(stderr, /No user rule matches/);
  await unchanged(statements, before);
});

test("--dry-run reports the change but leaves the ledger at the same version", async () => {
  const { home, statements } = await attachedLedger(TX);
  const before = await readLedgerDb(statements);
  const { status, stdout } = cli(["--dry-run", "zorp widgets", "shopping"], home);
  assert.equal(status, 0);
  assert.match(stdout, /2 transactions re-tagged/);
  assert.match(stdout, /nothing written/);
  await unchanged(statements, before);
});

test("--list prints uncategorized merchants, biggest first", async () => {
  const { home } = await attachedLedger(TX);
  const { status, stdout } = cli(["--list"], home);
  assert.equal(status, 0);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, "STARBUCKS and NETFLIX resolve to defaults; only ZORP is left");
  assert.match(lines[0], /ZORP/);
  assert.match(lines[0], /2/);
  assert.match(lines[0], /-\$42\.50/);
});

test("--list --json prints the same merchants a caller can act on", async () => {
  const { home } = await attachedLedger(TX);
  const { status, stdout } = cli(["--list", "--json"], home);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), [{ merchant: "ZORP WIDGETS", count: 2, total: -42.5 }]);
});

test("--list --json says nothing with an empty array, not a sentence", async () => {
  const { home } = await attachedLedger([TX[0]]);
  const { status, stdout } = cli(["--list", "--json"], home);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), []);
});

test("--json without --list is refused rather than ignored", async () => {
  const { home, statements } = await attachedLedger(TX);
  const before = await readLedgerDb(statements);
  const { status, stderr } = cli(["--json", "zorp widgets", "shopping"], home);
  assert.equal(status, 1);
  assert.match(stderr, /--json only applies to --list/);
  await unchanged(statements, before);
});

test("an unknown category id fails and writes nothing", async () => {
  const { home, statements } = await attachedLedger(TX);
  const before = await readLedgerDb(statements);
  const { status, stderr } = cli(["zorp widgets", "nonsense"], home);
  assert.equal(status, 1);
  assert.match(stderr, /Unknown category/);
  await unchanged(statements, before);
});

test("no attached folder fails cleanly", () => {
  const root = mkdtempSync(join(tmpdir(), "omakei-cat-"));
  temps.push(root);
  const { status, stderr } = cli(["zorp widgets", "shopping"], join(root, "home"));
  assert.equal(status, 1);
  assert.match(stderr, /No ledger found/);
});

test("an attached folder with no ledger at all fails cleanly and creates nothing", () => {
  const { home, statements } = attachedFolder();
  const { status, stderr } = cli(["zorp widgets", "shopping"], home);
  assert.equal(status, 1);
  assert.match(stderr, /Could not read/);
  assert.equal(existsSync(join(statements, "omakei-ledger.sqlite")), false);
});

test("a folder with only the JSON ledger is imported, and the JSON is not written", async () => {
  const { home, statements } = attachedFolder();
  const jsonPath = join(statements, "omakei-ledger.json");
  const text = JSON.stringify({ version: 1, selectedMonth: "2026-08", transactions: TX, rules: [] });
  writeFileSync(jsonPath, text);
  const mtime = statSync(jsonPath).mtimeMs;

  const { status, stdout, stderr } = cli(["zorp widgets", "shopping"], home);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /2 transactions re-tagged/);
  assert.equal((await categories(statements)).b, "shopping");
  assert.equal(readFileSync(jsonPath, "utf8"), text);
  assert.equal(statSync(jsonPath).mtimeMs, mtime);
});

test("a save the editor derived before the rule was written cannot undo it", async () => {
  const { home, statements } = await attachedLedger(TX);
  // What the editor holds: the ledger and version it read when the tab opened.
  const editor = await readLedgerDb(statements);

  assert.equal(cli(["zorp widgets", "shopping"], home).status, 0);

  const late = await updateLedgerDb(statements, ({ etag }) =>
    etag === editor.etag ? { ...editor.ledger, selectedMonth: "2026-09" } : null,
  );
  assert.equal(late.written, false, "the server refuses it; the editor merges and retries");
  assert.equal((await categories(statements)).b, "shopping", "the rule survives");
  assert.deepEqual(late.ledger.rules.map((r) => r.pattern), ["zorp widgets"]);
});

