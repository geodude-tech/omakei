# Reading the ledger

This is the contract for interrogating Omakei's ledger from outside the app —
an agent in a terminal, a script, anything that can open a local SQLite file. It is the
first half of the loop `src/panels/README.md` finishes: ask a question here, and
when the answer is worth watching every day, pin it as a panel.

Everything below is stable. The shape is versioned, and the rules are the same
ones the dashboard uses.

## Finding it

Omakei records the attached folder in `$XDG_STATE_HOME/omakei/state.json`,
falling back to `~/.local/state/omakei/state.json`:

```json
{ "version": 1, "statementsDir": "/path/to/statements", "ledgerPath": "/path/to/statements/omakei-ledger.sqlite" }
```

Read `ledgerPath` from there rather than guessing. If the file is missing, no
folder has been attached yet and there is no ledger to read — say so instead of
searching the disk for one.

`ledgerPath` still ending in `omakei-ledger.json` means the editor has not run
since Omakei moved the ledger to SQLite. That JSON is the ledger as it was then;
opening the editor imports it, and from then on it is never written again. A
`omakei-ledger.json` sitting next to `omakei-ledger.sqlite` is that leftover —
do not read it.

## What is in it

`omakei-ledger.sqlite` is an ordinary SQLite database. **Open it read-only**
(`sqlite3 -readonly "$ledgerPath"`); changes go through the tool under
[Writing back](#writing-back-categorize-rules), never through `UPDATE`.

| table or view | holds |
|---|---|
| `transactions` | every transaction, one row each |
| `spend` | view: the transactions that are spending — rules 1 and 3 already applied |
| `income` | view: the transactions that are income — rule 1 already applied |
| `uncategorized` | view: the transactions no rule categorized |
| `categories` | each category's `id`, `name`, and `"group"` |
| `rules` | the user's own categorize rules |
| `setAsides` | monthly reserves |
| `meta` | `key`/`value` pairs: `savedAt`, `selectedMonth`, `revision`, `schemaVersion` |

Columns carry the same names as the fields below. `seq` on each table is
insertion order; ignore it otherwise. The editor, the bar widget, and
`omakei-read-ledger.mjs` all see the ledger in this shape:

```ts
{
  version: 1,
  savedAt: string,          // ISO timestamp of the last save
  selectedMonth: string,    // "YYYY-MM", the month the user last had open
  transactions: Transaction[],
  rules: CategorizeRule[],  // only the user's own; the defaults ship in the build
  setAsides: SetAside[],
}

Transaction {
  id: string;
  date: string;             // "YYYY-MM-DD"
  description: string;      // as it appeared on the statement
  amount: number;           // negative = money out, positive = money in
  accountName: string;
  accountKind: "checking" | "savings" | "credit" | "mortgage" | "other";
  sourceFile: string;
  fingerprint: string;      // dedupe key across re-imports
  categoryId: string | null;// null means nothing categorized it
  importedAt: number;
  pinnedCategoryId?: string;// set by hand for this one transaction; see below
}

SetAside { id: string; name: string; amount: number }
```

One flat table. No per-month grouping — filter on `date LIKE '2026-08%'`
(or `date.slice(0, 7)` in the snapshot) for a month.

## The five rules

Getting these wrong produces answers that look plausible and are not. They are
the whole reason this file exists.

### 1. Transfers are not spending

`categoryId === "transfers"` marks money moving between the user's own accounts:
a credit-card payment, a savings sweep. Both sides are in the ledger, so counting
them inflates spending **and** income.

```js
const isSpend  = (t) => t.amount < 0 && t.categoryId !== "transfers";
const isIncome = (t) => t.amount > 0 && t.categoryId !== "transfers";
```

In SQL, the `spend` and `income` views already apply this:

```sql
SELECT -sum(amount) FROM spend  WHERE date LIKE '2026-08%';
SELECT  sum(amount) FROM income WHERE date LIKE '2026-08%';
```

Filter `transactions` yourself and you are back to the JS above:
`categoryId IS NOT 'transfers'` — `IS NOT`, not `!=`, which silently drops
every uncategorized row (rule 3).

This is the error that hides. Transfers cancel out in `income - spend`, so a net
figure computed without this rule looks about right while the spend and income it
came from are badly wrong. On an eight-month synthetic ledger, summing every
negative amount overstated monthly spending by **63–85%**, entirely from
credit-card payments, while net was off only by the set-aside total.

### 2. Category names are not on the transactions

`categoryId` is an id. The names are in the `categories` table, written by the
build that last saved the ledger — join on it rather than printing ids:

```sql
SELECT c.name, -sum(s.amount) AS spent
FROM spend s LEFT JOIN categories c ON c.id = s.categoryId
WHERE s.date LIKE '2026-08%'
GROUP BY s.categoryId ORDER BY spent DESC;
```

`LEFT JOIN`, so uncategorized spending comes back as a `NULL` name instead of
vanishing (rule 3). The same names, for reading without the database:

| id | name | group |
|---|---|---|
| `housing` | Housing | living |
| `utilities` | Utilities | living |
| `insurance` | Insurance | living |
| `groceries` | Groceries | living |
| `transport` | Transport | living |
| `health` | Health | living |
| `childcare` | Child care | living |
| `pets` | Pets | living |
| `dining` | Dining | lifestyle |
| `coffee` | Coffee | lifestyle |
| `shopping` | Shopping | lifestyle |
| `personal-care` | Personal care | lifestyle |
| `entertainment` | Entertainment | lifestyle |
| `subscriptions` | Subscriptions | lifestyle |
| `travel` | Travel | lifestyle |
| `income` | Income | income |
| `transfers` | Transfers | money |
| `fees` | Fees & interest | money |
| `debt` | Debt | money |
| `other` | Other | money |

The source of truth is `CATEGORIES` in `src/lib/finance/categories.ts`, and
`npm test` fails if this table or the `categories` table drifts from it. Say
"Dining", not "dining".

### 3. `null` is uncategorized, and it counts

`categoryId: null` means no rule matched — not that the transaction is
uninteresting. It is real money and belongs in spend totals. The dashboard folds
it into **Other** when grouping by category, and counts it separately so the user
can see how much is unclassified. A question about "how much did I spend" must
include it; a question about "which category" should not silently drop it.

The `spend` view includes these rows, and `uncategorized` lists them on their
own. Two SQL habits drop them without saying so: `categoryId != 'transfers'`
(NULL is neither equal nor unequal, so the row is filtered out) and an inner
`JOIN categories`.

### 4. Set-asides are monthly reserves, not balances

`setAsides` are amounts the user withholds from this month's net every month —
`$500` for taxes, not a savings account with `$500` in it. They apply to every
month equally, and there is no history of them.

```js
const cashflow = income - spend;
const net      = cashflow - setAsides.reduce((a, s) => a + s.amount, 0);
```

Report `cashflow` when asked what was earned and spent; report `net` when asked
what is actually left.

### 5. `rules` is not the categorizer

The ledger stores only rules the user added by hand. The defaults live in the
build, so replaying `rules` against `description` will not reproduce the
categories already on the transactions. Trust `categoryId`; treat `rules` as a
record of the user's manual overrides.

The other kind of manual override is a **pin**: `pinnedCategoryId` on a single
transaction, which wins over every rule and keeps the row out of transfer
pairing. Pins exist for checks, and for them alone in practice: see below.

## A worked month

Against a synthetic eight-month ledger (236 transactions, one credit-card
payment and one savings sweep per month), for `2026-08`:

| | naive read | correct read |
|---|---|---|
| spend | 5838.35 | **3580.51** |
| income | 10678.94 | **8421.10** |
| net | 4840.59 | **4190.59** |

The naive column applies none of the rules above. The net is close enough to pass
a sanity check; the two figures it is derived from are not.

The correct column, from the database:

```sql
SELECT
  (SELECT  sum(amount) FROM income WHERE date LIKE '2026-08%') AS income,
  (SELECT -sum(amount) FROM spend  WHERE date LIKE '2026-08%') AS spend,
  (SELECT  sum(amount) FROM income WHERE date LIKE '2026-08%')
    + (SELECT sum(amount) FROM spend WHERE date LIKE '2026-08%')
    - (SELECT coalesce(sum(amount), 0) FROM setAsides)         AS net;
```

## Writing back: categorize rules

Everything above is about reading. One thing is safe to write from outside the
app — the user's categorize rules — and there is a tool for it:

```
scripts/omakei-categorize.mjs <pattern> <category-id>   add or update a rule
scripts/omakei-categorize.mjs --remove <pattern>        drop a rule
scripts/omakei-categorize.mjs --list                    merchants with no category yet
scripts/omakei-categorize.mjs --list --json             the same list, as JSON
scripts/omakei-categorize.mjs --dry-run <pattern> <id>  show the effect, write nothing
scripts/omakei-categorize.mjs --pin <tx-id> <category>  categorize one transaction by hand
```

A `<pattern>` is a key identifier (`safeway`), not the whole bank line, matched
the way the app matches — case-insensitive, town and store number ignored. Wrap
it in `/slashes/` for a regex. `<category-id>` is one of the ids in the table
above.

```jsonc
// a CategorizeRule, as it sits in `rules[]` (and as a row of the `rules` table)
{ "id": "…", "pattern": "safeway", "categoryId": "groceries", "createdAt": 1724800000000, "source": "user" }
```

The tool does three things: writes the rule (only `source: "user"` rules
persist — the defaults ship in the build), re-derives every transaction's
`categoryId` with the same engine the app uses, and bumps the revision file the
bar watches. That last step is why the popup updates without opening the editor.

### Checks are never a rule

A paper check's bank line is just `CHECK` (or `CHECK 1042`), so one key covers
a contractor, a school fundraiser, and a birthday present. A rule on it would give every
future check the last one's category. So:

- `omakei-categorize.mjs CHECK childcare` writes **no rule**. It pins the checks
  that have no category yet, and next month's check arrives uncategorized.
- When the outstanding checks paid different people, pin each by its `id`:
  `omakei-categorize.mjs --pin <id> <category>`.
- A `check` rule cannot get into the ledger by another route either: the
  `rules` table refuses a pattern of `check` or `chk`, and the engine refuses to
  apply any rule, `/.*/` included, to a bare check, so the next re-derive puts
  those rows back to `null` (or their pin).

**Do not write to the database yourself** — not a `categoryId`, not a rule, not
a pin. The app re-derives every category on every load and every folder sync
(`refreshCategories`), so an `UPDATE` to `categoryId` is overwritten on the next
one; and a row written outside the tool skips the revision bump, so an open
editor can save straight over it. Change categories by changing rules — or, for
one transaction, with `--pin` — through the tool.

**Safe to run with the editor open.** The tool reads, re-categorizes, and
writes inside one SQLite transaction, so nothing can write in between. The open
tab's next save was derived from the version before the rule, so the server
refuses it and the editor merges the rule in; reload the tab to see it sooner.

## Categorizing a whole backlog

`docs/runbooks/categorize-with-an-agent.md` is the procedure built on the tool
above: how to triage the uncategorized list, what to ask the user instead of
guessing, when a rule is the wrong tool, and how to check that nothing was
miscounted afterwards.

## Pinning the answer

When an answer is worth seeing every day, it becomes a panel: one file in
`src/panels/`, one `npm run build`. See `src/panels/README.md`. A panel that
renders a single sentence is a legitimate panel — that is what most of these
questions deserve.
