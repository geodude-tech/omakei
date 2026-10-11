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
  assert.match(text, /^Other: about \$15\.49 a month across 1\.$/m);
  assert.match(text, /^1 active, 0 stopped, 1 marked not recurring \(as of 2026-09-21\)\.$/m);
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

test("a charge the user tagged as a subscription is listed and labelled tagged", async () => {
  const dir = privateDir();
  const transactions = [
    charge("z1", "2026-08-21", "ZORPWEAR RENTAL", -88.2, "subscriptions"),
    charge("z2", "2026-09-19", "ZORPWEAR RENTAL", -88.2, "subscriptions"),
  ];
  await updateLedgerDb(dir, () => ({ version: 1, transactions, rules: [] }));
  assert.match(
    cli([dir]),
    /^ZORPWEAR\s+monthly\s+\$88\.20\s+\$88\.20\/mo {2}last 2026-09-19 {2}next 2026-10-19 {2}\[tagged, new\]$/m,
  );
});

test("tagged charges with no schedule yet are listed apart and left out of the monthly total", async () => {
  const dir = privateDir();
  const transactions = [
    ...ledger().transactions,
    charge("a1", "2026-08-14", "Zorpaudio zorpaudio.co/pay CA", -18.4, "subscriptions"),
    charge("a2", "2026-09-02", "Zorpaudio zorpaudio.co/pay CA", -7.8, "subscriptions"),
  ];
  await updateLedgerDb(dir, () => ({ version: 1, transactions, rules: [] }));
  const text = cli([dir]);
  assert.match(
    text,
    /^No schedule yet \(not in the monthly total\):\nZorpaudio\s+\$13\.10 {2}2 charges {2}last 2026-09-02 {2}\[tagged, new\]$/m,
  );
  assert.match(text, /^Subscriptions \(wants\): about \$0\.00 a month across 0\.$/m);
  assert.match(text, /^Other: about \$40\.48 a month across 2\.$/m);
  assert.match(
    text,
    /^2 active, 0 stopped, 1 with no schedule yet, 0 marked not recurring \(as of 2026-09-21\)\.$/m,
  );
});

/** Invented: one plan, a car loan, a phone bill, and a gym nobody categorized. */
function mixedLedger() {
  const transactions = [];
  for (let m = 1; m <= 9; m++) {
    const date = `2026-0${m}-05`;
    transactions.push(charge(`f${m}`, date, "ZORPFLIX", -12.5, "subscriptions"));
    transactions.push(charge(`l${m}`, date, "ZORPLOAN", -310, "debt"));
    transactions.push(charge(`t${m}`, date, "ZORPTEL", -45, "utilities"));
    transactions.push(charge(`g${m}`, date, "ZORPGYM", -30));
  }
  return { version: 1, transactions, rules: [] };
}

test("all recurring is totalled, then wants, needs, and other each in a section with its subtotal", async () => {
  const dir = privateDir();
  await updateLedgerDb(dir, () => mixedLedger());
  assert.equal(
    cli([dir]),
    [
      "Recurring: about $397.50 a month across 4.",
      "",
      "Subscriptions (wants)",
      "ZORPFLIX  monthly     $12.50     $12.50/mo  last 2026-09-05  next 2026-10-05",
      "Subscriptions (wants): about $12.50 a month across 1.",
      "",
      "Bills (needs)",
      "ZORPLOAN  monthly    $310.00    $310.00/mo  last 2026-09-05  next 2026-10-05",
      "ZORPTEL   monthly     $45.00     $45.00/mo  last 2026-09-05  next 2026-10-05",
      "Bills (needs): about $355.00 a month across 2.",
      "",
      "Other",
      "ZORPGYM   monthly     $30.00     $30.00/mo  last 2026-09-05  next 2026-10-05",
      "Other: about $30.00 a month across 1.",
      "",
      "4 active, 0 stopped, 0 marked not recurring (as of 2026-09-05).",
      "",
    ].join("\n"),
  );
});

test("the JSON carries each row's kind and a monthly total per kind", async () => {
  const dir = privateDir();
  await updateLedgerDb(dir, () => mixedLedger());
  const out = JSON.parse(cli(["--json", dir]));
  assert.deepEqual(
    out.subscriptions.map((s) => [s.key, s.kind]),
    [
      ["zorploan", "bill"],
      ["zorptel", "bill"],
      ["zorpgym", "other"],
      ["zorpflix", "subscription"],
    ],
  );
  assert.deepEqual(out.totals, { subscription: 12.5, bill: 355, other: 30 });
  assert.equal(out.total, 397.5);
});

test("a mortgage whose feed ended early is a bill labelled with the account's last data date", async () => {
  const dir = privateDir();
  const transactions = [charge("c1", "2026-09-28", "ZORPCAFE", -4, "coffee")];
  const lines = ["ZORPLEND PMT", "BY POST", "ZORPLEND", "ZORPLEND"];
  for (let m = 3; m <= 6; m++) {
    transactions.push({
      ...charge(`h${m}`, `2026-0${m}-17`, lines[m - 3], -1843.27, "housing"),
      accountName: "Zorp Home Loan",
      accountKind: "mortgage",
    });
  }
  await updateLedgerDb(dir, () => ({ version: 1, transactions, rules: [] }));
  assert.match(
    cli([dir]),
    /^Bills \(needs\)\nZorp Home Loan {2}monthly {3}\$1843\.27 {3}\$1843\.27\/mo {2}last 2026-06-17 {2}next 2026-07-17 {2}\[loan account, no data for this account since 2026-06-17\]\nBills \(needs\): about \$1843\.27 a month across 1\.$/m,
  );
});
