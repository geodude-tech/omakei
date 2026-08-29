# Spec: Categorization

_Status: mostly implemented as of 2026-08-28 (branch `worktree-categorization-spec`).
Started as a forward spec; the engine tests, the `loadSnapshot` re-derive, the
`omakei-categorize.mjs` write path, and the truthful `RulesSheet` copy have
landed. Open Questions 1, 4, and 5 remain. Traces to `docs/intent/omakei.md`,
which takes precedence._

## Objective

Give every transaction a `categoryId` (or an honest `null`), deterministically,
so the dashboard's verdicts — "Dining is up 40%" — rest on numbers a user can
trust. Categorization is the join between a raw bank line and the category groups
the "Drifting up" and "Where it went" panels read.

Two things have to be true:

- **Right enough on the first sync** that the stat row and the drift panel are
  not lying. The built-in patterns carry this.
- **Cheap to correct**, two ways: the user fixes the handful that matter, one
  merchant at a time, in the app; an agent at the terminal fixes them in bulk by
  writing rules into `omakei-ledger.json` — the loop `docs/ledger.md` opens for
  reading, closed for writing.

What this is **not**: no ML, no model call, no classifier training, no
per-transaction tags beyond the one category. The taxonomy is fixed — 17
categories, 4 groups — and this spec keeps it fixed.

**Relationship to `statement-import.md`:** that spec owns the parse → row → dedupe
pipeline and the internal-transfer *pairing*. This spec owns what category a row
comes out as. They share `categories.ts`, `fingerprint.ts`, `ledger.ts`,
`transfers.ts`; when a boundary is unclear, the arrow that assigns `categoryId`
is here, everything before it is statement-import.

**Users:**

- **Andrew / an Omarchy user.** Drops statements, opens the editor, glances at
  "Needs a category," assigns the three merchants that account for most of the
  uncategorized money. Never writes a regex.
- **An agent in a terminal.** Reads the ledger, finds 60 uncategorized
  transactions across 9 merchants, writes 9 rules into the ledger file, done.

**Success:**

- `assignCategory(description, rules, accountKind, amount)` is pure and total:
  same inputs, same output; every input yields a `categoryId` or `null`, never a
  throw. Its four-step precedence is unit-tested.
- A user rule always beats a default. Among matches, the longest identifier wins;
  `createdAt` descending breaks ties. Unit-tested.
- `null` survives import and `refreshCategories` untouched — never coerced to
  `other`. Unit-tested.
- An agent appends `{ id, pattern, categoryId, createdAt, source: "user" }` to
  `rules[]` in `omakei-ledger.json`; the next time the editor loads and syncs,
  every matching transaction carries that `categoryId`, and a re-sync neither
  drops the rule nor changes the result.
- `RulesSheet` names only affordances that exist.
- `scripts/check-no-personal-data` stays green — no household merchant in
  `DEFAULT_PATTERNS`.

## What changed

| Area | Was | Now |
|---|---|---|
| Agent rule-authoring | An agent could write the file, but nothing documented the rule shape, when it takes effect, or the race with an open editor. | `scripts/omakei-categorize.mjs` (add / `--remove` / `--list` / `--dry-run`): writes the rule, re-derives with the shipped engine, bumps the bar revision. Contract in `docs/ledger.md`. |
| Rules applied on load | `loadSnapshot` stored `categoryId` verbatim; a rule added since the last save only took effect on the next import or folder sync. | `loadSnapshot` runs `refreshCategories`, so opening the editor applies new rules — folder or not. |
| Engine tests | None direct; incidental coverage via `transfers.test.ts`. | `ledger.test.ts` covers `assignCategory` precedence, the longest-identifier / newer-`createdAt` ranking, `upsertRule` idempotency, `refreshCategories` null-preservation; `store.test.ts` covers the load re-derive. |
| `RulesSheet` regex claim | "Wrap a pattern in /slashes/ to use a regex" — but no add form exists anywhere in the app. | Copy describes only what the sheet does (view / delete) and points at `omakei-categorize.mjs` for bulk edits and regex. |
| Guess vs. confirmed | A default guess and a hand-set category are indistinguishable in the ledger. | Unchanged — Open Question 1, deferred. |

**Not in scope:** a rule editor in the app, user-editable categories, sub-categories,
per-transaction overrides that aren't backed by a merchant rule (Open Question 5).

## Tech Stack

Same as the rest of Omakei: TypeScript 5.7 under `node --experimental-strip-types`
for the `.ts` logic and its tests; React 19 / Zustand 5 for the three UI
surfaces. **No new dependencies** — the engine ships in the plugin build and
`omarchy plugin add` never runs `npm install`.

## Commands

