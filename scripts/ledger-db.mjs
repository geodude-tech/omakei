/**
 * The ledger, as a SQLite database in a private directory (`ledgerDirFor`).
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
import { chmodSync, closeSync, constants as FS, fstatSync, lstatSync, openSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { DB_FILENAME, MAX_LEDGER_BYTES, isLedgerPayload } from "./ledger-api.mjs";
import { CATEGORIES, TRANSFER_CATEGORY } from "../src/lib/finance/categories.ts";
import { MARK_KINDS, MAX_MARKS, MAX_MARK_KEY, MAX_MARK_REF } from "../src/lib/finance/subscriptions.ts";

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
const MARK_COLUMNS = ["key", "kind", "ref", "createdAt"];

/**
 * Keys a row may leave out entirely. Absent on almost every transaction, so a
 * NULL here reads back as no key at all rather than `pinnedCategoryId: null`,
 * and a snapshot round-trips to exactly the shape it was written in.
 */
const OPTIONAL_KEYS = new Set(["pinnedCategoryId"]);

const SNAPSHOT_KEYS = new Set([
  "version",
  "savedAt",
  "selectedMonth",
  "transactions",
  "rules",
  "setAsides",
  "subscriptionMarks",
]);

/**
 * What the user said about a recurring charge: "not a subscription", or "I saw
 * this flag" (docs/spec/subscriptions.md). Added after cutover, so it is
 * created with IF NOT EXISTS inside every write rather than by a version bump:
 * a ledger from before it gains the table on its next save, and an older
 * Omakei reading or writing the same file neither refuses it nor clears it --
 * it only replaces the tables it knows.
 */
