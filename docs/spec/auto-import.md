# Spec: Drop-Folder Auto-Import

_Status: forward spec, then built (2026-10-08, branch `feat/drop-folder-import`).
Traces to `docs/intent/omakei.md`. [data-privacy-guards.md](data-privacy-guards.md),
[ledger-server.md](ledger-server.md) and [statement-import.md](statement-import.md)
take precedence._

## Objective

Drop a statement into the attached folder (`statementsDir`, with subfolders like
`Checking_and_Savings/`, `Credit_Card/`, `Mortgage/`) and it is in the ledger
without opening the editor: Bank of America PDFs converted with the existing
converter, CSV/TSV/OFX/QFX parsed with the existing parser, deduped, categorized
by the existing rules, and the user told "12 new transactions, 2 need a
category".

**Not in scope:** new statement formats, a new route, a key in `state.json`,
writing into the statements folder (no converted CSV is left beside a PDF), an
always-on daemon.

**Success:**

- Re-dropping the same file, or running twice, adds nothing.
- A half-written, unreadable, oddly named, or symlinked file never crashes a run
  and never imports garbage.
- Two runs at once cannot double-import.
- Everything written is inside the private state dir, 0600 in 0700 dirs.

## Trigger: one idempotent command, an opt-in systemd user timer

`scripts/omakei-import.mjs` does one pass and exits. A **systemd `--user`
timer** runs it every 15 minutes (`--notify`), installed by the user, not by
`omarchy plugin add`.

Why this over the alternatives:

| option | why not |
|---|---|
| inotify in the server | the server only runs while the editor is open (`omakei-open` starts it on demand); auto-import is for when it is not |
| systemd `.path` unit | does not watch subfolders, and fires on the first write of a file still being saved |
| a QML `Timer` in the widget | runs inside the bar process, and "nothing runs while Omakei is closed" (bar-widget spec) |
| import-on-open only | the editor already syncs CSVs on open; it is PDFs and the closed-editor case that are missing |

A timer catches every subfolder, survives restarts and sleep, is offline, and is
trivially removable. The importer itself is safe to run any time, so the editor's
own sync and the timer can overlap.

## A run

1. `umask 077`. Read `statementsDir` from `state.json` (`readCapped`). None → exit 1.
2. **Lock**: `<state>/omakei/import.lock`, `O_CREAT|O_EXCL|O_NOFOLLOW`, 0600,
   holding the pid. Held by a live process → print "already running", exit 0.
   Left by a dead pid or older than 30 min → removed and retaken once. Removed
   at exit. (The SQLite write transaction is the second line: the decision is
   made inside it, so even without the lock — or if two runs both clear the
   same stale lock — nothing imports twice.)
3. **Scan** (pure `planFiles` decides): walk up to 4 levels, never following a
   link (`readdir` types, so a symlinked file or folder is skipped); skip dot
   names; at most 5,000 files. Supported: `.csv .tsv .txt .ofx .qfx .ofc .pdf`.
   - **Settling:** a file modified in the last 2 minutes is left for the next run.
   - A `x.pdf` with `x.csv` beside it is skipped: the CSV is its conversion.
4. **Read** through the folder's descriptor, `O_NOFOLLOW|O_NONBLOCK`, regular
   file only, at most 32 MB, `fstat` before and after: a size or mtime change
   means still being written → left for next run. `sha256` of the bytes. Each
   subfolder is opened `O_NOFOLLOW` through its parent's descriptor, so a
   folder swapped for a link after the scan cannot redirect the read. A file
   over 32 MB is reported and left alone, not recorded.
5. **Already seen?** A file whose sha256 is recorded is skipped (same file
   renamed or copied too). `--rescan` ignores the records (dedupe still holds).
6. **Parse.** PDF: `pdftotext -layout /dev/fd/3 -` with the already-open
   descriptor as fd 3 (no path on argv, no re-open by name, 30 s timeout), then
   `parseBoaStatement`; a statement that does not reconcile is refused, as the
   converter does. Text formats: `parseStatementAtPath`. Zero rows is a failure.
7. **Decide inside `updateLedgerDb`** (pure `applyImport`): `mergeImport` with
   the user's rules plus the defaults — the editor's exact merge, so ids and
   dedupe match its own folder sync. Records one row per file read.
8. Bump `ledger-revision` (the bar pill refreshes itself), print a summary, and
   with `--notify` send `notify-send -a Omakei` with counts only.

Failures are recorded with a fixed short reason (`not a statement this can
read`, `rows do not reconcile with the statement's totals`, `no transactions
found`, `unreadable`) — never raw parser text, which can quote amounts — and are
not retried until the file changes. A missing `pdftotext` is not recorded, so
installing poppler fixes it on the next run.

## Data model

Table `importedFiles` (`path`, `sha256`, `size`, `status` = `imported` |
`duplicate` | `failed`, `added`, `reason`, `importedAt`), created like
`subscriptionMarks`: `CREATE TABLE IF NOT EXISTS` inside every write, no schema
version bump. Snapshot key `importedFiles`, present only when non-empty;
absent on a write = leave it alone (the editor and `omakei-categorize.mjs`
never send it). Validated on write: ≤ 5,000 rows, `path` ≤ 1,024 chars,
`sha256` 64 hex, known `status`, `reason` ≤ 120.

## Notice

`12 new transactions, 2 need a category` · `; 1 file could not be read` ·
nothing at all when nothing changed. No merchant, amount, or filename in the
notification (its text is on `notify-send`'s argv). `--status` prints the
records, filenames included, to the user's own terminal.

## Privacy constraints

Writes: the ledger (existing guards), `import.lock`, `ledger-revision` — all
under `<state>/omakei`, 0600 in 0700. Nothing in the statements folder, nothing
in `/tmp`, no network, no dependency. Argv carries flags only; `pdftotext` gets
`/dev/fd/3`. Filenames are printed with control characters stripped.

## Turning it on

Documented in the README; not done by install. Two unit files in
`~/.config/systemd/user/` (`Type=oneshot`, `UMask=0077`,
`NoNewPrivileges=yes`, `ExecStart=<node> <plugin>/scripts/omakei-import.mjs
--notify`; timer `OnBootSec=3min`, `OnUnitActiveSec=15min`), then
`systemctl --user enable --now omakei-import.timer`.

## Test plan

- `src/lib/finance/auto-import.test.ts`: settling, PDF shadowed by CSV,
  unsupported and dot files, sha already recorded, rename/copy of a seen file,
  merge adds and counts uncategorized, second apply adds 0, failed file
  recorded once, notice text, rules applied.
- `scripts/omakei-import.test.mjs` (real files, scratch `HOME` and state):
  CSV in subfolders imported and categorized; second run 0; hostile names
  (newline, `$(…)`, leading `-`, quotes, unicode, 200 chars); garbage CSV and
  fake PDF reported not fatal; symlinked file and folder and FIFO skipped and
  not followed; in-progress file waits; concurrent runs import once; stale lock
  retaken; live lock respected; modes 0600/0700; nothing written into the
  statements folder; a BoA-shaped PDF (generated in the test, no dependency)
  converted and one that does not reconcile refused (when `pdftotext` is
  present).
- `scripts/ledger-db.test.mjs`: `importedFiles` round-trip, absent keeps,
  validation, old ledger gains the table.
