# Spec: Categorization

_Status: **forward spec** — target behavior, not yet built. Traces to
`docs/intent/omakei.md`, which takes precedence._

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

## What changes from today

| Area | Today | Target |
|---|---|---|
| Agent rule-authoring | An agent can write the file, but nothing documents the rule shape, when it takes effect, or the race with an open editor. | A written contract in `docs/ledger.md`: rule shape, "close the editor first," takes effect on next load + sync. |
| Engine tests | None direct; incidental coverage via `transfers.test.ts`. | `ledger.test.ts` covers `assignCategory` precedence, `bestMatchingRule` ranking, `upsertRule` idempotency, `refreshCategories` null-preservation. |
| `RulesSheet` regex claim | "Wrap a pattern in /slashes/ to use a regex" — but no add form exists anywhere in the app. | The sentence goes, or it points at the agent / JSON path as where regex rules come from. |
| Guess vs. confirmed | A default guess and a hand-set category are indistinguishable in the ledger. | Decided in Open Question 1 — whether a `confirmedAt` marker earns its ledger-shape change. |

**Not in scope:** a rule editor in the app, user-editable categories, sub-categories,
per-transaction overrides that aren't backed by a merchant rule.

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
```

New: `src/lib/finance/ledger.test.ts`. Docs touched: `docs/ledger.md` (add the
write contract), `docs/spec/README.md` (add the row).

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

- **`ledger.test.ts` (new):**
  - `assignCategory` — user rule beats default; transfer detection beats default;
    mortgage category beats default; no match → `null`; a default match still
    resolves when `accountKind` is absent.
  - `bestMatchingRule` — longest identifier wins within `"user"`; `createdAt`
    descending breaks a length tie; the `source` filter is honored.
  - `upsertRule` — a second call for the same lowercased pattern updates the
    category in place and adds no row; a new pattern prepends.
  - `refreshCategories` — a `null` stays `null` when nothing matches; adding a
    rule re-tags history; removing a rule reverts affected rows to their
    default or `null`.
- **`fingerprint.test.ts` (extend):** `extractMerchant` against a table of
  real-shape bank lines (national chains only), asserting the grouping key the
  "Needs a category" list would build a rule from.
- **`ledger-contract.test.ts` (existing):** still guards `CATEGORIES` against
  `docs/ledger.md`.
- **End-to-end, by hand:** append a well-formed rule to an isolated
  `omakei-ledger.json`, run `npm run dev:isolated`, confirm the matching rows
  show the new category and a second sync does not change them.

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

1. `ledger.test.ts` exists and asserts the four-step precedence, longest-identifier
   ranking, `upsertRule` idempotency, and `null` preservation.
2. Appending a well-formed rule to an isolated ledger and running
   `npm run dev:isolated` re-tags every matching transaction; a second sync is a
   no-op on those rows.
3. `docs/ledger.md` documents the agent write path: rule shape, the "editor
   closed" constraint, and when it takes effect.
4. `RulesSheet` copy matches the affordances that actually exist.
5. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green;
   `dist/` rebuilt from the final source.
6. `categoryName`, the `CATEGORIES` table, and `docs/ledger.md` still agree
   (`ledger-contract.test.ts`).

## Open Questions

1. **Guess vs. confirmed.** Today a default-pattern guess and a hand-verified
   category are identical in the ledger, so an agent can't answer "which of these
   should I double-check?" and a wrong `costco → groceries` silently skews
   "Drifting up." Worth a `confirmedAt?: number` on `Transaction`, or a `source`
   on the resolved category? It is a ledger-shape change (version bump,
   `Model.js`, `docs/ledger.md`) for a benefit that may not be felt until the
   agent loop is real. **Leaning: defer until an agent actually asks for it.**

2. **The open-editor race.** The agent writes `omakei-ledger.json`; if a tab is
   open, the app's memory is authoritative and the next debounced save (32 ms
   after any edit) clobbers the agent's rule. "Close the editor first" is the
   boring answer. A `scripts/omakei-categorize.mjs` that adds a rule and
   re-derives — it can import the shipped `DEFAULT_PATTERNS` directly — would be
   safer and scriptable, but that is a Plan-phase call, not a spec commitment.

3. **`refreshCategories` does not run on plain `loadSnapshot`.** It runs on
   import and sync. With a folder attached — the normal case — boot syncs, so an
   agent's rule lands. With no folder attached (manual imports only) the rule
   sits inert until the next manual import. Acceptable, or should `loadSnapshot`
   re-derive?

4. **`extractMerchant` is the ceiling on the "Needs a category" list.** ~60 lines
   of stacked heuristics, no direct tests. If it groups two merchants under one
   key, one assignment mis-categorizes both; if it splits one merchant, the user
   assigns twice. A test corpus would bound the damage; a rewrite is out of scope
   here.

5. **`transaction-row.tsx` always writes a merchant rule**
   (`categorizeOne(id, cat, true)`). There is no "just this one" — every
   correction in the activity table is permanent and merchant-wide. Given "lean
   on the agent," is that acceptable, or does the honest per-row fix need
   `always=false` wired to something (a modifier key, a second menu item)?