const MARKS_TABLE = `
CREATE TABLE IF NOT EXISTS subscriptionMarks (
  seq       INTEGER PRIMARY KEY,
  key       TEXT NOT NULL,
  kind      TEXT NOT NULL,
  ref       TEXT NOT NULL,
  createdAt INTEGER
);
`;

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
${MARKS_TABLE}`;

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
 * What sits where the database goes, without following it: `"missing"`,
 * `"present"`, or `"refused"` for a symlink, anything but a regular file, or a
 * file over the cap.
 *
 * SQLite opens by pathname and follows a symlink, and `node:sqlite` has no
 * `SQLITE_OPEN_NOFOLLOW`, so a link in place of the ledger is refused here
 * before SQLite sees it. On its own that is only a check of a name, which
 * something able to write the directory could swap before SQLite opens it.
 * That is why a writable open also requires `privateDir`: in a directory only
 * this user can change, there is nobody to swap it.
 */
function inspectDb(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    return err?.code === "ENOENT" ? "missing" : "refused";
  }
  return info.isFile() && info.size <= MAX_LEDGER_BYTES ? "present" : "refused";
}

/**
 * Whether every directory above `dir` is safe from renames by anyone but this
 * user: owned by this user or root, and not group- or other-writable unless
 * sticky (as `/tmp` is, where others cannot rename what is ours).
 */
function ancestorsAreSafe(dir, uid) {
  let at = dirname(dir);
  for (;;) {
    let info;
    try {
      info = statSync(at);
    } catch {
      return false;
    }
    if (info.uid !== uid && info.uid !== 0) return false;
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) return false;
    const up = dirname(at);
    if (up === at) return true;
    at = up;
  }
}

/**
 * `dir`, opened without following a link and held open, if only this user can
 * change what is in it: owned by this user, mode 0700 or tighter, with no
 * ancestor anyone else could rename it out from under. Null otherwise.
 *
 * This is what makes it safe for SQLite to open the database by name: the
 * journal it creates and deletes beside it, and the database itself, sit in a
 * directory nobody else can write. The descriptor is retained so `openDb` can
 * fail if the directory at that path is no longer the one checked.
 */
function privateDir(dir) {
  const uid = process.getuid?.();
  if (typeof uid !== "number") return null;
  let fd;
  try {
    fd = openSync(dir, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (info.uid === uid && (info.mode & 0o077) === 0 && ancestorsAreSafe(dir, uid)) return { fd, info };
  } catch {
    /* refused below */
  }
  if (fd !== undefined) closeSync(fd);
  return null;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * The database in `dir`, or null when there is none (and `create` is false) or
 * what is there is refused.
 *
 * A writable open is refused outside a private directory (`privateDir`). That
 * is the line between the ledger and whatever folder the user attached: the
 * statements folder may be shared, synced, or mounted, and a pathname check
 * there cannot stop SQLite's read/write transaction from following a swapped-in
 * link. A read-only open keeps the old rules, so the widget's `ledgerPath`
 * override can still point at a ledger kept elsewhere.
 */
function openDb(dir, { readOnly = false, create = false } = {}) {
  const path = join(dir, DB_FILENAME);
  let held = null;
  if (!readOnly) {
    held = privateDir(dir);
    if (!held) return null;
  }
  let db;
  try {
    const found = inspectDb(path);
    if (found === "refused" || (found === "missing" && !create)) return null;
    db = new DatabaseSync(path, { readOnly, timeout: BUSY_TIMEOUT_MS, allowExtension: false });
    // The directory SQLite just opened into has to be the one checked, and
    // what it opened has to be a regular file. Neither can change from here
    // on, because nobody else can write the directory; this catches the case
    // where it changed before.
    if (held && !sameFile(lstatSync(dir), held.info)) throw new Error("ledger directory changed");
    if (held && !lstatSync(path).isFile()) throw new Error("ledger is not a regular file");
    // SQLite creates the file with the process umask (0644 here), where every
    // other file Omakei writes is 0600. It gives its journal the database's
    // mode, so setting it once on creation covers both.
    if (found === "missing") chmodSync(path, 0o600);
    db.enableDefensive(true);
    db.exec("PRAGMA trusted_schema = OFF");
    if (!readOnly) db.exec("PRAGMA journal_mode = DELETE");
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      /* not open */
    }
    return null;
  } finally {
    if (held) closeSync(held.fd);
  }
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

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * The ledger in the JSON snapshot shape, or null when nothing has been written.
 * `subscriptionMarks` appears only when there are some, so a ledger without
 * them reads back in exactly the shape it was written in -- including one from
 * before the table existed, which a read-only open cannot add it to.
 */
function readSnapshot(db) {
  if (!getMeta(db, "revision")) return null;
  const snapshot = {
    version: 1,
    savedAt: getMeta(db, "savedAt") ?? "",
    selectedMonth: getMeta(db, "selectedMonth") ?? "",
    transactions: rowsOf(db, "transactions", TX_COLUMNS),
    rules: rowsOf(db, "rules", RULE_COLUMNS),
    setAsides: rowsOf(db, "setAsides", SET_ASIDE_COLUMNS),
  };
  if (hasTable(db, "subscriptionMarks")) {
    const marks = rowsOf(db, "subscriptionMarks", MARK_COLUMNS);
    if (marks.length > 0) snapshot.subscriptionMarks = marks;
  }
  return snapshot;
}

/**
 * Marks come from the browser, so they are held to their shape here rather
 * than trusted: a known kind, short strings, and a bounded count.
 */
function checkMarks(marks) {
  if (!Array.isArray(marks)) throw new LedgerShapeError("subscriptionMarks is not a list");
  if (marks.length > MAX_MARKS) throw new LedgerShapeError("Too many subscription marks");
  for (const m of marks) {
    if (!isRecord(m)) throw new LedgerShapeError("A subscription mark is not an object");
    if (typeof m.key !== "string" || m.key.length === 0 || m.key.length > MAX_MARK_KEY) {
      throw new LedgerShapeError("A subscription mark has a bad key");
    }
    if (!MARK_KINDS.includes(m.kind)) throw new LedgerShapeError("A subscription mark has an unknown kind");
    if (typeof m.ref !== "string" || m.ref.length > MAX_MARK_REF) {
      throw new LedgerShapeError("A subscription mark has a bad ref");
    }
    if (m.createdAt !== undefined && m.createdAt !== null && !Number.isFinite(m.createdAt)) {
      throw new LedgerShapeError("A subscription mark has a bad createdAt");
    }
  }
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
  // Absent means "this writer does not know about marks" (omakei-categorize.mjs,
  // an older editor): leave them. An empty list is the editor clearing them.
  if (ledger.subscriptionMarks !== undefined) {
    checkMarks(ledger.subscriptionMarks);
    db.exec("DELETE FROM subscriptionMarks");
    insertAll(db, "subscriptionMarks", MARK_COLUMNS, ledger.subscriptionMarks, "subscription mark");
  }
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
  const db = openDb(dir, { readOnly: true });
  if (!db) {
    return inspectDb(join(dir, DB_FILENAME)) === "missing" ? { ledger: null, etag: "" } : null;
  }
  try {
    if (!isOurs(db)) return null;
    return { ledger: readSnapshot(db), etag: etagOf(db) };
  } catch {
    return null;
  } finally {
    db.close();
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
 * stored, and resolves null when the database is refused -- including when
 * `dir` is not a private directory (see `openDb`).
 */
export async function updateLedgerDb(dir, decide, { create = true } = {}) {
  const db = openDb(dir, { create });
  if (!db) return null;
  try {
    // Only a database with nothing in it yet is given the schema. Adding tables
    // to some other SQLite file would quietly adopt it as the ledger.
    const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n === 0;
    if (empty) ensureSchema(db);
    if (!isOurs(db)) return null;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MARKS_TABLE);
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
    db.close();
  }
}
