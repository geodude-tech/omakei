/**
 * The terminal view of recurring charges: it reads the ledger read-only,
 * writes nothing, honours the marks stored in the ledger, and has no way to
 * reach the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { updateLedgerDb } from "./ledger-db.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function privateDir() {
  const dir = mkdtempSync(join(tmpdir(), "omakei-subs-"));
  temps.push(dir);
  return dir;
}

function charge(id, date, description, amount, categoryId = null) {
  return {
    id,
    date,
    description,
    amount,
    accountName: "Credit Card",
    accountKind: "credit",
    sourceFile: "card.csv",
    fingerprint: id,
    categoryId,
    importedAt: 0,
  };
}

/** Invented: a streaming plan, a gym, and an ordinary grocery habit. */
function ledger(marks) {
  const transactions = [];
  for (let m = 1; m <= 9; m++) {
    const mm = String(m).padStart(2, "0");
    transactions.push(
      charge(`n${m}`, `2026-${mm}-05`, `NETFLIX.COM 866-579-7172 CA ${mm}/05`, -15.49),
    );
    transactions.push(charge(`g${m}`, `2026-${mm}-12`, "PLANET FITNESS #0421", -24.99));
    transactions.push(
      charge(
        `s${m}`,
        `2026-${mm}-${String(3 + m * 2).padStart(2, "0")}`,
        "SAFEWAY #1234",
        -(60 + m * 7.3),
        "groceries",
      ),
    );
  }
  return { version: 1, transactions, rules: [], ...(marks ? { subscriptionMarks: marks } : {}) };
}

function cli(args) {
  return execFileSync(process.execPath, ["scripts/omakei-subscriptions.mjs", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: privateDir() },
  });
}

test("lists the recurring charges as JSON, and leaves the ledger byte for byte alone", async () => {
  const dir = privateDir();
  await updateLedgerDb(dir, () => ledger());
  const file = join(dir, "omakei-ledger.sqlite");
  const before = {
    bytes: readFileSync(file),
    mtime: statSync(file).mtimeMs,
    entries: readdirSync(dir),
  };

  const out = JSON.parse(cli(["--json", file]));
  assert.deepEqual(out.subscriptions.map((s) => s.key).sort(), ["netflix", "planet"]);
  assert.equal(out.subscriptions.find((s) => s.key === "netflix").cadence, "monthly");

  assert.deepEqual(readFileSync(file), before.bytes);
  assert.equal(statSync(file).mtimeMs, before.mtime);
  assert.deepEqual(readdirSync(dir), before.entries, "no journal or copy left beside it");
});

test("honours not-a-subscription marks stored in the ledger, and prints a readable table", async () => {
  const dir = privateDir();
  await updateLedgerDb(dir, () =>
    ledger([{ key: "planet", kind: "not-subscription", ref: "", createdAt: 1 }]),
  );
  const text = cli([dir]);
  assert.match(text, /NETFLIX\.COM\s+monthly\s+\$15\.49/);
  assert.doesNotMatch(text, /PLANET/);
  assert.match(text, /1 active, 0 stopped, 1 marked not a subscription; about \$15\.49 a month/);
});

test("a missing ledger is an error on stderr, not a crash", () => {
  assert.throws(() => cli([join(privateDir(), "nope")]), /No readable ledger/);
});

test("the detection and the CLI import nothing that can reach the network", () => {
  for (const file of ["src/lib/finance/subscriptions.ts", "scripts/omakei-subscriptions.mjs"]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /node:(https?|net|dns|tls|dgram|http2|child_process)|\bfetch\(|XMLHttpRequest|WebSocket/,
      file,
    );
  }
});

test("terminal escape sequences in a merchant name are not printed", async () => {
  const dir = privateDir();
  const transactions = [1, 2, 3, 4].map((m) =>
    charge(`e${m}`, `2026-0${m}-05`, "EVIL\u001b[2J\u001b]0;pwned\u0007 CLUB", -9),
  );
  await updateLedgerDb(dir, () => ({ version: 1, transactions, rules: [] }));
  const text = cli([dir]);
  assert.match(text, /EVIL\[2J\]0;pwned/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f]/);
});
