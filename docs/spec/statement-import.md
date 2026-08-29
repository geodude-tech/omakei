# Spec: Statement Import

_Status: documents existing behavior as of 2026-08-28. Traces to `docs/intent/omakei.md`._

## Objective

Turn a folder of bank, credit, and mortgage exports into one flat, deduplicated,
auto-categorized transaction list — the ledger every other part of Omakei reads.

The intent's loop starts with "statements in a folder → ledger." This spec is that
arrow. `docs/spec/ledger-contract.md` documents how an outside agent _reads_ the
result; this documents how the result is _built_, and the rules that decide what a
transaction's amount, account kind, and category come out as.

**User:** Andrew, and any Omarchy user, dropping exports into a folder. They pick
whatever format their bank offers and never tell Omakei what account a file is
for. The import has to guess well enough that the dashboard is right on the first
sync, and let a wrong guess be corrected once.

**Success:**

- Dropping a folder of OFX/QFX/CSV/TSV/OFC/txt exports — onto the dashboard's
  drop zone in the browser, or into the attached folder for the server to sync —
  produces a ledger whose monthly spend, income, and net match the five rules in
  `docs/ledger.md`.
- Re-syncing the same folder adds nothing and changes nothing.
- Adding next month's export to the folder and syncing adds only that month.
- A merchant categorized once by hand is categorized automatically on the next
  import, without re-touching the transactions already in the ledger.
- Internal transfers (a card payment, a savings sweep) land in `transfers` and are
  therefore excluded from spend and income.

## Tech Stack

TypeScript 5.7, run under `node --experimental-strip-types` in tests. No parser
libraries — the delimited and OFX parsers are hand-written so the ledger server
stays dependency-free (`omarchy plugin add` never runs `npm install`). No new
dependencies.

## Commands

```
Test:      npm test           # parse, statements, fingerprint, transfers, ledger-contract
Typecheck: npm run typecheck
Dev:       npm run dev:isolated   # import against .dev/, never your real ledger
```

## Project Structure

```
src/lib/finance/parse.ts        → format detection, column detection, date/amount parsing, sign normalization
src/lib/finance/statements.ts   → account-kind from folder name; dropped-file vs server-path entry points; container-segment strip; preview merge
src/lib/finance/dropped-entries.ts → flatten a browser drag-and-drop, folders included, into File[] (used by StatementDropzone)
src/lib/finance/categories.ts   → CATEGORIES, the default categorizer patterns, categoryName()
src/lib/finance/fingerprint.ts  → merchant extraction, the dedupe fingerprint, rule matching
src/lib/finance/transfers.ts    → internal-transfer detection and opposite-leg pairing
src/lib/finance/ledger.ts       → assignCategory(), mergeImport(), refreshCategories(), user-rule upsert
src/lib/finance/sync.ts         → read the attached folder, merge, save in one pass
src/lib/finance/store.ts        → importFiles(), categorizeMerchant/One(), unknownMerchants()
```

Tests: `parse.test.ts`, `statements.test.ts`, `fingerprint.test.ts`,
`transfers.test.ts`. Parser fixtures are **inline strings**, never files —
statement extensions are gitignored (AGENTS.md).

## Code Style

The rules are stated as predicates and applied in a fixed order. `assignCategory`
is the whole categorizer contract:

```ts
export function assignCategory(
  description: string,
  rules: CategorizeRule[],
  accountKind?: AccountKind,
  amount?: number,
): string | null {
  const userHit = bestMatchingRule(description, rules, "user");
  if (userHit) return userHit.categoryId;                       // 1. user rules win outright
  if (accountKind && isInternalTransfer(description, accountKind, amount)) {
    return TRANSFER_CATEGORY;                                   // 2. structural transfers
  }
  if (accountKind === "mortgage") {
    const mortgage = mortgageCategory(description);
    if (mortgage) return mortgage;                              // 3. mortgage-specific
  }
  return bestMatchingRule(description, rules, "default")?.categoryId ?? null; // 4. default patterns, else null
}
```

Conventions the code already holds to:

- **`null` is a real outcome.** No rule matched; the transaction is uncategorized
  and still counts as spend. Never coerce it to `other` at import time.
- **Longest identifier wins.** `bestMatchingRule` ranks matches by
  `identifierLength(pattern)`, then by `createdAt`. `safeway fuel` (transport)
  beats `safeway` (groceries).
