/**
 * The SQLite ledger: that it stores exactly what the app hands it, that a write
 * derived from an old version cannot land even from another process, that the
 * JSON ledger is imported without being touched, and that the database is
 * opened under the same symlink / FIFO / size rules as every other file.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  DB_FILENAME,
  LedgerShapeError,
  importJsonLedger,
  jsonChangedSinceImport,
  readLedgerDb,
  updateLedgerDb,
} from "./ledger-db.mjs";
import { LEDGER_FILENAME, MAX_LEDGER_BYTES, ledgerEtag } from "./ledger-api.mjs";
import { CATEGORIES } from "../src/lib/finance/categories.ts";
import { isIncome, isSpend } from "../src/lib/finance/ledger.ts";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "omakei-db-"));
  temps.push(dir);
  return dir;
}

function tx(id, date, description, amount, categoryId) {
  return {
    id,
    date,
    description,
    amount,
    accountName: "Everyday Checking",
    accountKind: "checking",
    sourceFile: "checking.csv",
    fingerprint: `${date}|${description}|${amount}`,
    categoryId,
    importedAt: 1724800000000,
  };
}

/** Invented and neutral: national chains, round-ish numbers. */
const LEDGER = {
  version: 1,
  savedAt: "2026-08-31T12:00:00.000Z",
  selectedMonth: "2026-08",
  transactions: [
    tx("t1", "2026-08-02", "SAFEWAY #1234", -54.12, "groceries"),
    tx("t2", "2026-08-03", "STARBUCKS STORE 99", -5.75, "coffee"),
    tx("t3", "2026-08-05", "PAYROLL DEPOSIT", 2400, "income"),
    tx("t4", "2026-08-06", "ONLINE PAYMENT THANK YOU", -600, "transfers"),
    tx("t5", "2026-08-07", "SQ *FARMERS MARKET", -18.5, null),
    { ...tx("t6", "2026-08-09", "CHECK 1042", -120, "childcare"), pinnedCategoryId: "childcare" },
  ],
  rules: [{ id: "r1", pattern: "starbucks", categoryId: "coffee", createdAt: 1724800000000, source: "user" }],
  setAsides: [{ id: "s1", name: "Taxes", amount: 500 }],
};

const write = (dir, ledger, create = true) => updateLedgerDb(dir, () => ledger, { create });

test("an empty folder has no ledger and an empty etag, and reading creates nothing", async () => {
  const dir = folder();
  assert.deepEqual(await readLedgerDb(dir, { importJson: true }), { ledger: null, etag: "" });
  assert.deepEqual(readdirSync(dir), []);
});

test("a snapshot reads back exactly as it was written", async () => {
  const dir = folder();
  const saved = await write(dir, LEDGER);
  assert.equal(saved.written, true);
  assert.deepEqual(saved.ledger, LEDGER);

  const read = await readLedgerDb(dir);
  assert.deepEqual(read.ledger, LEDGER);
  assert.equal(read.etag, saved.etag);
  assert.ok(existsSync(join(dir, DB_FILENAME)));
  assert.equal(existsSync(join(dir, LEDGER_FILENAME)), false, "the JSON is never written");
});

test("fields a snapshot leaves out read back as null, and optional lists as empty", async () => {
  const dir = folder();
  await write(dir, { version: 1, transactions: [{ id: "a", date: "2026-08-02", amount: -4.5 }], rules: [] });
  const { ledger } = await readLedgerDb(dir);
  assert.equal(ledger.transactions[0].amount, -4.5);
  assert.equal(ledger.transactions[0].categoryId, null);
  assert.deepEqual(ledger.setAsides, []);
});

test("every write moves the etag, and a decision sees the etag it is deciding against", async () => {
  const dir = folder();
  const first = await write(dir, LEDGER);
  const second = await write(dir, { ...LEDGER, selectedMonth: "2026-09" });
  assert.notEqual(first.etag, "");
  assert.notEqual(second.etag, first.etag);

  const stale = await updateLedgerDb(dir, ({ etag }) => (etag === first.etag ? LEDGER : null));
  assert.equal(stale.written, false);
  assert.equal(stale.etag, second.etag);
  assert.equal(stale.ledger.selectedMonth, "2026-09");
});

test("two ledgers never share an etag, even at the same revision", async () => {
  const a = await write(folder(), LEDGER);
  const b = await write(folder(), LEDGER);
  assert.notEqual(a.etag, b.etag);
});