```
Test (engine):  node --experimental-strip-types --test src/lib/finance/ledger.test.ts
Test (all):     npm test
Typecheck:      npm run typecheck
Lint:           npm run lint
Dev (safe):     npm run dev:isolated     # against .dev/, never your real ledger
Build:          npm run build            # rebuild + commit dist/ when src/ changes
```

## Project Structure

```
src/lib/finance/categories.ts   → CATEGORIES (the fixed 17), DEFAULT_PATTERNS, defaultRules(), categoryName()
src/lib/finance/fingerprint.ts  → ruleMatches(), identifierLength(), extractMerchant() — the matcher
src/lib/finance/ledger.ts       → assignCategory(), bestMatchingRule(), upsertRule(), makeUserRule(), refreshCategories()
src/lib/finance/transfers.ts    → structural transfer / mortgage categories + opposite-leg pairing (see statement-import.md)
src/lib/finance/store.ts        → categorizeMerchant(), categorizeOne(), unknownMerchants()
src/components/omakei/needs-category.tsx   → the uncategorized-merchant list + picker
src/components/omakei/category-select.tsx  → the grouped category dropdown
src/components/omakei/rules-sheet.tsx      → view / delete user rules
src/components/omakei/transaction-row.tsx  → per-row category dropdown
scripts/omakei-categorize.mjs   → terminal CLI: add / --remove / --list / --dry-run a user rule, re-derive, bump the bar
scripts/ledger-api.mjs          → exports writeAtomic() and bumpRevisionAt(stateDir), used by the CLI to write like the server does
```

Tests: `src/lib/finance/ledger.test.ts`, `src/lib/finance/store.test.ts`,
`scripts/omakei-categorize.test.mjs`, plus the `extractMerchant` corpus in
`fingerprint.test.ts`. Docs: `docs/ledger.md` "Writing back" section,
`docs/spec/README.md` row.

## Code Style

`assignCategory` is the whole contract, stated as ordered predicates:

```ts
export function assignCategory(
  description: string,
  rules: CategorizeRule[],
  accountKind?: AccountKind,
  amount?: number,
): string | null {
  const userHit = bestMatchingRule(description, rules, "user");
  if (userHit) return userHit.categoryId;                        // 1. the user's hand wins outright
  if (accountKind && isInternalTransfer(description, accountKind, amount)) {
    return TRANSFER_CATEGORY;                                    // 2. structural transfers
  }
  if (accountKind === "mortgage") {
    const mortgage = mortgageCategory(description);
    if (mortgage) return mortgage;                               // 3. mortgage-specific
  }
  return bestMatchingRule(description, rules, "default")?.categoryId ?? null; // 4. built-ins, else null
}
```

Conventions:

- **`null` is a real outcome**, carried through every derived view. Never
  `?? "other"` at import time.
- **Longest identifier wins.** `bestMatchingRule` ranks by
  `identifierLength(pattern)`, then `createdAt` descending. `safeway fuel`
  (transport) beats `safeway` (groceries).
- **The engine re-derives; manual pokes don't stick.** `refreshCategories` calls
  `assignCategory` for every transaction on every import and sync. A `categoryId`
  written into the ledger without a rule to back it is overwritten on the next
  sync. An agent changes a category by **adding a rule**, not by editing the
  transaction.
- **Defaults never persist.** `snapshotFromState` writes only `source === "user"`
  rules; `parseLedgerData` drops any rule missing `source: "user"`, `pattern`, or
  `categoryId`, then re-merges `seedRules()`.
- **New view math is a `.ts` module with a failing test first** — `.tsx` cannot
  be strip-typed, so it cannot be unit-tested.

## Testing Strategy

`node --experimental-strip-types --test` on the `.ts` modules; the `.tsx`
surfaces are checked by hand.

- **`ledger.test.ts`:** `assignCategory`'s four-step precedence (user rule /
  structural transfer / mortgage / default / `null`); the longest-identifier and
  newer-`createdAt` ranking (exercised through `assignCategory`, since
  `bestMatchingRule` is unexported); `upsertRule` idempotency and whitespace
  distinctness; `refreshCategories` preserving `null`, re-tagging on a new rule,
  reverting on removal, and being idempotent on already-derived rows.
- **`store.test.ts`:** `loadSnapshot` re-derives from the snapshot's rules, and
  falls back to the defaults when none are stored.
- **`omakei-categorize.test.mjs`:** the CLI end to end against a throwaway
  ledger — add, idempotent re-run, `--remove`, `--dry-run` (byte-identical
  file), `--list`, unknown category, no attached folder.
- **`fingerprint.test.ts`:** an `extractMerchant` corpus of real-shape bank
  lines; four cases are marked `WRONG` and tracked in `tasks/plan.md` (OQ4).
