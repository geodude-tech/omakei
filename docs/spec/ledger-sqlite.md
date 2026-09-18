# Spec: The Ledger as SQLite

_Status: implemented and cut over 2026-09-14. The one-time JSON import was
removed afterwards as no longer earning its code; the descriptor-anchored open
was removed with it and then restored once a bare `lstat`-then-open was found
to reopen the pathname race it existed to close (see Decisions). Traces to
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
before; and no write from either writer can be silently undone by the other.

## Tech Stack

`node:sqlite` (built into Node; unflagged since 22.13 / 23.4, no warning on
Node 26). No npm dependency — the server stays installable by `git clone`.

## Project Structure

```
scripts/ledger-db.mjs        → the database: guarded open, schema, snapshot read, locked write
scripts/ledger-db.test.mjs   → storage, concurrency, guards, views, and docs/ledger.md's SQL
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
| `meta` | table | `schemaVersion`, `ledgerId`, `revision`, `savedAt`, `selectedMonth` (cutover databases also carry `importedFrom*`) |
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
  (`400`), so the next new field fails a test instead of losing data.
- **No JSON import, and no JSON fallback.** Cutover imported the one real
  ledger; Omakei has a single user, so the import code (race-safe `link()`
  publish, drift warning) was deleted once it had run. A folder with only
  `omakei-ledger.json` reads as no ledger. Restoring one from JSON is a one-off
  script through `updateLedgerDb`.
- **A symlink is refused (`409`), not replaced — the name is resolved once, not
  checked then reopened.** SQLite would follow a symlink at the final
  component, and `node:sqlite` has no `SQLITE_OPEN_NOFOLLOW`. A `lstat` on the
  pathname followed by a separate open of that pathname leaves a window
  between the two where the name can be swapped for a symlink — including by a
  synced or mounted folder's own client, not only a same-user attacker.
  Anchoring both steps to the same directory descriptor narrows that window
  but does not close it, since the open still looks the name up again; a swap
  timed between the check and the open, then reverted before a same-inode
  recheck, passes the recheck while SQLite is already holding the swapped-in
  file. So the name is opened exactly once, with `O_NOFOLLOW` on the final
  component, and `DatabaseSync` is handed `/proc/self/fd/<thatFd>` rather than
  the name: that path names the open file description just verified, and
  resolving it again always lands on that same inode regardless of what the
  name is later renamed to or replaced with — there is no second lookup left
  to race. This closes the main-file race; SQLite still names its rollback
  journal by the real path mid-write, which is not routed through the
  verified descriptor the same way (see Open Questions).

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

Done 2026-09-14. The database was imported once and the JSON has not been read
since. `omakei-read-ledger.mjs` prints the
ledger as JSON if it is ever needed in that shape again.

## Boundaries

**Always:** open through `ledger-db.mjs`; write inside `updateLedgerDb`; keep
`docs/ledger.md`'s tables and SQL examples true (`ledger-db.test.mjs` runs them).

**Ask first:** WAL mode; secondary indexes; a schema version bump; deleting the
leftover JSON.

**Never:** write `omakei-ledger.json`; read it as the ledger.

## Open Questions

1. **Journal race, accepted.** The main database file is opened once, by an
   `O_NOFOLLOW`-verified descriptor rather than a name `DatabaseSync` looks up
   again (see Decisions), which closes the race a bare `lstat`-then-open, or
   even a directory-descriptor-anchored recheck, left open. SQLite still
   creates its rollback journal by the real path mid-write, and that name is
   not opened through a verified descriptor the same way; a link placed there
   in that instant is followed. `openat2` would close it and Node has none.
2. **Schema changes.** `CREATE TABLE IF NOT EXISTS` does not alter an existing
   table. The first column added after cutover needs a real migration keyed on
   `schemaVersion`.
3. **Minimum Node for installers.** `node:sqlite` needs 22.13+. `omakei-open`
   does not check; an older Node fails at import with Node's own error.
4. **When does the JSON go away?** When the user deletes it; nothing reads it.
