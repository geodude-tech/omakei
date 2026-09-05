# Spec: Ledger Contract

_Status: implemented 2026-08-27. Traces to `docs/intent/omakei.md`._

## Objective

Give an agent outside the app a way to query the ledger and get the same answers
the dashboard would give.

`docs/spec/panel-contract.md` closed the back half of the loop: an agent can pin
an insight by writing one file. The front half had no contract at all. README
said "point an agent at that file" and stopped there — no path, no schema, and
no statement of the rules that make a total correct.

**User:** an agent in a terminal, working for Andrew, with read access to the
statements folder. It may have no access to this repository at all, so the
contract cannot assume the source is on hand.

**Success:** an agent that has never seen Omakei can locate the ledger, compute
this month's spend, income, and net, and get the same three figures the
dashboard shows.

## Tech Stack

None. The contract is prose plus a test that keeps it true. No new dependencies,
no new runtime code, no change to the ledger format.

## Commands

```
Test:      npm test              # includes the contract-drift guard
Typecheck: npm run typecheck
```

## Project Structure

```
docs/ledger.md                          → the contract, written for an agent to read
docs/spec/ledger-contract.md            → this file
src/lib/finance/ledger-contract.test.ts → asserts the doc matches the code
```

This mirrors the panel contract deliberately: `src/panels/README.md` is to
writing a panel what `docs/ledger.md` is to reading the ledger. Both are read by
an agent, and both are guarded by `npm test` rather than trusted.

## Why a document and not a schema file

Three alternatives were considered and rejected:

- **Embed the semantics in `omakei-ledger.json`.** docs/agents.md requires the ledger
  persist compactly, and the rules are about ten times the size of a month of
  transactions. Rejected.
- **Write a README into the statements folder.** The server would have to write
  into the user's data directory, which is currently write-once-per-save and
  holds nothing but their statements. That is a behaviour change requiring its
  own decision, not a side effect of writing a doc. Left as an open question.
- **Ship a query helper module.** It would only serve agents that can run Node
  against a clone, which is the case the panel contract already covers. The
  agents that need this most are the ones holding a file path and nothing else.

The doc is the smallest thing that serves the reader who has least.

## The rules it exists to state

Documented in `docs/ledger.md`; recorded here as the design content:

1. `categoryId === "transfers"` is excluded from spend and income.
2. Category names ship in the build, not in the ledger.
3. `categoryId: null` is uncategorized spending, and it counts.
4. `setAsides` are monthly reserves, not balances.
5. `rules` holds only the user's manual overrides, not the default categorizer.

Rule 1 is the one that motivated the work. Verified on the synthetic ledger
below, summing every negative amount overstated monthly spending by 63–85%.
The error is quiet: transfers cancel in `income - spend`, so a net figure
computed without the rule is off only by the set-aside total and looks right
while the two figures behind it are badly wrong.

## Testing Strategy

The risk is not that the doc is wrong today; it is that the code moves and the
doc keeps confidently saying the old thing. `ledger-contract.test.ts` therefore
checks the doc against the code:

- The category table is parsed out of the markdown and compared to `CATEGORIES`.
  A renamed or added category fails `npm test` until the table is updated.
- `TRANSFER_CATEGORY` is asserted to be the literal the doc prints.
- The documented spend and income predicates are exercised against `isSpend` and
  `isIncome`, including the transfer and uncategorized cases.
- The state-file keys named in the doc are asserted to be the ones
  `renderStateFile` emits.

Confirmed to fail as intended: renaming Coffee to "Coffee shops" in the doc
turns the table test red.

## Boundaries

**Always:**
- Keep `docs/ledger.md` readable by someone holding only the ledger file. No
  "see `src/lib/finance/...`" as a load-bearing instruction.
- Keep the guard test parsing the doc, not duplicating it. Two copies of the
  category list drift; a parsed one cannot.

**Ask first:**
- Writing anything into the user's statements folder that is not the ledger.
- Changing the on-disk `version: 1` shape.

**Never:**
- Put personal data in the doc's worked example. The figures in it come from a
  generated ledger of national-chain merchants, not a real one.
- Describe a rule the code does not implement. The guard catches the category
  table; the prose rules are on the author.

## Success Criteria

Verified 2026-08-27 against a synthetic eight-month ledger (236 transactions,
one credit-card payment and one savings sweep per month) served through
`npm run start`.

1. **Met.** The doc's worked example for `2026-08` — spend `$3,580.51`, income
   `$8,421.10`, net `+$4,190.59` — matches what the dashboard rendered, figure
   for figure.
2. **Met.** A naive read applying none of the rules overstated spend by 63–85%
   across the eight months, and its net was wrong by exactly the set-aside
   total, confirming the error is silent rather than obvious.
3. **Met.** The guard test passes, and fails when the doc drifts from
   `CATEGORIES`.
4. **Met.** 51 tests, typecheck, and lint pass. (The one lint warning in
   `components/ui/button.tsx` is pre-existing and unrelated.)

Found while running the loop: `dist/.build-hash` is computed from files git is
**tracking**, so building immediately after writing a new panel stamps a hash
that omits it and the pre-commit hook then rejects the commit. The advertised
workflow — write one file, run `npm run build` — hits this on the first try.
`src/panels/README.md` now says to `git add` the panel before building.

## Open Questions

1. **Should the contract travel with the ledger?** An agent pointed at the
   statements folder alone cannot see `docs/ledger.md`. The server could write a
   copy next to the ledger, at the cost of putting a second Omakei-owned file in
   the user's folder. Proposal: not yet — Andrew works in a clone, and the doc is
   linked from README for everyone else.
2. **Does this settle SQLite?** The intent asks for the decision on legibility
   grounds. The loop run says the JSON was legible enough once five rules were
   written down, and that the rules — not the format — were the missing piece.
   SQLite would not have prevented a single one of the errors measured here, and
   a `spend` view over SQL would still need rule 1 explained. Proposal: the JSON
   stays, and SQLite is revisited only if a real question turns out to be
   awkward to express over an array.
