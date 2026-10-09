# Spec: Subscription & Bill Finder

_Status: forward spec, then built (2026-10-08, branch `feat/subscription-finder`).
Traces to `docs/intent/omakei.md`; the privacy rules in
[data-privacy-guards.md](data-privacy-guards.md) and
[ledger-server.md](ledger-server.md) take precedence._

## Objective

Find the charges that repeat — streaming, phone, gym, insurance, the yearly
domain renewal — from transactions already in the ledger, on this machine, and
say three things about them that a list of transactions never does: what they
cost a month all together, which went up, and which are new or seem to have
stopped.

**Not in scope:** cancelling anything, reminders or notifications, a network
lookup of merchant names, ML, income detection, a bar-widget line (see Open
Questions).

**Success:**

- `findSubscriptions(transactions, options)` is pure: same input, same output,
  no clock, no I/O. Every rule below has a unit test.
- The editor shows a "Recurring charges" card with merchant, cadence, typical
  amount, last and next date, monthly cost, and flags.
- "Not a subscription" and "dismiss this flag" persist in the ledger and
  survive a reload, a conflict merge, and a write by `omakei-categorize.mjs`.
- An existing ledger opens and saves with no migration step and no version bump.

## Detection

Pure function in `src/lib/finance/subscriptions.ts`.

1. **Candidates.** Money out (`amount < 0`) that is not a transfer, not a
   check (`isGenericMerchant`), not ATM cash, and not in a category that is
   everyday buying rather than a bill: `groceries`, `dining`, `coffee`.
2. **Merchant key.** `subscriptionKey(description)`: drop dates
   (`10/05`, `2026-10-05`), masked card numbers (`XXXX1234`, `*1234`,
   `CARD 1234`), and `#` codes, then the existing `extractMerchant`
   (store numbers, phone, city and state, `SQ *`/`PAYPAL *` prefixes), then
   lower-case, squash spaces, and drop a leading `www` and trailing `com` /
   `net` / `org` / `io` (`NETFLIX.COM` and `NETFLIX INC` are one key). One key per merchant however its lines vary.
3. **Cadence.** Sort a key's charges by date and take the median gap in days:

   | cadence | median gap | period | at least |
   |---|---|---|---|
   | weekly | 5–9 days | 7 days | 4 charges |
   | monthly | 26–35 days | 1 calendar month | 3 charges |
   | yearly | 350–380 days | 1 calendar year | 2 charges |

   At least 75% of the gaps must sit inside the band (one missed or doubled
   month in eight passes; a store visited "about monthly" does not).
4. **Amount.** Fixed if at least 75% of consecutive charges differ by no more
   than 15% (or $2) — so one price rise still reads as fixed. Otherwise
   variable — allowed only for monthly with at least 4 charges (an electric
   bill), never weekly or yearly. Typical amount = median of the last three
   charges.
