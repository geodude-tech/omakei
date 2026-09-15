# Runbook: categorizing the ledger with an agent

For an agent in a terminal clearing the "Needs a category" list — after a
folder sync, once a month, or the first time a year of statements lands. Read
`docs/ledger.md` first; this runbook assumes its five rules.

Every example merchant here is invented. Keep it that way: see
[Never](#never).

## The strategy

Six ideas decide every step below.

1. **Categories come from rules and pins, never from editing `categoryId`.**
   All writes go through `scripts/omakei-categorize.mjs`. It re-derives with the
   shipped engine, survives an open editor, and does not care whether the ledger
   is stored as JSON or SQLite. A hand-edited category is undone on the next
   load.
2. **Money first, not count.** `--list` is sorted by absolute total. Three
   merchants usually hold most of the uncategorized money; a long tail of
   one-off coffee shops does not move a verdict.
3. **The agent proposes; the person decides what only they can know.** A
   merchant's name tells you what a grocery chain is. It cannot tell you what a
   check paid for or who an abbreviation is. Split every merchant into *certain*,
   *likely*, and *unknowable*, and ask about the last two — once, in a batch.
4. **A rule is a bet on every future transaction with that key.** Write one only
   when the key names the payee *and* that payee always means the same category.
   Otherwise pin the rows you know and let the next one ask.
5. **Leave it `null` rather than guess.** An uncategorized row still counts as
   spend and stays in front of the user. A wrong category hides silently and
   bends every panel that reads it. `other` is a deliberate answer ("this is
   genuinely miscellaneous"), not a place to put doubt.
6. **Transfers are the category that can lie loudest.** Marking something
   `transfers` removes it from spend *and* income. And a user rule beats the
   engine's own transfer detection, so an over-broad rule can turn a credit-card
   payment back into spending. Both directions get a dry run and a total check.

## Procedure

### 0. Preflight

- Find the ledger through the state file, as `docs/ledger.md` says. If there is
  no state file, stop: nothing is attached.

```sh
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/omakei/state.json"
LEDGER=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ledgerPath' "$STATE")
```

  `$LEDGER` is `omakei-ledger.sqlite`.

- Back the ledger up somewhere **outside** the statements folder and outside
  this repository. `.backup` is safe while the server is running, unlike `cp`:

```sh
sqlite3 -readonly "$LEDGER" ".backup '$HOME/.local/state/omakei/omakei-ledger.backup-$(date +%F).sqlite'"
```

- The editor may stay open. If you plan to restore a backup later, close it
  first.
- Record the spend total for every month, before anything changes (step 7
  compares against it). Spend follows rule 1 of `docs/ledger.md`:

```sh
spend_by_month() {
  # The `spend` view is rule 1 (and 3) already applied.
  sqlite3 -readonly -separator ' ' "$LEDGER" \
    "SELECT substr(date, 1, 7), printf('%.2f', -sum(amount)) FROM spend GROUP BY 1 ORDER BY 1"
}
spend_by_month > /tmp/omakei-spend-before.txt
```

### 1. Survey

```sh
scripts/omakei-categorize.mjs --list --json     # [{ merchant, count, total }]
```

The merchant key alone is often not enough to decide. Pull the rows behind the
ones you are unsure of — dates, amounts, accounts — from the ledger:

```sh
sqlite3 -readonly "$LEDGER" \
  "SELECT id, date, amount, accountKind, description FROM uncategorized ORDER BY date"
```

A regular amount on a regular day is a bill. The same amount in and out of two
accounts within a few days is a transfer. A card-account row is rarely a check.

### 2. Triage

Give each merchant exactly one action.

| What the key is | Action |
|---|---|
| Names the payee, and the payee means one category (a grocery chain, a streaming service, a utility) | **Rule** |
| Names the payee, but purchases there vary (marketplaces, big-box and warehouse stores) | **Ask** whether one category is good enough. If yes, rule to the dominant one; if not, pin the rows individually and write no rule |
| A bare payment method: `CHECK`, `CHECK 1042` | **Pin**, after asking what each paid. The engine refuses any rule on these |
| A person-to-person rail with the payee in the line (`ZELLE TO <name>`) | **Rule on the payee's key** if it recurs and always means one thing; otherwise ask and pin |
| A person-to-person rail with no payee | **Ask** and **pin**. Do not write a rule on the rail's name — it is as generic as a check, but only checks are enforced |
| Cryptic (processor prefixes, truncated abbreviations) | **Ask**, with the date, amount, and account |
| Looks like money moving between the user's own accounts | **Ask** before `transfers`, and name the matching leg you found on the other account. No matching leg usually means it is not a transfer |
| A positive amount at a shop | A refund. Same category as the shop's purchases, never `income`. The shop's rule already covers it |
| Nobody knows, and the user does not remember | **Leave** it `null` |

### 3. Ask once

Send the user one message, not a question per merchant. Two parts:

- **Proposals** — the rules and pins you are confident in, as a table they can
  approve or correct at a glance:

  | Merchant | Rows | Total | Action | Why |
  |---|---|---|---|---|
  | ZORP WIDGETS | 3 | −$84.10 | rule → `shopping` | hardware retailer, every visit |
  | CHECK | 2 | −$400.00 | pin → ? | what did these pay for? |

- **Questions** — each unknowable merchant with the context from step 1 (dates,
  amounts, account), so the user can answer from memory.

Apply nothing until they answer. Use the ids from the category table in
`docs/ledger.md`; the taxonomy is fixed, so do not propose new categories.

### 4. Choose patterns

- Start from the key `--list` printed. It is the same key the rules match on.
- Keys are matched case-insensitively with town and store number ignored, so
  `zorp widgets` already covers every branch. Do not paste the whole bank line.
- Avoid short or common words (`pay`, `online`, `store`, `market`): they match
  far more than the merchant you meant.
- Reach for `/regex/` only when no key separates two merchants.
- **Dry-run every rule:**

```sh
scripts/omakei-categorize.mjs --dry-run "zorp widgets" shopping
# Rule "zorp widgets" → shopping
# 3 transactions re-tagged, 12 still uncategorized
```

The re-tagged count should equal that merchant's row count from `--list`. If it
is higher, the pattern is also changing rows that already had a category —
perhaps overriding a default or a detected transfer. Find out which before you
apply, or pick a narrower pattern.

### 5. Apply

```sh
scripts/omakei-categorize.mjs "zorp widgets" shopping
```

One command per rule. Each re-derives the whole ledger, writes it, and bumps the
revision file so the bar updates. If it reports that the ledger kept changing,
something is writing continuously — close the editor tab and run it again.

### 6. Pin what rules cannot cover

When every uncategorized check paid for the same thing:

```sh
scripts/omakei-categorize.mjs CHECK childcare     # pins only the uncategorized checks
```

When they paid for different things, pin each by the `id` from step 1:

```sh
scripts/omakei-categorize.mjs --pin '<transaction id>' childcare
```

A pin wins over every rule, survives every sync, and keeps the row out of
transfer pairing. Next month's check still arrives uncategorized; that is
intended.

### 7. Verify

- `scripts/omakei-categorize.mjs --list` should show only what you chose to
  leave.
- **Spend should not move.** Categorizing changes *which* category money is in,
  not how much was spent — except for rows moved into or out of `transfers`. Run
  the step 0 snippet again and compare:

```sh
diff /tmp/omakei-spend-before.txt <(spend_by_month) && echo "spend unchanged"
```

  A month whose spend changed when you made no `transfers` decision means a rule
  overrode a detected transfer. Remove it (`--remove`) and look again.
- For the latest month, compare each category against the months before it. A
  category that jumped this session is where an over-broad rule landed.

### 8. Report back

Tell the user, briefly: rules added (pattern → category), rows pinned, what was
left uncategorized and why, and anything that looked wrong but was not yours to
change — a transfer that seemed mispaired, a duplicate-looking row.

## Undoing

| Mistake | Fix |
|---|---|
| A wrong rule | `scripts/omakei-categorize.mjs --remove "<pattern>"` — its rows return to whatever else matches, or `null` |
| A wrong pin | `--pin '<id>' <correct category>`. There is no unpin command yet |
| The whole session | Close the editor tab, then `sqlite3 "$LEDGER" ".restore '<the step 0 backup>'"` |

## Every month, after a sync

1. `--list`. Usually only new merchants and the month's checks.
2. Triage and ask (steps 2–3), apply (5–6), verify (7).
3. If the same merchant was asked about two months running and got the same
   answer, propose a rule for it.

## Never

- **Edit `categoryId` by hand**, in JSON or in SQLite. It does not stick.
- **Add the user's merchants to `DEFAULT_PATTERNS`** in
  `src/lib/finance/categories.ts`. Those ship to everyone who installs the
  plugin. The user's own rules belong in their ledger, which is exactly where
  the CLI writes them.
- **Copy anything from the ledger into this repository** — merchant names,
  amounts, account names or numbers, payees, towns — including in commit
  messages, PR descriptions, issues, test fixtures, and this runbook. Use
  invented names like `ZORP WIDGETS`. `scripts/check-no-personal-data.mjs`
  catches shapes (card numbers, addresses) and the terms listed in the
  gitignored `.githooks/personal-terms`; it cannot recognise a merchant as
  someone's, so the rule is yours to keep.
- **Commit a ledger, a statement, or a backup.** `check-no-statements.mjs`
  blocks the known filenames, not a renamed copy.
- **Write a rule for a check or a bare payment rail**, or invent a category id.
