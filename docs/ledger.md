# Reading the ledger

This is the contract for interrogating Omakei's ledger from outside the app —
an agent in a terminal, a script, anything that can read a local file. It is the
first half of the loop `src/panels/README.md` finishes: ask a question here, and
when the answer is worth watching every day, pin it as a panel.

Everything below is stable. The shape is versioned, and the rules are the same
ones the dashboard uses.

## Finding it

Omakei records the attached folder in `$XDG_STATE_HOME/omakei/state.json`,
falling back to `~/.local/state/omakei/state.json`:

```json
{ "version": 1, "statementsDir": "/path/to/statements", "ledgerPath": "/path/to/statements/omakei-ledger.json" }
```

Read `ledgerPath` from there rather than guessing. If the file is missing, no
folder has been attached yet and there is no ledger to read — say so instead of
searching the disk for one.

## What is in it

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
}

SetAside { id: string; name: string; amount: number }
```

One flat array. No nesting, no per-month grouping — filter on
`date.slice(0, 7)` for a month.

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

This is the error that hides. Transfers cancel out in `income - spend`, so a net
figure computed without this rule looks about right while the spend and income it
came from are badly wrong. On an eight-month synthetic ledger, summing every
negative amount overstated monthly spending by **63–85%**, entirely from
credit-card payments, while net was off only by the set-aside total.

### 2. Category names are not in the file

`categoryId` is an id. The names ship in the build, not the ledger:

| id | name | group |
|---|---|---|
| `housing` | Housing | living |
| `utilities` | Utilities | living |
| `groceries` | Groceries | living |
| `transport` | Transport | living |
| `health` | Health | living |
| `childcare` | Child care | living |
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
| `other` | Other | money |

The source of truth is `CATEGORIES` in `src/lib/finance/categories.ts`, and
`npm test` fails if this table drifts from it. Say "Dining", not "dining".

### 3. `null` is uncategorized, and it counts

`categoryId: null` means no rule matched — not that the transaction is
uninteresting. It is real money and belongs in spend totals. The dashboard folds
it into **Other** when grouping by category, and counts it separately so the user
can see how much is unclassified. A question about "how much did I spend" must
include it; a question about "which category" should not silently drop it.

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

## Pinning the answer

When an answer is worth seeing every day, it becomes a panel: one file in
`src/panels/`, one `npm run build`. See `src/panels/README.md`. A panel that
renders a single sentence is a legitimate panel — that is what most of these
questions deserve.
