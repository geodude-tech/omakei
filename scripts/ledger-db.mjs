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
 * The JSON is never written here. When a folder has a JSON ledger and no
 * database, the JSON is read once and imported; the file is left exactly as it
 * was, which is also the rollback.
 *
 * Built-in `node:sqlite` only: installers never run `npm install`.
 */
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  constants as FS,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  DB_FILENAME,
  LEDGER_FILENAME,
  MAX_LEDGER_BYTES,
  isLedgerPayload,
  ledgerEtag,
  readCapped,
} from "./ledger-api.mjs";

export { DB_FILENAME };
export const SCHEMA_VERSION = 2;

/** How long a write waits on another process's lock before giving up. Writes take milliseconds. */
const BUSY_TIMEOUT_MS = 5000;

/** The files SQLite may keep beside the database. Any of them could be a planted symlink. */
const SIDECARS = ["-journal", "-wal", "-shm"];

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
];
const RULE_COLUMNS = ["id", "pattern", "categoryId", "createdAt", "source"];
const SET_ASIDE_COLUMNS = ["id", "name", "amount"];

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
  importedAt  INTEGER
);
CREATE TABLE IF NOT EXISTS rules (
  seq        INTEGER PRIMARY KEY,
  id         TEXT,
  pattern    TEXT,
  categoryId TEXT,
  createdAt  INTEGER,
  source     TEXT
);
CREATE TABLE IF NOT EXISTS setAsides (
  seq    INTEGER PRIMARY KEY,
  id     TEXT,
  name   TEXT,
  amount REAL
);
`;

/** A snapshot that cannot be stored as given: the server answers 400, not 500. */
export class LedgerShapeError extends Error {}

/* ------------------------------------------------------------------- open */

/**
 * What sits at `name` in the directory behind `at`, without following it.
 * `"missing"`, `"refused"`, or the fstat of a regular file within the cap.
 */
function inspect(at, name) {
  let fd;
  try {
    fd = openSync(`${at}/${name}`, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (err) {
    return err?.code === "ENOENT" ? "missing" : "refused";
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_LEDGER_BYTES) return "refused";
    return info;
  } finally {
    closeSync(fd);
  }
}

/** Sidecars may be absent; if present they must be plain files, never links. */
function sidecarsAreSafe(at, name) {
  for (const suffix of SIDECARS) {
    try {
      if (!lstatSync(`${at}/${name}${suffix}`).isFile()) return false;
    } catch (err) {
      if (err?.code !== "ENOENT") return false;
    }
  }
  return true;
}

/**
 * Open the database in `dir`, holding the same line `readCapped` does.
 *
 * SQLite opens by pathname and follows a symlink at the final component, and
 * `node:sqlite` has no `SQLITE_OPEN_NOFOLLOW`. So the file is inspected first
 * with `O_NOFOLLOW` (a regular file, within the cap), the sidecars are checked
 * for links, and after SQLite opens it the path is `lstat`ed again and must
 * still be the same inode. A swap between those steps is refused rather than
 * read.
 *
 * The directory descriptor is anchored the way `withDir` anchors every other
 * disk touch, and it stays open for as long as the connection does: SQLite
 * creates its journal by name mid-write, and that name has to keep resolving
 * into the directory that was checked.
 *
 * Returns `{ db, close }`, or null when there is no database (and `create` is
 * false) or what is there is refused.
 */
function openDb(dir, { readOnly = false, create = false, name = DB_FILENAME } = {}) {
  let dirFd;
  try {
    dirFd = openSync(dir, FS.O_RDONLY | FS.O_DIRECTORY);
  } catch {
    return null;
  }
  const at = `/proc/self/fd/${dirFd}`;
  const release = () => {
    try {
      closeSync(dirFd);
    } catch {
      /* already closed */
    }
  };

  const before = inspect(at, name);
  if (before === "refused" || (before === "missing" && !create) || !sidecarsAreSafe(at, name)) {
    release();
    return null;
  }

  let db;
  try {
    db = new DatabaseSync(`${at}/${name}`, {
      readOnly,
      timeout: BUSY_TIMEOUT_MS,
      allowExtension: false,
    });
    const now = lstatSync(`${at}/${name}`);
    const same =
      now.isFile() &&
      (before === "missing" || (now.dev === before.dev && now.ino === before.ino));
    if (!same) throw new Error("ledger database changed while it was being opened");
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
  if (typeof statement.setReturnArrays === "function") {
    statement.setReturnArrays(true);
    return statement.all().map((values) => {
      const row = {};
      for (let i = 0; i < columns.length; i++) row[columns[i]] = values[i] ?? null;
      return row;
    });
  }
  return statement.all().map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
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
  for (const item of items) {
    if (!isRecord(item)) throw new LedgerShapeError(`A ${label} entry is not an object`);
    insert.run(...columns.map((c) => bindable(item[c])));
  }
}

/** Replace every row with `ledger`'s, bump the revision. Call inside a write transaction. */
function replaceSnapshot(db, ledger) {
  if (!isLedgerPayload(ledger)) throw new LedgerShapeError("Invalid ledger");
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
  insertAll(db, "rules", RULE_COLUMNS, ledger.rules, "rule");
  insertAll(db, "setAsides", SET_ASIDE_COLUMNS, ledger.setAsides, "set-aside");
  setMeta(db, "savedAt", typeof ledger.savedAt === "string" ? ledger.savedAt : new Date().toISOString());
  setMeta(db, "selectedMonth", typeof ledger.selectedMonth === "string" ? ledger.selectedMonth : "");
  setMeta(db, "revision", (getMeta(db, "revision") ?? 0) + 1);
}

/* ------------------------------------------------------------------ import */

/**
 * Build a database from the folder's JSON ledger, if it has one and no database.
 *
 * The JSON is only read, through `readCapped`. The database is built under a
 * random temp name in the same directory and published with `link`, which --
 * unlike `rename` -- refuses to replace a file that is already there: a second
 * process importing at the same moment cannot overwrite a database the first one
 * has already started writing to. The hash of the JSON imported is kept, so a
 * later change to that file can be noticed instead of silently ignored.
 *
 * Returns true if a database now exists that did not before.
 */
export async function importJsonLedger(dir) {
  // Every read and write calls this, so the common case -- a database is
  // already there -- must cost a stat, not a parse of the JSON.
  if (inspectPath(dir) !== "missing") return false;
  const raw = await readCapped(join(dir, LEDGER_FILENAME), MAX_LEDGER_BYTES);
  if (!raw) return false;
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return false;
  }
  if (!isLedgerPayload(parsed)) return false;

  let dirFd;
  try {
    dirFd = openSync(dir, FS.O_RDONLY | FS.O_DIRECTORY);
  } catch {
    return false;
  }
  const at = `/proc/self/fd/${dirFd}`;
  const tmpName = `.${DB_FILENAME}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = openDb(dir, { create: true, name: tmpName });
    if (!handle) return false;
    try {
      ensureSchema(handle.db);
      handle.db.exec("BEGIN IMMEDIATE");
      try {
        replaceSnapshot(handle.db, parsed);
        setMeta(handle.db, "importedFromEtag", ledgerEtag(raw));
        setMeta(handle.db, "importedAt", Date.now());
        handle.db.exec("COMMIT");
      } catch (err) {
        handle.db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      handle.close();
    }
    try {
      linkSync(`${at}/${tmpName}`, `${at}/${DB_FILENAME}`);
      return true;
    } catch (err) {
      if (err?.code === "EEXIST") return false;
      throw err;
    }
  } finally {
    for (const suffix of ["", ...SIDECARS]) {
      try {
        unlinkSync(`${at}/${tmpName}${suffix}`);
      } catch {
        /* never created */
      }
    }
    closeSync(dirFd);
  }
}

