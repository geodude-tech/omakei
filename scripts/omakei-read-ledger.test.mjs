/**
 * The widget's read path. These are the checks QML could not make for itself,
 * which is the whole reason the read moved out of Panel.qml.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readLedgerForWidget } from "./omakei-read-ledger.mjs";
import { renderStateFile } from "./ledger-api.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A home with a state file already pointing at a statements folder. */
function attachedHome() {
  const root = mkdtempSync(join(tmpdir(), "omakei-widget-"));
  temps.push(root);
  const home = join(root, "home");
  const statements = join(home, "Statements");
  mkdirSync(statements, { recursive: true });
  const stateDir = join(home, ".local", "state", "omakei");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), renderStateFile(statements));
  return { root, home, statements };
}

/** Isolate both, or the real XDG_STATE_HOME on this machine wins. */
function envFor(home) {
  return { env: {}, home };
}

const LEDGER = { version: 1, transactions: [{ id: "a", date: "2026-08-02", amount: -4.5 }], rules: [] };

test("the ledger the state file points at is returned", async () => {
  const { home, statements } = attachedHome();
  writeFileSync(join(statements, "omakei-ledger.json"), JSON.stringify(LEDGER));
  const ledger = await readLedgerForWidget("", envFor(home));
  assert.equal(ledger.transactions.length, 1);
});

test("nothing attached reads as null rather than an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "omakei-widget-"));
  temps.push(root);
  assert.equal(await readLedgerForWidget("", envFor(root)), null);
});

test("a symlinked ledger is refused", async () => {
  const { root, home, statements } = attachedHome();
  const outside = join(root, "elsewhere.json");
  writeFileSync(outside, JSON.stringify(LEDGER));
  symlinkSync(outside, join(statements, "omakei-ledger.json"));
  assert.equal(await readLedgerForWidget("", envFor(home)), null);
});

test("a symlinked state file is refused", async () => {
  const { root, home, statements } = attachedHome();
  writeFileSync(join(statements, "omakei-ledger.json"), JSON.stringify(LEDGER));
  const decoy = join(root, "decoy-state.json");
  writeFileSync(decoy, renderStateFile(statements));
  const statePath = join(home, ".local", "state", "omakei", "state.json");
  rmSync(statePath);
  symlinkSync(decoy, statePath);
  assert.equal(await readLedgerForWidget("", envFor(home)), null);
});

test("a ledger over the cap never reaches the widget", async () => {
  const { home, statements } = attachedHome();
  // Valid JSON above the cap: a sparse file would fail to parse and would
  // prove nothing about the size limit.
  writeFileSync(
    join(statements, "omakei-ledger.json"),
    JSON.stringify({
      version: 1,
      rules: [],
      transactions: [{ id: "a", note: "x".repeat(21 * 1024 * 1024) }],
    }),
  );
  assert.equal(await readLedgerForWidget("", envFor(home)), null);
});

test("a FIFO in the ledger's place does not hang the read", async () => {
  const { home, statements } = attachedHome();
  const fifo = join(statements, "omakei-ledger.json");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return; // no mkfifo here; nothing to assert
  }
  const ledger = await Promise.race([
    readLedgerForWidget("", envFor(home)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("read blocked")), 4000)),
  ]);
  assert.equal(ledger, null);
});

test("a ledger that is not a ledger is refused", async () => {
  const { home, statements } = attachedHome();
  writeFileSync(join(statements, "omakei-ledger.json"), JSON.stringify({ version: 9, nope: true }));
  assert.equal(await readLedgerForWidget("", envFor(home)), null);
  writeFileSync(join(statements, "omakei-ledger.json"), "not json at all");
  assert.equal(await readLedgerForWidget("", envFor(home)), null);
});

test("the override wins over the state file, and ~ expands", async () => {
  const { home, statements } = attachedHome();
  writeFileSync(join(statements, "omakei-ledger.json"), JSON.stringify(LEDGER));
  const other = { version: 1, rules: [], transactions: [{ id: "b" }, { id: "c" }] };
  writeFileSync(join(home, "other.json"), JSON.stringify(other));
  const byAbsolute = await readLedgerForWidget(join(home, "other.json"), envFor(home));
  assert.equal(byAbsolute.transactions.length, 2);
  const byTilde = await readLedgerForWidget("~/other.json", envFor(home));
  assert.equal(byTilde.transactions.length, 2);
});

test("the CLI prints JSON and exits cleanly with nothing attached", () => {
  const root = mkdtempSync(join(tmpdir(), "omakei-widget-"));
  temps.push(root);
  const out = execFileSync("node", ["scripts/omakei-read-ledger.mjs"], {
    encoding: "utf8",
    env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") },
  });
  assert.equal(out, "null", "the widget must always receive parseable JSON");
});
