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
2. **Merchant key.** `subscriptionKey(description)`: if the line holds a web
   domain (`.com`, `.co`, `.net`, `.org`, `.io`, `.tv`, `.app`, or anything
   after `www.`, so a cut-off `WWW.ZORPY.COMPA` counts), the key is the
   domain's name: `ZFX*ZORPFLIXPLUS zorpflix.com/billCA` and `ZORPFLIX` are both
   `zorpflix`. A processor prefix or billing code in front of the domain changes
   from line to line; the domain does not. Otherwise drop dates
   (`10/05`, `2026-10-05`), masked card numbers (`XXXX1234`, `*1234`,
   `CARD 1234`), `#` codes, and reference codes (below), then the existing
   `extractMerchant` (store numbers, phone, city and state, `SQ *`/`PAYPAL *`
   prefixes), then lower-case, squash spaces, and drop a leading `www` and
   trailing `com` / `net` / `org` / `io` (`NETFLIX.COM` and `NETFLIX INC` are
   one key). One key per merchant however its lines vary.
   - **Reference codes.** A processor often puts a new code on every charge:
     `ZORBTIME*4QJ7X2M9P`, then `ZORBTIME*R8T3W6Z1K 800-555-0142 WA`. A token of
     six or more letters and digits, with at least two digits and a digit
     between two letters, is such a code and is dropped. `extractMerchant`
     drops it too, so the "Needs a category" list and category rules no
     longer split on it. A brand with one digit (`ZORP4KIDS`) is kept.
   - **Short links.** A one- or two-letter domain (`b.co`) is a short link
     that names no merchant. The key is the brand in front of it:
     `BLORPIFY *Blorpify Drive b.co/paysupport#CA` is `blorpify`, like
     `Blorpify Drive`. A line with only a code in front (`B9QX771K
     b.co/paysupport#CA`) joins the one brand the other lines with that link
     name. If they name two brands or none, it keys on the link (`b`).
3. **Cadence.** Sort a key's charges by date and take the median gap in days:

   | cadence | median gap | period | at least |
   |---|---|---|---|
   | weekly | 5–9 days | 7 days | 4 charges |
   | monthly | 26–35 days | 1 calendar month | 3 charges |
   | yearly | 350–380 days | 1 calendar year | 2 charges |

   At least 75% of the gaps must fit the band. A gap fits when it is inside the
   band or inside twice the band (52–70 days for monthly), so one missed charge
   does not break a series. A store visited "about monthly" still fails: its
   gaps wander outside both.
4. **Amount.** Fixed if at least 75% of consecutive charges differ by no more
   than 15% (or $2) — so one price rise still reads as fixed. Otherwise
   variable — allowed only for a monthly bill category (`utilities`,
   `insurance`, `housing`, `debt`, `childcare`) with at least 4 charges. An
   electric bill passes; a salon visited about monthly does not. Typical amount = median of the last three
   charges.
