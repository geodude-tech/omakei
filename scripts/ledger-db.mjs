/**
 * The ledger, as a SQLite database in the attached folder.
 *
 * `omakei-ledger.json` used to be the ledger. It had two writers that could not
 * lock it -- the server and `omakei-categorize.mjs` -- so a write could only
 * narrow the window in which it overwrote the other, never close it. SQLite's
 * write lock closes it: every write here is one `BEGIN IMMEDIATE` transaction
 * that reads the revision, decides, writes, and bumps the revision before any
 * other process can start its own.
 *
 * The rest of the app still speaks the JSON snapshot shape (`version: 1`,
 * `transactions`, `rules`, `setAsides`, …). This module converts at the edge, so
 * the editor, the widget, and `Model.js` do not know the storage changed.
 *
 * Built-in `node:sqlite` only: installers never run `npm install`.
 */
import { DatabaseSync } from "node:sqlite";
import { closeSync, constants as FS, fchmodSync, fstatSync, openSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DB_FILENAME, MAX_LEDGER_BYTES, isLedgerPayload } from "./ledger-api.mjs";
import { CATEGORIES, TRANSFER_CATEGORY } from "../src/lib/finance/categories.ts";

export { DB_FILENAME };
export const SCHEMA_VERSION = 2;

/** How long a write waits on another process's lock before giving up. Writes take milliseconds. */
const BUSY_TIMEOUT_MS = 5000;

const TX_COLUMNS = [
  "id",
  "date",
  "description",
  "amount",
  "accountName",
  "accountKind",
  "sourceFile",
  "fingerprint",
  "categoryId",
  "importedAt",
  "pinnedCategoryId",
];
const RULE_COLUMNS = ["id", "pattern", "categoryId", "createdAt", "source"];
const SET_ASIDE_COLUMNS = ["id", "name", "amount"];

/**
 * Keys a row may leave out entirely. Absent on almost every transaction, so a
 * NULL here reads back as no key at all rather than `pinnedCategoryId: null`,
 * and a snapshot round-trips to exactly the shape it was written in.
 */
const OPTIONAL_KEYS = new Set(["pinnedCategoryId"]);

const SNAPSHOT_KEYS = new Set(["version", "savedAt", "selectedMonth", "transactions", "rules", "setAsides"]);

/**
 * Column names are the JSON contract's names, so an agent that learned the
 * ledger from `docs/ledger.md` already knows them. `seq` keeps insertion order,
 * which the app relies on; `id` stays unique because the editor merges by it.
 *
 * No secondary indexes. Every save replaces every row, and at 30k transactions
 * three indexes more than doubled that (~110ms to ~240ms), while a full scan of
 * the same table answers an agent's query in milliseconds.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value
);
CREATE TABLE IF NOT EXISTS transactions (
  seq         INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  date        TEXT,
  description TEXT,
  amount      REAL,
  accountName TEXT,
  accountKind TEXT,
  sourceFile  TEXT,
  fingerprint TEXT,
  categoryId  TEXT,
  importedAt  INTEGER,
  -- Chosen by hand for this one transaction; wins over every rule. NULL on
  -- almost every row. See pinCategory in src/lib/finance/ledger.ts.
  pinnedCategoryId TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  seq        INTEGER PRIMARY KEY,
  id         TEXT,
  pattern    TEXT,
  categoryId TEXT,
  createdAt  INTEGER,
  source     TEXT,
  -- A paper check's bank line is just "CHECK", so a rule on it would give
  -- every future check the last one's category. Checks are pinned instead.
  -- The engine already refuses to apply such a rule (ruleApplies); this makes
  -- writing one straight into the table fail rather than sit there inert.
  CONSTRAINT no_rule_on_a_bare_check CHECK (lower(trim(pattern)) NOT IN ('check', 'chk'))
);
CREATE TABLE IF NOT EXISTS setAsides (
  seq    INTEGER PRIMARY KEY,
  id     TEXT,
  name   TEXT,
  amount REAL
);
`;

/**
 * What makes a query over the ledger right, kept in the file instead of only in
 * `docs/ledger.md`. The views are the dashboard's rules, not a second version
 * of them: `spend` is `isSpend`, `income` is `isIncome` (src/lib/finance/
 * ledger.ts), and a test holds them to it row for row.
 *
 * - Transfers are neither spend nor income. `IS NOT` rather than `!=`, so an
 *   uncategorized row (NULL) still counts -- it is real money.
 * - `categories` carries the names, which otherwise ship only in the build.
 *
 * Refreshed inside every write, so the names track the build that last saved.
 */