- **A folder name outranks the file's own headers.** `kindFromLocalPath` checks
  the top path segment (`Mortgage/`, `Credit/`, `Checking/`, `Savings/`) and
  overrides whatever `inferKindFromName` guessed from the filename. For a file
  that arrived inside a **dropped folder**, `droppedStatementPath` first drops
  the one container segment the browser prepends (`Picked/Credit/aug.csv` →
  `Credit/aug.csv`), so the top segment is a category, not the folder the user
  grabbed — the same shape the server hands over for an attached folder.
- **Parsing is total.** A row that cannot yield a date, a description, and an
  amount is skipped, not defaulted. `mapCsvRows` and `parseOfx` both `continue`
  past unusable rows.

## Behavior this spec fixes in place

### Format detection

`parseStatementFile` treats a file as OFX when the name ends `.ofx`/`.qfx` **or**
the text contains `<OFX>` or `<STMTTRN>`. Everything else goes through the
delimited parser, whose delimiter is whichever of `, \t ; |` appears most in the
first line.

### Column detection (delimited)

1. If the first row looks like a header (`rowLooksLikeHeader`), map columns by
   alias tables (`DATE_HEADERS`, `DESC_HEADERS`, `AMOUNT_HEADERS`, `DEBIT_HEADERS`,
   `CREDIT_HEADERS`).
2. For any column not found by header, score the first 24 body rows: the date
   column is the one with the most date-like cells, the amount column the most
   amount-like (excluding the date column), the description column the one with
   the most total text (excluding date/amount/debit/credit).
3. Separate debit/credit columns collapse to a signed amount as
   `credit - abs(debit)`, falling back to a single amount column when both are
   blank.
4. Rows whose description contains a `SKIP_ROW_HINTS` phrase (`beginning
   balance`, `ending balance`, `total`, …) are dropped.

### Date parsing

`parseDate` accepts ISO (`YYYY-MM-DD…`), OFX stamps (`YYYYMMDD` with an optional
`[-7:MST]` zone suffix that is stripped first), US `M/D/YY(YY)` and `M-D-YY(YY)`
(2-digit year: `< 70` → 2000s, else 1900s), and named months via `Date.parse`.
Anything else is `null` and the row is dropped.

### Amount parsing

`parseAmount` strips `$`, spaces, and thousands commas; treats `(123.45)` and a
trailing `-` as negative; normalizes en/em dashes to `-`; rejects `n/a` and bare
`-`.

### Sign normalization by account kind

`applyKindSign` runs last:

- **Credit**, when positives outnumber negatives 2:1 (a card export that lists
  charges as positive): flip every row to negative except descriptions matching
  `payment|thank you|pmt received|online pmt`, which become positive.
- **Mortgage**, when positives outnumber negatives: flip every row to negative.

### Deduplication

The fingerprint is `` `${date}|${cents}|${normalizeDescription(description)}` ``,
where `normalizeDescription` lowercases, collapses non-alphanumerics to single
spaces, and truncates to 56 chars. `mergeImport` counts fingerprints already in
the ledger and takes only `max(0, incomingCount - haveCount)` of each — so a
statement that legitimately repeats a charge twice keeps both, but re-importing
the same file adds nothing.

### Browser folder drop

The dashboard's drop zone (`StatementDropzone`) takes files the browser hands
over directly. `DataTransfer.files` does not descend into a dropped directory, so
`collectEntryFiles` (`dropped-entries.ts`) walks the entries API —
`webkitGetAsEntry()`, then `createReader().readEntries()` drained in a loop
(~100 children per call) — into a flat `File[]`, each tagged with its
drop-relative path. Those go through `parseDroppedFiles` → `importFiles`, the
same merge as a sync, so a browser folder drop and a server sync of the same
files produce the same ledger. The empty-state path skips the per-file preview;
`inferKindFromName` / the folder-name strip carry the account kind.

On a **fresh run with no folder attached**, the drop has nowhere to persist, so
the parsed statements are held and the `FolderPicker` opens; the import runs into
the folder the user picks. See `docs/spec/dashboard-app.md`, "The empty state".

### Merge is one pass

`sync.ts` reads every statement in the folder, parses all of them, and calls
`importFiles` once. `mergeImport` sorts the combined list newest-first, then runs
`refreshCategories` over the whole ledger (which re-derives categories from rules
and re-pairs transfers, fixing stale transfer tags from earlier imports). One
unreadable file is skipped, not fatal.

### Internal-transfer pairing