5. **Two plans, one merchant.** If a key fails 3–4 as a whole, its charges are
   split into amount bands (a new band when the next amount is more than 25%
   above the band's first) and each band is tried on its own, so a $0.99 and a
   $10.99 plan from one app store are two subscriptions. A band must be one
   price (every charge within 3% or $0.50 of its median), so a busy store's
   receipts cannot line up into a fake plan. When a merchant has more than one
   row, each row's key is `<merchant>|<typical dollars>`, or
   `<merchant>|unknown` for the row of step 6 with no cadence.
6. **Tagged by the user.** A charge in the `subscriptions` category is the
   user saying "this is a subscription", and no rule above may drop it. After
   steps 3–5, the tagged charges of a key that no listed series holds are split
   into amount bands (step 5, without the one-price check), and every band is
   listed with `confidence: "tagged"`. A tagged band needs no minimum count:
   its cadence is the band (table above, not twice it) that holds its latest
   gap, so a second charge at that price one period after the first makes it
   monthly. A band with one charge, or whose latest gap fits no band, has no
   cadence yet. All such charges of one merchant, whatever their prices, are
   one row with `cadence: "unknown"`, so three one-off audiobook credits are
   one row, not three. Variable amounts are allowed. Series found by steps
   3–5 have `confidence: "schedule"`.
7. **Derived fields.** `nextDate` = last date + one period (month-end
   clamped). `monthly` = typical × 52/12 (weekly), × 1 (monthly), / 12 (yearly).
   A row with cadence `unknown` has `nextDate` and `monthly` null, is never
   stopped, and is not in the monthly total: the user said it is a
   subscription, but not yet what it costs a month. `ids` lists the row's
   transactions. No transaction is in two rows.
8. **As of.** The comparison date is the latest transaction date in the ledger,
   capped at `today`. Statements imported three weeks ago must not make
   everything look stopped.

### Flags

Each flag carries a `ref` so dismissing it hides exactly that occurrence and a
later one shows again.

| flag | when | ref |
|---|---|---|
| `price-up` | fixed amount; a step up of at least 5% and $0.50 from a price that held (2+ charges within 0.5% or $0.10 of each other), seen in the last 3 charges | new amount in cents |
| `new` | first charge within 90 days of as-of | first date |
| `stopped` | as-of is more than 1.5 periods + 3 days past the last charge | last date |

A series stopped for more than three periods (weekly 21 days, monthly 3
months, yearly 3 years) is history and is not listed at all, unless it holds a
tagged charge: then it is listed, as stopped, until its last charge is more
than 13 months (396 days) old or three periods, whichever is longer. So every
merchant with a `subscriptions` charge in the last 13 months is in the result,
in `subscriptions` or, if marked "not a subscription", in `hidden`.

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

- Header: "Recurring charges", "≈ $X a month across N" (active rows with a
  cadence only), then "Plus N tagged with no schedule yet, not in the total"
  when there are rows with cadence `unknown`.
- One row per subscription: merchant (the name most of its lines carry),
  `monthly · $12.99` (with "from your Subscriptions tag" for a tagged one), last and next date,
  `≈ $/mo` ("No schedule yet" and "Not in total" for cadence `unknown`), flags as chips ("Up from $10.99", "New", "Seems to have stopped")
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
list. Read-only open, stdout only, `tagged` shown beside the flags of a tagged
series, control characters stripped from merchant
names in the table (bank text could otherwise carry terminal escapes). Rows
with cadence `unknown` are printed under their own heading, "Tagged, no
schedule yet (not in the monthly total)", and counted apart in the summary.

## Test plan

- `src/lib/finance/subscriptions.test.ts`: monthly, yearly, weekly, price hike
  (and its ageing out), a wandering bill never price-flagged, new, stopped,
  long-stopped dropped, noisy merchant names, two plans at one merchant,
  variable bill, a variable salon visit not detected, groceries / coffee /
  irregular shopping not detected, transfers and checks ignored, marks hide and dismiss
  by ref, as-of capped by data; a bank line that changes shape mid-series, a
  billing code that shares a help URL, one missed month, tagged plans with one
  or two charges or no schedule, every tagged merchant in the last 13
  months listed whatever its cadence with each tagged charge in exactly one
  row, per-charge reference codes, a short-link domain shared with a brand,
  a cut-off domain, unscheduled tagged charges kept out of the total and
  promoted by a second charge on schedule, and no transaction in two rows.
- `scripts/ledger-db.test.mjs`: marks round-trip; absent key keeps them; `[]`
  clears; bad kind / long key refused; a ledger created by the previous schema
  (no table) reads as `[]` and gains the table on its first write; the
  database stays 0600.
- `src/lib/finance/merge.test.ts` / ledger-file: marks parsed, editor's kept.
- `scripts/omakei-categorize.test.mjs`: a categorize write keeps marks.
- `scripts/ledger-api.test.mjs`: `PUT` with bad marks → 400; shell injection
  with `$'` in a description stays inert.
- `scripts/omakei-subscriptions.test.mjs`: CLI reads read-only, prints JSON,
  labels a tagged series, lists unscheduled tagged rows apart from the total.

## Tuned on real data

Run against a private copy of the owner's ledger (1,392 rows, 3 years) before
merge. Two rules came from it: a wandering water bill was flagged as a price
rise (now a rise needs a price that held), and a salon visited about monthly
read as a variable bill (now variable amounts need a bill category).

A second run (2026-10) found real subscriptions missing, each one already
filed under `subscriptions` by the user: a streaming plan whose bank line
changed shape for one month, a storage plan billed under a new code, and
several app-store plans with only one or two charges. Three rules came from it:
the domain key, the missed-period gap, and the tagged pass with its 13-month
history.

A third run (2026-10) listed every tagged merchant but got the rows wrong. A
plan billed with a new reference code each month came out as nine one-charge
rows. A storage plan billed through a short link was two active rows, one
keyed on the link and one on the brand, so its cost was counted twice. One-off
tagged charges were assumed monthly and raised the total by about a quarter.
The reference-code rule, the short-link rule, the `www.` rule, and cadence
`unknown` came from it.

## Open Questions

1. **Bar widget.** A "≈ $X/mo recurring · 1 flagged" line in the popup would
   need `omakei-read-ledger.mjs` to add a field and `Panel.qml` to show it. Left
   out: the QML harness needs quickshell, and this is a glance feature in the
   editor first.
2. **Biweekly and quarterly** cadences are not detected. Add a band row if real
   data shows them. A tagged one is listed anyway, at the pace of its latest
   gap or monthly.
3. **One tagged charge** has cadence `unknown` until a second charge at its
   price comes one period later. A plan that bills every six or seven weeks
   stays `unknown`, and out of the total, until a band for it exists. It stays
   listed until it is 13 months old.