5. **Two plans, one merchant.** If a key fails 3–4 as a whole, its charges are
   split into amount bands (a new band when the next amount is more than 25%
   above the band's first) and each band is tried on its own, so a $0.99 and a
   $10.99 plan from one app store are two subscriptions. A band must be one
   price (every charge within 3% or $0.50 of its median), so a busy store's
   receipts cannot line up into a fake plan. The band key is
   `<merchant>|<typical dollars>`.
6. **Derived fields.** `nextDate` = last date + one period (month-end
   clamped). `monthly` = typical × 52/12 (weekly), × 1 (monthly), / 12 (yearly).
7. **As of.** The comparison date is the latest transaction date in the ledger,
   capped at `today`. Statements imported three weeks ago must not make
   everything look stopped.

### Flags

Each flag carries a `ref` so dismissing it hides exactly that occurrence and a
later one shows again.

| flag | when | ref |
|---|---|---|
| `price-up` | fixed amount; the last charge is at least 5% and $0.50 above the median of the up-to-six before it | last amount in cents |
| `new` | first charge within 90 days of as-of | first date |
| `stopped` | as-of is more than 1.5 periods + 3 days past the last charge | last date |

A series stopped for more than three periods (weekly 21 days, monthly 3
months, yearly 3 years) is history and is not listed at all.

## Data model

A new table, created in every write transaction with `CREATE TABLE IF NOT
EXISTS` — additive, so no `schemaVersion` bump, and older Omakei code that
reads or writes the same file neither refuses it nor deletes the rows (it only
replaces the tables it knows).

```sql
CREATE TABLE IF NOT EXISTS subscriptionMarks (
  seq       INTEGER PRIMARY KEY,
  key       TEXT NOT NULL,   -- subscriptionKey (or band key)
  kind      TEXT NOT NULL,   -- 'not-subscription' | 'price-up' | 'new' | 'stopped'
  ref       TEXT NOT NULL,   -- '' for not-subscription, else the flag's ref
  createdAt INTEGER
);
```

Snapshot gains `subscriptionMarks: SubscriptionMark[]`. Rules:

- **Absent key = leave the table alone.** `omakei-categorize.mjs` and any
  older writer send no marks and must not wipe them. `[]` clears them.
- **Validated on write** (`LedgerShapeError` → 400): known `kind`, string
  `key` ≤ 200 chars, string `ref` ≤ 40 chars, at most 5,000 marks.
- **Reading a ledger with no table** returns `[]` (read-only opens cannot
  create it).
- **Merge:** the editor's side wins, as for set-asides — only the editor
  writes marks.

## UI

`src/components/omakei/subscriptions.tsx`, a core card (not a `src/panels/`
panel: panels are read-only and this card writes marks). Placed under the panel
grid; hidden when nothing is found.

- Header: "Recurring charges", "≈ $X a month across N" (active ones only).
- One row per subscription: merchant, `monthly · $12.99`, last and next date,
  `≈ $/mo`, flags as chips ("Up from $10.99", "New", "Seems to have stopped")
  each with a dismiss button, and a "Not a subscription" button.
- "N hidden" toggles a list of hidden ones, each with "Restore".
- Merchant text is rendered as React text only — never `innerHTML`.

## Privacy constraints

No new route, file, process, or dependency: marks ride the existing
`PUT /ledger` into the existing 0700 ledger dir and 0600 database. Detection
runs in the browser and in a read-only CLI (`scripts/omakei-subscriptions.mjs`,
stdout only, argv carries at most a ledger path). No network, no `/tmp`, no
merchant or amount in argv or env. Merchant strings reach the page through
`window.__OMAKEI_STATE`, so the shell injection must treat them as data
(fixed here: `String.replace` expanded `$'` and `` $` `` in the payload).

## Terminal

`node scripts/omakei-subscriptions.mjs [--json] [ledger-path]` prints the same
list. Read-only open, stdout only, control characters stripped from merchant
names in the table (bank text could otherwise carry terminal escapes).

## Test plan

- `src/lib/finance/subscriptions.test.ts`: monthly, yearly, weekly, price hike
  (and its ageing out), new, stopped, long-stopped dropped, noisy merchant
  names, two plans at one merchant, variable bill, groceries / dining / irregular
  shopping not detected, transfers and checks ignored, marks hide and dismiss
  by ref, as-of capped by data.
- `scripts/ledger-db.test.mjs`: marks round-trip; absent key keeps them; `[]`
  clears; bad kind / long key refused; a ledger created by the previous schema
  (no table) reads as `[]` and gains the table on its first write; the
  database stays 0600.
- `src/lib/finance/merge.test.ts` / ledger-file: marks parsed, editor's kept.
- `scripts/omakei-categorize.test.mjs`: a categorize write keeps marks.
- `scripts/ledger-api.test.mjs`: `PUT` with bad marks → 400; shell injection
  with `$'` in a description stays inert.
- `scripts/omakei-subscriptions.test.mjs`: CLI reads read-only, prints JSON.

## Open Questions

1. **Bar widget.** A "≈ $X/mo recurring · 1 flagged" line in the popup would
   need `omakei-read-ledger.mjs` to add a field and `Panel.qml` to show it. Left
   out: the QML harness needs quickshell, and this is a glance feature in the
   editor first.
2. **Biweekly and quarterly** cadences are not detected. Add a band row if real
   data shows them.
