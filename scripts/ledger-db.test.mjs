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

  const stale = await updateLedgerDb(dir, (current, etag) => (etag === first.etag ? LEDGER : null));
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
        const r = await updateLedgerDb(${JSON.stringify(dir)}, (cur, etag) =>
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
});