`applyTransferCategories` tags structurally-obvious transfers, then
`pairInternalTransfers` and `pairSameBankMoves` match opposite legs by equal
cents within 3–5 days across different accounts, marking both `transfers` (a
mortgage-payment destination becomes `housing` instead). User rules on either leg
veto the pairing.

## Testing Strategy

- `parse.test.ts` — one inline-string fixture per format quirk (OFX zone suffix,
  parenthesized negatives, debit/credit split, headerless CSV, skip rows).
- `fingerprint.test.ts` — merchant extraction and `ruleMatches` (town/store-id
  insensitivity, `/regex/` literals, compact-span matches like `WAL-MART`).
- `transfers.test.ts` — the pairing cases, plus "payroll is never a transfer".
- `statements.test.ts` — `kindFromLocalPath` precedence, preview de-duplication,
  `droppedStatementPath` container strip.
- `dropped-entries.test.ts` — `collectEntryFiles` flattens a fake entry tree,
  keeps a loose file's bare name, and drains a directory reader across batches.
- `ledger-contract.test.ts` — guards the `CATEGORIES` table against
  `docs/ledger.md` (see the ledger-contract spec).

New parser behavior needs a fixture that fails first. A new default categorizer
pattern needs a `transfers.test.ts` or `fingerprint.test.ts` case if it is not
obvious.

## Boundaries

**Always:**
- Keep parsing total: skip an unusable row, never invent a date or a zero amount.
- Keep the fingerprint stable. Changing `normalizeDescription` re-keys every
  ledger and turns the next sync into a mass re-import.
- Keep fixtures as inline strings using national-chain merchant names.

**Ask first:**
- Adding a dependency to parse a format (OFX/QFX especially). The
  dependency-free constraint is load-bearing for plugin distribution.
- Changing `applyKindSign`'s heuristics — they silently move money between spend
  and income.
- Adding a category to `CATEGORIES` (also updates `docs/ledger.md` and
  `Model.js`'s `CATEGORY_NAMES`; the contract test enforces the first).

**Never:**
- Put a household merchant, account name, or balance in a default pattern or a
  fixture (AGENTS.md).
- Replay `rules` against `description` to "reproduce" categories — defaults ship
  in the build, so the replay is incomplete by construction (ledger rule 5).
- Persist default rules into `omakei-ledger.json`. `snapshotFromState` filters to
  `source === "user"` on the way out.

## Success Criteria

Verified against the current suite (2026-08-28): 82 tests pass, including all of
`parse`, `statements`, `dropped-entries`, `fingerprint`, `transfers`, and
`ledger-contract`.

1. **Met.** OFX, headerless CSV, debit/credit-split CSV, and parenthesized-negative
   fixtures all parse to the expected rows in `parse.test.ts`.
2. **Met.** `mergeImport` with `existing` equal to a prior import's output adds 0
   and skips all (`ledger.ts` fingerprint accounting; exercised indirectly).
3. **Met.** `kindFromLocalPath("Mortgage/aug.csv", "checking")` returns
   `"mortgage"` (`statements.test.ts`).
4. **Met.** `assignCategory` returns a user rule's category ahead of any default,
   ranked by identifier length (`transfers.test.ts`:
   "longer identifier beats a shorter one").
5. **Met.** Card payments and savings sweeps resolve to `transfers`
   (`transfers.test.ts`).

## Open Questions

1. **`applyKindSign` on ambiguous credit exports.** The 2:1 positive/negative
   ratio is a heuristic. A credit statement for a month of mostly refunds could
   trip it the wrong way. No fixture covers the boundary. Worth a threshold that
   is explained, or a per-file override in the import sheet.
2. **`inferKindFromName` carries brand names.** `chase`, `wells`, `bofa`,
   `amex`, `sapphire`, `rocket` etc. are in the filename heuristic. These are
   public brands, not personal data, but the list will rot and a user whose bank
   is not on it silently gets `other`. Consider driving kind entirely from the
   folder name and dropping the filename brand list.
3. **Transfer pairing windows (3 and 5 days) are unexplained constants.** They
   are not in any doc and not independently tuned. Record the reasoning or make
   them named options like `drift.ts` did.
4. **`id` collision surface.** `mergeImport` builds `id` as
   `` `${filename}:${fp}:${index}` ``. Renaming a source file re-imports every
   row under new ids. Acceptable today (ids are not referenced across syncs) but
   undocumented.
