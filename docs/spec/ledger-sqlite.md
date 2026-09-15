# Spec: The Ledger as SQLite

_Status: implemented 2026-09-14, not yet cut over on a real folder. Traces to
`docs/intent/omakei.md` ("SQLite", decided)._

## Objective

Replace `omakei-ledger.json` with `omakei-ledger.sqlite` in the attached folder,
for two reasons the JSON could not meet:

1. **The query rules live in the file.** `docs/ledger.md`'s rules 1–3 (transfers
   are not spend or income; names are ids; uncategorized money counts) are views
   and a table, so `SELECT sum(amount) FROM spend` is the dashboard's number
   without first reading the rules.
2. **The two writers share a lock.** The server and `omakei-categorize.mjs`
   both write the ledger. With a file they could only narrow the window in which
   one overwrote the other (ledger-server Open Question 0). A `BEGIN IMMEDIATE`
   transaction closes it.

Performance was not a reason, and did not get better (see Measured).

**Success:** an agent with `sqlite3` gets the dashboard's spend, income, and net
from the views; the editor, bar widget, and `Model.js` behave exactly as
before; no write from either writer can be silently undone by the other; and
the existing JSON is imported without being modified.

## Tech Stack

`node:sqlite` (built into Node; unflagged since 22.13 / 23.4, no warning on
Node 26). No npm dependency — the server stays installable by `git clone`.

## Project Structure

```
scripts/ledger-db.mjs        → the database: guarded open, schema, snapshot read, locked write, JSON import
scripts/ledger-db.test.mjs   → storage, concurrency, import, guards, views, and docs/ledger.md's SQL
scripts/ledger-api.mjs       → GET /state and PUT /ledger go through ledger-db
scripts/omakei-categorize.mjs → one transaction per command
scripts/omakei-read-ledger.mjs → read-only; prints the same JSON as before
```

## Schema (version 2)

Column names are the JSON contract's field names.

| object | kind | notes |
|---|---|---|
| `transactions` | table | `seq` insertion order, `id` unique, `pinnedCategoryId` nullable |
| `rules` | table | `CHECK` rejects a pattern of `check` / `chk` (checks are pinned, not ruled) |
| `setAsides` | table | |
| `meta` | table | `schemaVersion`, `ledgerId`, `revision`, `savedAt`, `selectedMonth`, `importedFromEtag`, `importedAt` |
| `categories` | table | rewritten from `CATEGORIES` in every write |
| `spend` / `income` | views | `amount <|> 0 AND categoryId IS NOT 'transfers'` — `isSpend` / `isIncome` |
| `uncategorized` | view | `categoryId IS NULL` |

No secondary indexes: every save replaces every row, and three indexes doubled
it at 30k rows while a full scan answers an agent's query in milliseconds.

## Decisions

- **The wire shape did not change.** `PUT /ledger` still carries a whole
  snapshot, `GET /state` still returns one, and the reader still prints one. The
  etag is opaque to the browser, so `src/` changed only in two strings.
- **Etag = `<ledgerId>-<revision>`,** bumped inside the write transaction. `""`
  still means "no ledger yet".
- **Rollback journal, not WAL.** WAL would leave `-wal` and `-shm` beside the
  user's statements permanently; the rollback journal exists only mid-write.
  Omakei's writes are milliseconds, so readers blocking during them is not felt.
- **A field with no column is refused, not dropped.** The first version would
  have silently discarded `pinnedCategoryId`, and the real ledger already had
  pins. A snapshot key or row key the schema does not store now fails the write
  (`400`) or the import, so the next new field fails a test instead of losing
  data.
- **Import is one-way and never writes the JSON.** Built under a random temp
  name and published with `link()`, which cannot replace an existing database.
  The JSON's SHA-256 is kept; if the JSON changes later, the server and the CLI
  warn, and nothing re-imports.
- **The widget never imports.** Before a folder is imported the reader falls
  back to the JSON; once a database exists — even one it refuses — it does not.
- **A planted symlink is refused (`409`), not replaced.** SQLite would follow
  it; replacing it the way `writeAtomic` did is not available for a database.

## Measured

Local, Node 26.5, synthetic rows:

| rows | save (`PUT`) | read (`/state`) | file |
|---|---|---|---|
| 1,400 (today's real ledger) | ~7 ms | ~4 ms | 0.2 MB |
| 30,000 (ten years) | ~120 ms | ~60–80 ms | 3.9 MB |

The JSON path was roughly 15–30 ms to serialize and write 30k rows. The save is
debounced and asynchronous in the editor, so this is not felt today; a
row-level diff instead of a full replace is the fix if it ever is.

## Cutover

Merging is the cutover: the next server start imports the attached folder.

1. Finish anything still writing `omakei-ledger.json` with older code (another
   checkout's `omakei-categorize.mjs`, an editor running from `main`).
2. Merge; restart the server (`omakei-open` starts it on demand).
3. Verify: `sha256sum omakei-ledger.json` unchanged;
   `sqlite3 -readonly omakei-ledger.sqlite 'select count(*) from transactions'`
   equals `jq '.transactions | length' omakei-ledger.json`; the dashboard's month
   matches what it showed before.

Rollback is reverting the merge. The JSON is the ledger as of the import;
anything edited since is only in the database (`omakei-read-ledger.mjs` prints
it as JSON).

## Boundaries

**Always:** open through `ledger-db.mjs`; write inside `updateLedgerDb`; keep
`docs/ledger.md`'s tables and SQL examples true (`ledger-db.test.mjs` runs them).

**Ask first:** WAL mode; secondary indexes; a schema version bump; deleting the
JSON after import.

**Never:** write `omakei-ledger.json`; re-import over an existing database; fall
back to the JSON when a database is present.

## Open Questions

1. **Residual open race.** Between the `O_NOFOLLOW` inspection and SQLite's own
   open, a swapped file is caught by the inode check afterwards — but for a
   *missing* database, a symlink planted in that gap is followed on create
   before it is noticed. Same-user attacker only; `openat2` would close it and
   Node has none.
2. **Schema changes.** `CREATE TABLE IF NOT EXISTS` does not alter an existing
   table. The first column added after cutover needs a real migration keyed on
   `schemaVersion`.
3. **Minimum Node for installers.** `node:sqlite` needs 22.13+. `omakei-open`
   does not check; an older Node fails at import with Node's own error.
4. **When does the JSON go away?** Never, by this spec.