test("a snapshot that cannot be stored is refused and changes nothing", async () => {
  const dir = folder();
  const saved = await write(dir, LEDGER);
  const dup = { ...LEDGER, transactions: [LEDGER.transactions[0], LEDGER.transactions[0]] };
  await assert.rejects(write(dir, dup), LedgerShapeError);
  await assert.rejects(write(dir, { ...LEDGER, transactions: [{ date: "2026-08-01" }] }), LedgerShapeError);
  await assert.rejects(write(dir, { version: 2, transactions: [], rules: [] }), LedgerShapeError);
  const read = await readLedgerDb(dir);
  assert.deepEqual(read.ledger, LEDGER);
  assert.equal(read.etag, saved.etag);
});

test("two processes writing against the same etag: exactly one lands", async () => {
  const dir = folder();
  const { etag } = await write(dir, LEDGER);
  const moduleUrl = new URL("./ledger-db.mjs", import.meta.url).href;
  const child = (month) =>
    new Promise((resolve, reject) => {
      const script = `
        import { updateLedgerDb } from ${JSON.stringify(moduleUrl)};
        const ledger = ${JSON.stringify(LEDGER)};
        const r = await updateLedgerDb(${JSON.stringify(dir)}, ({ etag }) =>
          etag === ${JSON.stringify(etag)} ? { ...ledger, selectedMonth: ${JSON.stringify(month)} } : null);
        process.stdout.write(String(r.written));`;
      const p = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`))));
    });
  const results = await Promise.all([child("2026-09"), child("2026-10")]);
  assert.deepEqual(results.sort(), ["false", "true"]);
});

/* ------------------------------------------------------------------ import */

test("a JSON ledger is imported without being touched", async () => {
  const dir = folder();
  const jsonPath = join(dir, LEDGER_FILENAME);
  const text = `${JSON.stringify(LEDGER)}\n`;
  writeFileSync(jsonPath, text);
  const mtime = statSync(jsonPath).mtimeMs;

  const read = await readLedgerDb(dir, { importJson: true });
  assert.deepEqual(read.ledger, LEDGER);
  assert.notEqual(read.etag, "");

  assert.equal(readFileSync(jsonPath, "utf8"), text);
  assert.equal(statSync(jsonPath).mtimeMs, mtime);
  assert.deepEqual(readdirSync(dir).sort(), [DB_FILENAME, LEDGER_FILENAME].sort(), "no temp file left");

  const db = new DatabaseSync(join(dir, DB_FILENAME), { readOnly: true });
  const imported = db.prepare("SELECT value FROM meta WHERE key = 'importedFromEtag'").get().value;
  db.close();
  assert.equal(imported, ledgerEtag(Buffer.from(text)));
});

test("the widget's read does not import", async () => {
  const dir = folder();
  writeFileSync(join(dir, LEDGER_FILENAME), JSON.stringify(LEDGER));
  assert.deepEqual(await readLedgerDb(dir), { ledger: null, etag: "" });
  assert.equal(existsSync(join(dir, DB_FILENAME)), false);
});

test("an existing database is never replaced by an import, and a changed JSON is noticed", async () => {
  const dir = folder();
  writeFileSync(join(dir, LEDGER_FILENAME), JSON.stringify(LEDGER));
  await readLedgerDb(dir, { importJson: true });
  assert.equal(await jsonChangedSinceImport(dir), false);

  const edited = { ...LEDGER, selectedMonth: "2026-12" };
  writeFileSync(join(dir, LEDGER_FILENAME), JSON.stringify(edited));
  assert.equal(await importJsonLedger(dir), false);
  assert.equal((await readLedgerDb(dir, { importJson: true })).ledger.selectedMonth, "2026-08");
  assert.equal(await jsonChangedSinceImport(dir), true);
});

test("a JSON ledger that cannot be imported leaves no database and no temp file", async () => {
  const dir = folder();
  const dup = { ...LEDGER, transactions: [LEDGER.transactions[0], LEDGER.transactions[0]] };
  writeFileSync(join(dir, LEDGER_FILENAME), JSON.stringify(dup));
  await assert.rejects(importJsonLedger(dir), LedgerShapeError);
  assert.deepEqual(readdirSync(dir), [LEDGER_FILENAME]);

  writeFileSync(join(dir, LEDGER_FILENAME), "not json");
  assert.equal(await importJsonLedger(dir), false);
  assert.deepEqual(readdirSync(dir), [LEDGER_FILENAME]);
});

/* ------------------------------------------------------------------- guards */

test("a symlink in place of the database is refused, for reading and writing", async () => {
  const dir = folder();
  const elsewhere = folder();
  await write(elsewhere, LEDGER);
  symlinkSync(join(elsewhere, DB_FILENAME), join(dir, DB_FILENAME));
  assert.equal(await readLedgerDb(dir), null);
  assert.equal(await write(dir, LEDGER), null);
});

test("a symlinked journal beside the database is refused", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  // Dangling on purpose: SQLite creates its journal by name mid-write, so a
  // link to a file that does not exist yet is where the write would escape to.
  const outside = join(folder(), "escaped-journal");
  symlinkSync(outside, join(dir, `${DB_FILENAME}-journal`));
  assert.equal(await readLedgerDb(dir), null);
  assert.equal(await write(dir, { ...LEDGER, selectedMonth: "2026-09" }), null);
  assert.equal(existsSync(outside), false, "nothing was written through the link");
});

test("a FIFO in place of the database is refused without blocking", async () => {
  const dir = folder();
  execFileSync("mkfifo", [join(dir, DB_FILENAME)]);
  assert.equal(await readLedgerDb(dir), null);
  assert.equal(await write(dir, LEDGER), null);
});

test("a database over the ledger cap is refused", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  truncateSync(join(dir, DB_FILENAME), MAX_LEDGER_BYTES + 1);
  assert.equal(await readLedgerDb(dir), null);
});

test("a SQLite file that is not an Omakei ledger is not read", async () => {
  const dir = folder();
  const db = new DatabaseSync(join(dir, DB_FILENAME));
  db.exec("CREATE TABLE something (x); INSERT INTO something VALUES (1)");
  db.close();
  assert.equal(await readLedgerDb(dir), null);
  assert.equal(await write(dir, LEDGER), null, "and a write does not adopt it");
  const after = new DatabaseSync(join(dir, DB_FILENAME), { readOnly: true });
  const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  after.close();
  assert.deepEqual(tables, ["something"]);
});

/* --------------------------------------------------------------- pins */

test("a pin round-trips, and a row without one reads back with no pin key at all", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  const { ledger } = await readLedgerDb(dir);
  const pinned = ledger.transactions.find((t) => t.id === "t6");
  assert.equal(pinned.pinnedCategoryId, "childcare");
  const plain = ledger.transactions.find((t) => t.id === "t1");
  assert.equal("pinnedCategoryId" in plain, false, "absent, not null");
});

test("pins in a JSON ledger survive the import", async () => {
  const dir = folder();
  writeFileSync(join(dir, LEDGER_FILENAME), JSON.stringify(LEDGER));
  const { ledger } = await readLedgerDb(dir, { importJson: true });
  assert.deepEqual(ledger, LEDGER);
});

test("a field the ledger has no column for is refused rather than dropped", async () => {
  const dir = folder();
  const saved = await write(dir, LEDGER);
  const withNew = { ...LEDGER, transactions: [{ ...LEDGER.transactions[0], someNewField: "x" }] };
  await assert.rejects(write(dir, withNew), /someNewField/);
  await assert.rejects(write(dir, { ...LEDGER, somethingElse: 1 }), /somethingElse/);
  await assert.rejects(
    write(dir, { ...LEDGER, setAsides: [{ id: "s", name: "Taxes", amount: 1, note: "x" }] }),
    /note/,
  );
  assert.equal((await readLedgerDb(dir)).etag, saved.etag);

  const jsonDir = folder();
  writeFileSync(join(jsonDir, LEDGER_FILENAME), JSON.stringify(withNew));
  await assert.rejects(importJsonLedger(jsonDir), LedgerShapeError);
  assert.equal(existsSync(join(jsonDir, DB_FILENAME)), false, "a lossy import is not published");
});

test("a rule on a bare check cannot be stored, however it is written", async () => {
  const dir = folder();
  const saved = await write(dir, LEDGER);
  for (const pattern of ["check", " CHECK ", "Chk"]) {
    const rules = [{ id: "rc", pattern, categoryId: "childcare", createdAt: 1, source: "user" }];
    await assert.rejects(write(dir, { ...LEDGER, rules }), LedgerShapeError, pattern);
  }
  assert.equal((await readLedgerDb(dir)).etag, saved.etag);

  // An agent going around the app, straight into the table.
  const db = new DatabaseSync(join(dir, DB_FILENAME));
  assert.throws(
    () => db.prepare("INSERT INTO rules (pattern, categoryId, source) VALUES ('check', 'childcare', 'user')").run(),
    /no_rule_on_a_bare_check/,
  );
  // A real merchant that merely contains the word is fine.
  db.prepare("INSERT INTO rules (pattern, categoryId, source) VALUES ('checkers', 'dining', 'user')").run();
  db.close();
});

/* --------------------------------------------------- what an agent queries */

function query(dir, sql) {
  const db = new DatabaseSync(join(dir, DB_FILENAME), { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test("the spend and income views are the dashboard's rules, row for row", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  const ids = (sql) => query(dir, sql).map((r) => r.id);
  assert.deepEqual(ids("SELECT id FROM spend ORDER BY seq"), LEDGER.transactions.filter(isSpend).map((t) => t.id));
  assert.deepEqual(ids("SELECT id FROM income ORDER BY seq"), LEDGER.transactions.filter(isIncome).map((t) => t.id));
  assert.deepEqual(
    ids("SELECT id FROM uncategorized ORDER BY seq"),
    LEDGER.transactions.filter((t) => t.categoryId === null).map((t) => t.id),
  );
  assert.ok(ids("SELECT id FROM spend").includes("t5"), "uncategorized money is still spend");
  assert.ok(!ids("SELECT id FROM spend").includes("t4"), "a transfer is not");
});

test("a month's figures come out of the views the way the dashboard computes them", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  const month = LEDGER.transactions.filter((t) => t.date.startsWith("2026-08"));
  const round = (n) => Math.round(n * 100) / 100;
  const [row] = query(
    dir,
    `SELECT
       (SELECT -sum(amount) FROM spend  WHERE date LIKE '2026-08%') AS spend,
       (SELECT  sum(amount) FROM income WHERE date LIKE '2026-08%') AS income`,
  );
  assert.equal(round(row.spend), round(-month.filter(isSpend).reduce((a, t) => a + t.amount, 0)));
  assert.equal(round(row.income), round(month.filter(isIncome).reduce((a, t) => a + t.amount, 0)));
});

test("category names are in the file, matching the build", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  assert.deepEqual(query(dir, 'SELECT id, name, "group" FROM categories ORDER BY rowid'), CATEGORIES);
  const [named] = query(
    dir,
    "SELECT c.name FROM transactions t JOIN categories c ON c.id = t.categoryId WHERE t.id = 't2'",
  );
  assert.equal(named.name, "Coffee");
});

/* -------------------------------------------------- docs/ledger.md holds */

const LEDGER_DOC = readFileSync(new URL("../docs/ledger.md", import.meta.url), "utf8");

test("every table and view docs/ledger.md lists is in the database, and nothing it does not", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  const section = LEDGER_DOC.slice(LEDGER_DOC.indexOf("| table or view |"));
  const documented = [...section.slice(0, section.indexOf("\n\n")).matchAll(/^\| `([A-Za-z]+)` \|/gm)]
    .map((m) => m[1])
    .sort();
  const actual = query(dir, "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
    .map((r) => r.name)
    .sort();
  assert.deepEqual(documented, actual);
});

test("every SQL example in docs/ledger.md runs against a real ledger, and the worked net is right", async () => {
  const dir = folder();
  await write(dir, LEDGER);
  const blocks = [...LEDGER_DOC.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 3, "the doc's SQL examples were found");
  for (const sql of blocks) {
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      assert.doesNotThrow(() => query(dir, statement), statement);
    }
  }
  const [row] = query(dir, blocks.find((b) => b.includes("AS net")).replace(/;\s*$/, ""));
  const spend = -LEDGER.transactions.filter(isSpend).reduce((a, t) => a + t.amount, 0);
  const income = LEDGER.transactions.filter(isIncome).reduce((a, t) => a + t.amount, 0);
  const setAsides = LEDGER.setAsides.reduce((a, s) => a + s.amount, 0);
  assert.equal(Math.round(row.net * 100), Math.round((income - spend - setAsides) * 100));
});

test("a new database, written or imported, is readable by its owner only", async () => {
  const written = folder();
  await write(written, LEDGER);
  assert.equal(statSync(join(written, DB_FILENAME)).mode & 0o777, 0o600);

  const imported = folder();
  writeFileSync(join(imported, LEDGER_FILENAME), JSON.stringify(LEDGER));
  await readLedgerDb(imported, { importJson: true });
  assert.equal(statSync(join(imported, DB_FILENAME)).mode & 0o777, 0o600);
});