/**
 * Whether the JSON ledger has changed since it was imported.
 *
 * After cutover nothing in this codebase writes the JSON, so a change means
 * something older still does -- an out-of-date checkout's categorize command,
 * say -- and those edits are not in the database. That is worth saying out
 * loud; it is not worth guessing which side is right, so nothing re-imports.
 */
export async function jsonChangedSinceImport(dir) {
  const handle = openDb(dir, { readOnly: true });
  if (!handle) return false;
  let imported;
  try {
    imported = getMeta(handle.db, "importedFromEtag");
  } finally {
    handle.close();
  }
  if (typeof imported !== "string") return false;
  const raw = await readCapped(join(dir, LEDGER_FILENAME), MAX_LEDGER_BYTES);
  return Boolean(raw) && ledgerEtag(raw) !== imported;
}

/* --------------------------------------------------------------------- api */

/**
 * The ledger in `dir` and the etag of exactly that version.
 *
 * `importJson` lets a caller that owns the folder (the server, the categorize
 * command) turn a JSON-only folder into a database on first read. The widget's
 * reader passes false and gets `null` back instead, so it never writes.
 *
 * `{ ledger: null, etag: "" }` when there is no database or nothing in it;
 * null when a database is there but refused (a link, too large, not ours).
 */
export async function readLedgerDb(dir, { importJson = false } = {}) {
  if (importJson) await importJsonLedger(dir);
  const handle = openDb(dir, { readOnly: true });
  if (!handle) {
    return inspectPath(dir) === "missing" ? { ledger: null, etag: "" } : null;
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

function inspectPath(dir) {
  let dirFd;
  try {
    dirFd = openSync(dir, FS.O_RDONLY | FS.O_DIRECTORY);
  } catch {
    return "missing";
  }
  try {
    const found = inspect(`/proc/self/fd/${dirFd}`, DB_FILENAME);
    return typeof found === "string" ? found : "present";
  } finally {
    closeSync(dirFd);
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
  await importJsonLedger(dir);
  const handle = openDb(dir, { create });
  if (!handle) return null;
  try {
    // Only a database with nothing in it yet is given the schema. Adding tables
    // to some other SQLite file would quietly adopt it as the ledger.
    const empty = handle.db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n === 0;
    if (empty) ensureSchema(handle.db);
    if (!isOurs(handle.db)) return null;
    const { db } = handle;
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