const DERIVED = `
CREATE TABLE IF NOT EXISTS categories (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  "group" TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS spend AS
  SELECT * FROM transactions WHERE amount < 0 AND categoryId IS NOT '${TRANSFER_CATEGORY}';
CREATE VIEW IF NOT EXISTS income AS
  SELECT * FROM transactions WHERE amount > 0 AND categoryId IS NOT '${TRANSFER_CATEGORY}';
CREATE VIEW IF NOT EXISTS uncategorized AS
  SELECT * FROM transactions WHERE categoryId IS NULL;
`;

function refreshDerived(db) {
  db.exec(DERIVED);
  db.exec("DELETE FROM categories");
  const insert = db.prepare('INSERT INTO categories (id, name, "group") VALUES (?, ?, ?)');
  for (const c of CATEGORIES) insert.run(c.id, c.name, c.group);
}

/** A snapshot that cannot be stored as given: the server answers 400, not 500. */
export class LedgerShapeError extends Error {}

/* ------------------------------------------------------------------- open */

/**
 * What sits at `name` inside the directory behind `dirFd`, without following
 * it: `{ status: "missing" }`, `{ status: "refused" }` for a symlink, anything
 * but a regular file, or a file over the cap, or `{ status: "present", dev,
 * ino }` naming exactly the inode that was checked.
 *
 * The open goes through `dirFd` rather than a fresh pathname lookup, and
 * `O_NOFOLLOW` on the final component makes the kernel refuse a symlink there
 * instead of resolving it -- `node:sqlite` has no `SQLITE_OPEN_NOFOLLOW` of its
 * own. Returning the checked inode, not just a verdict, is what lets the
 * caller prove afterward that nothing else took that name in the meantime.
 *
 * `keepOpen` leaves a `"present"` result's descriptor open and returns it as
 * `fd`, so a caller that needs to act on exactly the inode just verified (for
 * example, setting its mode) can do so through the descriptor rather than
 * resolving the name by path a second time. The caller then owns closing it.
 */