- **`ledger-contract.test.ts` (existing):** still guards `CATEGORIES` against
  `docs/ledger.md`.

A new `DEFAULT_PATTERNS` entry needs a `fingerprint.test.ts` or `ledger.test.ts`
case if the match isn't obvious.

## Boundaries

**Always:**
- Keep `assignCategory` pure and total — skip nothing, throw nothing, return
  `categoryId | null`.
- Leave the fingerprint and `normalizeDescription` untouched when working on
  categorization — re-keying the ledger turns the next sync into a mass
  re-import (statement-import.md).
- Keep `DEFAULT_PATTERNS` to public chains; `check-no-personal-data` runs in
  `npm test`.
- Rebuild and commit `dist/` when anything under `src/` changes.

**Ask first:**
- Adding or renaming a category (touches `categories.ts`, `docs/ledger.md`,
  `Model.js`'s `CATEGORY_NAMES`; `ledger-contract.test.ts` enforces the first).
- Changing the four-step precedence or the longest-identifier tiebreak.
- Adding a field to the ledger shape (e.g. a "confirmed" marker) — it is a
  versioned contract other readers depend on.
- Changing `extractMerchant`'s heuristics — a wrong merchant key silently makes
  a too-broad or too-narrow rule.

**Never:**
- Add a model call, an API key, a "suggest categories" button, or any AI surface.
  The agent lives in the terminal.
- Coerce `null` to `other` anywhere upstream of a grouped view.
- Persist default rules into `omakei-ledger.json`.
- Replay `rules` against `description` to "reconstruct" categories — the defaults
  ship in the build, so the replay is incomplete by construction (ledger rule 5).

## Success Criteria

1. **Met.** `ledger.test.ts` + `store.test.ts` assert the four-step precedence,
   the identifier/`createdAt` ranking, `upsertRule` idempotency, `null`
   preservation, and the load re-derive.
2. **Met.** `omakei-categorize.test.mjs`: `omakei-categorize.mjs "<pattern>"
   <id>` against a ledger re-tags every matching row and re-running is a no-op.
3. **Met.** `docs/ledger.md` "Writing back" documents the rule shape, the tool,
   regex support, the re-derive, and the editor-closed constraint.
4. **Met.** `RulesSheet` copy describes view/delete only and points at the CLI.
5. **Met.** `npm test` (163), `npm run typecheck`, `npm run lint` (one
   pre-existing `button.tsx` warning), `npm run build` all green; `dist/` rebuilt.
6. **Met.** `ledger-contract.test.ts` still green — `CATEGORIES` and
   `docs/ledger.md` agree.

## Open Questions

1. **Guess vs. confirmed.** Today a default-pattern guess and a hand-verified
   category are identical in the ledger, so an agent can't answer "which of these
   should I double-check?" and a wrong `costco → groceries` silently skews
   "Drifting up." Worth a `confirmedAt?: number` on `Transaction`, or a `source`
   on the resolved category? It is a ledger-shape change (version bump,
   `Model.js`, `docs/ledger.md`) for a benefit that may not be felt until the
   agent loop is real. **Leaning: defer until an agent actually asks for it.**

2. ~~**The open-editor race.**~~ _Resolved 2026-08-28._ `omakei-categorize.mjs`
   ships and re-derives with the real engine; `docs/ledger.md` documents "run it
   with the editor closed, reload the tab after." A live push into an open tab
   would need a server round-trip on the render path — a `dashboard-app.md`
   "ask first" — and stays a non-goal.

3. ~~**`refreshCategories` does not run on plain `loadSnapshot`.**~~ _Resolved
   2026-08-28._ It does now, so an agent's rule lands on the next editor open
   whether or not a folder is attached.

4. **`extractMerchant` is the ceiling on the "Needs a category" list.** The
   corpus in `fingerprint.test.ts` now pins its output and flags four wrong
   keys (drops the distinguishing word; splits Amazon; keeps a per-transaction
   code; misses the `DEBIT CARD PURCHASE` prefix). A `PREFIXES` entry and a
   trailing-`*CODE` strip are small follow-ups; the "drops the distinguishing
   word" behavior needs its own look. Not done here — see `tasks/plan.md`.

5. **`transaction-row.tsx` always writes a merchant rule**
   (`categorizeOne(id, cat, true)`). There is no "just this one" — every
   correction in the activity table is permanent and merchant-wide. _Decided
   2026-08-28: leave the behavior, document it (the `RulesSheet` copy names the
   CLI for finer edits); do not add a per-transaction override — it would need a
   `source:"manual-tx"` ledger concept the "lean on the agent" direction rules
   out._