function inspectAt(dirFd, name, { keepOpen = false } = {}) {
  let fd;
  try {
    fd = openSync(`/proc/self/fd/${dirFd}/${name}`, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (err) {
    return { status: err?.code === "ENOENT" ? "missing" : "refused" };
  }
  const info = fstatSync(fd);
  if (!info.isFile() || info.size > MAX_LEDGER_BYTES) {
    closeSync(fd);
    return { status: "refused" };
  }
  if (!keepOpen) closeSync(fd);
  return keepOpen
    ? { status: "present", dev: info.dev, ino: info.ino, fd }
    : { status: "present", dev: info.dev, ino: info.ino };
}

/** "missing", "present", or "refused" for the database in `dir`, without opening it. */
function inspectDb(dir) {
  let dirFd;
  try {
    dirFd = openSync(dir, FS.O_RDONLY | FS.O_DIRECTORY);
  } catch {
    return "missing";
  }
  try {
    return inspectAt(dirFd, DB_FILENAME).status;
  } finally {
    closeSync(dirFd);
  }
}

/**
 * The database in `dir`, or null when there is none (and `create` is false) or
 * what is there is refused.
 *
 * A `lstat` on the pathname followed by a separate open of that same pathname
 * leaves a window between the two: anything able to write into `dir` --
 * including a folder that is synced or mounted rather than purely local -- can
 * drop a symlink in after the check and have SQLite's own open follow it out
 * of the ledger's folder. This opens the directory once and keeps that
 * descriptor for everything that follows, so the name is always resolved
 * against the exact directory that was checked, never a fresh lookup by path.
 * After `DatabaseSync` opens the name, the same descriptor is used to inspect
 * it again: if the device/inode pair is not the one just verified -- the name
 * was retargeted while the open was in flight -- the connection is refused
 * rather than used, closing the gap a standalone `lstat` cannot.
 */
function openDb(dir, { readOnly = false, create = false } = {}) {
  let dirFd;
  try {
    dirFd = openSync(dir, FS.O_RDONLY | FS.O_DIRECTORY);
  } catch {
    return null;
  }
  const release = () => {
    try {
      closeSync(dirFd);
    } catch {
      /* already closed */
    }
  };

  const before = inspectAt(dirFd, DB_FILENAME);
  if (before.status === "refused" || (before.status === "missing" && !create)) {
    release();
    return null;
  }

  const at = `/proc/self/fd/${dirFd}/${DB_FILENAME}`;
  let db;
  let after;
  try {
    db = new DatabaseSync(at, { readOnly, timeout: BUSY_TIMEOUT_MS, allowExtension: false });
    // Only a freshly created database needs its mode fixed, so the descriptor
    // is kept open for exactly that case rather than every open paying for it.
    after = inspectAt(dirFd, DB_FILENAME, { keepOpen: before.status === "missing" });
    const same =
      after.status === "present" &&
      (before.status === "missing" || (after.dev === before.dev && after.ino === before.ino));
    if (!same) throw new Error("the ledger database changed identity while it was being opened");
    // SQLite creates the file with the process umask (0644 here), where every
    // other file Omakei writes is 0600. It gives its journal the database's
    // mode, so setting it once on creation covers both. `fchmod` acts on the
    // descriptor just verified, rather than resolving the name by path again.
    if (before.status === "missing") fchmodSync(after.fd, 0o600);
    db.enableDefensive(true);
    db.exec("PRAGMA trusted_schema = OFF");
    if (!readOnly) db.exec("PRAGMA journal_mode = DELETE");
  } catch {
    try {
      db?.close();
    } catch {
      /* not open */
    }
    release();
    return null;
  } finally {
    if (after?.fd !== undefined) closeSync(after.fd);
  }

  return {
    db,
    close() {
      try {
        db.close();
      } finally {
        release();
      }
    },
  };
}

/* ----------------------------------------------------------------- schema */

function getMeta(db, key) {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Creates the tables on a new database; a no-op on an existing one. */
function ensureSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA);
    if (getMeta(db, "schemaVersion") === null) {
      setMeta(db, "schemaVersion", SCHEMA_VERSION);
      setMeta(db, "ledgerId", randomBytes(8).toString("hex"));
      setMeta(db, "revision", 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** A database written by a newer Omakei, or not by Omakei at all, is not read. */
function isOurs(db) {
  const version = getMeta(db, "schemaVersion");
  return typeof version === "number" && version <= SCHEMA_VERSION && getMeta(db, "ledgerId") !== null;
}

/* --------------------------------------------------------------- snapshot */

/**
 * The version a write must name, as `If-Match` carries it.
 *
 * A counter works here where it did not for the JSON file: the revision is read
 * and bumped inside a transaction that holds the write lock, so no two writers
 * can ever see the same value and both proceed. The ledger id is part of it so
 * an etag from one folder's ledger can never match another's.
 *
 * "" is a database that has never been written -- the same "no ledger yet" the
 * JSON etag meant, so two clients both creating the first ledger still resolve.
 */
function etagOf(db) {
  const revision = getMeta(db, "revision");
  if (!revision) return "";
  return `${getMeta(db, "ledgerId")}-${revision}`;
}

function rowsOf(db, table, columns) {
  const statement = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY seq`);
  // Arrays skip building a null-prototype object per row that would only be
  // copied into a plain one; a quarter of the read at 30k rows. Older Node
  // lacks the switch and gets the objects.
  const toRow = (valueAt) => {
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      const value = valueAt(i) ?? null;
      if (value === null && OPTIONAL_KEYS.has(columns[i])) continue;
      row[columns[i]] = value;
    }
    return row;
  };
  if (typeof statement.setReturnArrays === "function") {
    statement.setReturnArrays(true);
    return statement.all().map((values) => toRow((i) => values[i]));
  }
  return statement.all().map((row) => toRow((i) => row[columns[i]]));
}

/** The ledger in the JSON snapshot shape, or null when nothing has been written. */
function readSnapshot(db) {
  if (!getMeta(db, "revision")) return null;
  return {
    version: 1,
    savedAt: getMeta(db, "savedAt") ?? "",
    selectedMonth: getMeta(db, "selectedMonth") ?? "",
    transactions: rowsOf(db, "transactions", TX_COLUMNS),
    rules: rowsOf(db, "rules", RULE_COLUMNS),
    setAsides: rowsOf(db, "setAsides", SET_ASIDE_COLUMNS),
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** SQLite binds strings, numbers, and null; anything else would be stored as something it is not. */
function bindable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new LedgerShapeError("A ledger field holds a value SQLite cannot store");
}

function insertAll(db, table, columns, items, label) {
  if (items === undefined) return;
  if (!Array.isArray(items)) throw new LedgerShapeError(`${label} is not a list`);
  const insert = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  const known = new Set(columns);
  for (const item of items) {
    if (!isRecord(item)) throw new LedgerShapeError(`A ${label} entry is not an object`);
    // A key with no column would be dropped on the floor, and nothing would
    // notice until the data was gone: that is how a new field like
    // `pinnedCategoryId` gets lost. Refuse the snapshot instead, so adding a
    // field without adding its column fails the first save and every test.
    for (const key of Object.keys(item)) {
      if (!known.has(key)) throw new LedgerShapeError(`A ${label} has a field the ledger does not store: ${key}`);
    }
    insert.run(...columns.map((c) => bindable(item[c])));
  }
}

/** Replace every row with `ledger`'s, bump the revision. Call inside a write transaction. */
function replaceSnapshot(db, ledger) {
  if (!isLedgerPayload(ledger)) throw new LedgerShapeError("Invalid ledger");
  for (const key of Object.keys(ledger)) {
    if (!SNAPSHOT_KEYS.has(key)) throw new LedgerShapeError(`The ledger has a field it does not store: ${key}`);
  }
  for (const tx of ledger.transactions) {
    if (!isRecord(tx) || typeof tx.id !== "string") {
      throw new LedgerShapeError("Every transaction needs a string id");
    }
  }
  db.exec("DELETE FROM transactions; DELETE FROM rules; DELETE FROM setAsides;");
  try {
    insertAll(db, "transactions", TX_COLUMNS, ledger.transactions, "transaction");
  } catch (err) {
    if (String(err?.message).includes("UNIQUE")) {
      throw new LedgerShapeError("Two transactions share an id");
    }
    throw err;
  }
  try {
    insertAll(db, "rules", RULE_COLUMNS, ledger.rules, "rule");
  } catch (err) {
    if (String(err?.message).includes("no_rule_on_a_bare_check")) {
      throw new LedgerShapeError("A rule on a bare check cannot be stored; checks are pinned, not ruled");
    }
    throw err;
  }
  insertAll(db, "setAsides", SET_ASIDE_COLUMNS, ledger.setAsides, "set-aside");
  setMeta(db, "savedAt", typeof ledger.savedAt === "string" ? ledger.savedAt : new Date().toISOString());
  setMeta(db, "selectedMonth", typeof ledger.selectedMonth === "string" ? ledger.selectedMonth : "");
  refreshDerived(db);
  setMeta(db, "revision", (getMeta(db, "revision") ?? 0) + 1);
}

/* --------------------------------------------------------------------- api */

/**
 * The ledger in `dir` and the etag of exactly that version. Never writes.
 *
 * `{ ledger: null, etag: "" }` when there is no database or nothing in it;
 * null when a database is there but refused (a link, too large, not ours).
 */
export async function readLedgerDb(dir) {
  const handle = openDb(dir, { readOnly: true });
  if (!handle) {
    return inspectDb(dir) === "missing" ? { ledger: null, etag: "" } : null;
  }
  try {
    if (!isOurs(handle.db)) return null;
    return { ledger: readSnapshot(handle.db), etag: etagOf(handle.db) };
  } catch {
    return null;
  } finally {
    handle.close();
  }
}

/**
 * Read, decide, and write as one transaction under SQLite's write lock.
 *
 * `decide({ etag, ledger })` sees the version as it is right now and returns
 * the snapshot to store, or null to leave it alone. `ledger` is read only if
 * `decide` touches it: a save that only compares etags should not pay for
 * reading every row first. `decide` must be synchronous -- nothing else can
 * write while it runs, which is the whole point, so it should not wait on
 * anything either.
 *
 * Resolves `{ written: true, ledger, etag }` with the snapshot `decide` returned
 * and the new etag, or `{ written: false, ledger, etag }` with the untouched
 * current ledger. Rejects with `LedgerShapeError` for a snapshot that cannot be
 * stored, and resolves null when the database is refused.
 */
export async function updateLedgerDb(dir, decide, { create = true } = {}) {
  const handle = openDb(dir, { create });
  if (!handle) return null;
  const { db } = handle;
  try {
    // Only a database with nothing in it yet is given the schema. Adding tables
    // to some other SQLite file would quietly adopt it as the ledger.
    const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n === 0;
    if (empty) ensureSchema(db);
    if (!isOurs(db)) return null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const etag = etagOf(db);
      let current;
      const view = {
        etag,
        get ledger() {
          if (current === undefined) current = readSnapshot(db);
          return current;
        },
      };
      const next = decide(view);
      if (!next) {
        const ledger = view.ledger;
        db.exec("ROLLBACK");
        return { written: false, ledger, etag };
      }
      replaceSnapshot(db, next);
      const written = etagOf(db);
      db.exec("COMMIT");
      return { written: true, ledger: next, etag: written };
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    handle.close();
  }
}
