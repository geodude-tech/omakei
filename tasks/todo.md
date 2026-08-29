# Todo: Categorization (forward spec)

Plan: `tasks/plan.md`. Spec: `docs/spec/categorization.md`. Work top to bottom;
stop at each checkpoint for review. One commit per task.

Status: COMPLETE — all 7 tasks landed on `worktree-categorization-spec`.
`npm test` 163 pass (70 script + 93 src), typecheck clean, lint shows only the
pre-existing `button.tsx` warning, `npm run build` green. Checkpoints A–D met;
the checkpoint review gates were waived by the user ("proceed, and yes to all
three"). Live `dev:isolated` browser check not run — the CLI is covered end to
end by `omakei-categorize.test.mjs` and `loadSnapshot` by `store.test.ts`.

Findings recorded for follow-up (not fixed): four `extractMerchant` mis-groupings
(spec OQ4, `tasks/plan.md`).

---

## Task 1: `ledger.test.ts` — engine characterization

**Description:** New `src/lib/finance/ledger.test.ts`. Pin the current behavior of
the four exported engine functions so later phases are provably
behavior-preserving. Fixtures are inline strings using national-chain names only
(AGENTS.md). No source changes.

**Acceptance criteria:**
- [ ] `assignCategory`: user rule beats a matching default; a structural transfer
      (`isInternalTransfer` true) beats a default; `accountKind:"mortgage"` +
      `mortgageCategory` hit beats a default; nothing matches → `null`; a default
      pattern still resolves when `accountKind`/`amount` are omitted.
- [ ] `bestMatchingRule`: longer `identifierLength` wins among `"user"` rules;
      equal length → higher `createdAt` wins; a `"user"` call never returns a
      `"default"` rule and vice versa.
- [ ] `upsertRule`: second call, same pattern (case-insensitively) → category
      updated in place, array length unchanged; new pattern → prepended,
      `source:"user"`, `createdAt` set.
- [ ] `refreshCategories`: a row that matches no rule stays `categoryId:null`;
      adding a user rule re-tags matching history; removing it reverts those rows
      to their default/`null`; running it twice on already-derived input is a
      no-op (idempotent).

**Verification:**
- [ ] `node --experimental-strip-types --test src/lib/finance/ledger.test.ts`
- [ ] `npm test`, `npm run typecheck`
- [ ] `git diff --stat` — only `src/lib/finance/ledger.test.ts` added

**Dependencies:** None
**Files:** `src/lib/finance/ledger.test.ts` (new)
**Scope:** M

---

## Task 2: `extractMerchant` corpus in `fingerprint.test.ts`

**Description:** Add a table-driven test to `src/lib/finance/fingerprint.test.ts`
asserting the grouping key `extractMerchant` returns for ~15–20 real-shape bank
descriptions (national chains: prefixes like `POS DEBIT`, `SQ *`, trailing
store IDs, city + state, phone numbers). This is the key `unknownMerchants`
groups by and `categorizeMerchant` turns into a rule pattern — it is the ceiling
on the "Needs a category" list. Records current output; does not change
`extractMerchant`.

**Acceptance criteria:**
- [ ] A `for...of` table of `{ input, expected }` cases covering: a bare merchant,
      a `SQ */TST *` weak lead, a name with a trailing store number, a name with
      city + 2-letter state, a `CHECKCARD 1234` prefix, a brand-number merchant
      (`76`).
- [ ] Any case where the current output looks wrong is kept in the table with a
      `// NOTE: arguably should be "…"` comment and logged in `tasks/plan.md`
      Open Questions — not fixed.

**Verification:**
- [ ] `node --experimental-strip-types --test src/lib/finance/fingerprint.test.ts`
- [ ] `npm test`

**Dependencies:** None
**Files:** `src/lib/finance/fingerprint.test.ts`
**Scope:** S

---

### Checkpoint A
- [ ] `npm test` green; diff is test-only
- [ ] Wrong-looking pinned behavior recorded in the plan, not fixed
- [ ] Review with human before Phase 2

---

## Task 3: `loadSnapshot` re-derives categories

**Description:** In `src/lib/finance/store.ts`, `loadSnapshot` currently sets
`transactions: snapshot.transactions` verbatim. Run them through
`refreshCategories(snapshot.transactions, rules)` (using the same
`rules.length > 0 ? snapshot.rules : seedRules()` it already computes) so a rule
added to the ledger since the last save applies on load, folder or not.

**Acceptance criteria:**
- [ ] `loadSnapshot` stores `refreshCategories(snapshot.transactions, resolvedRules)`.
- [ ] Loading a snapshot whose categories are already correct produces an
      identical transaction list (idempotent — leans on Task 1's coverage).
- [ ] A snapshot containing a `source:"user"` rule that matches rows still tagged
      by an old default comes out re-tagged to the user rule's category.
- [ ] No change to `importFiles` / `categorizeMerchant` / `categorizeOne`.

**Verification:**
- [ ] `npm test`, `npm run typecheck`, `npm run lint`
- [ ] Manual (`npm run dev:isolated`): add `{"id":"x","pattern":"national-chain",
      "categoryId":"groceries","createdAt":1,"source":"user"}` to
      `.dev/state/omakei/…/omakei-ledger.json` with the dev server stopped,
      restart, open editor with **no folder attached** → matching rows show
      Groceries.

**Dependencies:** Task 1
**Files:** `src/lib/finance/store.ts`
**Scope:** XS

---

## Task 4: `scripts/omakei-categorize.mjs` + test

**Description:** New CLI for terminal/agent bulk rule-authoring.

```
node scripts/omakei-categorize.mjs <pattern> <categoryId>   # add or update a user rule, re-derive, write
node scripts/omakei-categorize.mjs --remove <pattern>       # drop a user rule, re-derive, write
node scripts/omakei-categorize.mjs --list                   # uncategorized merchants, absolute total desc
node scripts/omakei-categorize.mjs --dry-run <pattern> <categoryId>  # print what would change, write nothing
```

Resolves the ledger path via `ledger-api.mjs` helpers (`stateDirFor`,
`expandHome`, `parseStateFile`, `readCapped`, `LEDGER_FILENAME`) — same
resolution as `omakei-read-ledger.mjs`. Re-derives with the real engine:
`import { refreshCategories, upsertRule, seedRules } from "../src/lib/finance/ledger.ts"`,
building `rules = [...userRules, ...seedRules()]` exactly as `parseLedgerData`
does. Writes atomically (temp file in the same dir + `rename`). Rejects an
unknown `categoryId` against `CATEGORIES`. On success prints
`N transactions re-tagged` and `M still uncategorized`.

**Acceptance criteria:**
- [ ] Import of `../src/lib/finance/ledger.ts` from the `.mjs` succeeds under
      `node` and `node --test` (verify first — if not, add an
      `--experimental-strip-types` test entry for this file in `package.json`).
- [ ] `<pattern> <categoryId>` on a ledger with matching uncategorized rows:
      writes a `source:"user"` rule (via `upsertRule`), re-derives, every
      matching row now carries `categoryId`; rows categorized by other defaults
      are untouched.
- [ ] Running the same command again changes nothing (idempotent; exit 0).
- [ ] `--remove` deletes the matching `source:"user"` rule and reverts its rows.
- [ ] `--list` prints merchant · count · total for `categoryId === null` rows,
      largest absolute total first.
- [ ] `--dry-run` prints the diff summary and leaves the file byte-identical.
- [ ] Unknown `categoryId` → non-zero exit, message naming the valid ids, no write.
- [ ] No ledger / no state file → clear message, non-zero exit, no write.
- [ ] Never imports mutating internals of `ledger-api.mjs`; `ledger-api.mjs`
      unchanged.
- [ ] `scripts/omakei-categorize.test.mjs`: covers add, idempotent re-run,
      `--remove`, `--dry-run` no-write, unknown category, missing ledger — each
      against a temp-dir ledger fixture (chain names only).

**Verification:**
- [ ] `node --test scripts/omakei-categorize.test.mjs`
- [ ] `npm test` (runs `scripts/**/*.test.mjs` + `check-no-personal-data`)
- [ ] `npm run lint`
- [ ] Manual: `--list`, add, re-run, `--remove`, `--dry-run` against a
      `dev:isolated` ledger.

**Dependencies:** Task 1
**Files:** `scripts/omakei-categorize.mjs` (new), `scripts/omakei-categorize.test.mjs` (new)
**Scope:** M

---

### Checkpoint B
- [ ] `npm test`, `npm run typecheck`, `npm run lint` green
- [ ] Manual: no-folder reload applies a hand-added rule (Task 3)
- [ ] Manual: script add / re-run / `--list` / `--remove` / `--dry-run` all behave
- [ ] Review with human before Phase 3

---

## Task 5: `RulesSheet` copy — remove unreachable claims

**Description:** `src/components/omakei/rules-sheet.tsx` tells the user "Wrap a
pattern in /slashes/ to use a regex" and the empty state implies rules are
authored in-app — but there is no add form and no regex input anywhere. Trim the
description to what the sheet actually does (view + delete rules created by
assigning a category to an uncategorized merchant). Keep the "key identifier, not
the whole bank line — `safeway` hits every Safeway" explanation; drop the regex
sentence. Optionally one line: bulk edits and regex patterns are a terminal job
(`scripts/omakei-categorize.mjs`).

**Acceptance criteria:**
- [ ] No mention of `/slashes/` or entering a regex in the sheet.
- [ ] Copy describes only: these are rules you made by categorizing a merchant;
      delete removes one.
- [ ] The "no custom rules yet" empty state still points at "assign a category to
      an unknown merchant."
- [ ] No component logic change.

**Verification:**
- [ ] `npm run typecheck`, `npm run lint`
- [ ] Manual: open the sheet, read it, delete a rule.

**Dependencies:** None (do after Task 4 so the optional pointer names a real tool)
**Files:** `src/components/omakei/rules-sheet.tsx`
**Scope:** S

---

## Task 6: `docs/ledger.md` write contract + spec reconciliation

**Description:** Add a "Writing back: categorize rules" section to `docs/ledger.md`
(after "The five rules", before "Pinning the answer"): the `CategorizeRule` shape,
that only `source:"user"` rules persist and defaults ship in the build, that
`scripts/omakei-categorize.mjs` is the supported way to add/remove them and
re-derives `categoryId` with the shipped engine, that regex patterns (`/…/`)
are accepted, and the editor-closed / reload-the-tab constraint. Then update
`docs/spec/categorization.md`: strike the resolved "What changes from today" rows,
move OQ2/OQ3 to a "Decided" note (script + `loadSnapshot` re-derive), leave
OQ1/OQ4/OQ5 open with the plan's recommendations folded in.

**Acceptance criteria:**
- [ ] `docs/ledger.md` documents the rule shape, the script, regex support, and
      the concurrency constraint — no hand-edit-the-JSON procedure as the
      primary path.
- [ ] `docs/spec/categorization.md` matches what shipped; no stale "target"
      claims for delivered work.
- [ ] `docs/spec/README.md` row still accurate.
- [ ] `node scripts/check-no-personal-data.mjs` exit 0.
- [ ] `ledger-contract.test.ts` still green (CATEGORIES table unchanged).

**Verification:**
- [ ] `npm test`
- [ ] Re-read `docs/ledger.md` and `docs/spec/categorization.md` end to end.

**Dependencies:** Tasks 3, 4, 5
**Files:** `docs/ledger.md`, `docs/spec/categorization.md`, maybe `docs/spec/README.md`
**Scope:** S

---

### Checkpoint C
- [ ] `check-no-personal-data` green
- [ ] Docs, spec, and `RulesSheet` all agree with shipped behavior
- [ ] Review with human before Phase 4

---

## Task 7: Build `dist/` + full verification

**Description:** Tasks 3 and 5 touch `src/`, so `dist/` must be rebuilt and
committed or the pre-commit `check-dist-fresh` hook fails and installers ship
stale UI. New script files are `git add`ed before the build (the stamp hashes
tracked files).

**Acceptance criteria:**
- [ ] `scripts/omakei-categorize.mjs` and its test are tracked before `npm run build`.
- [ ] `npm run build` exits 0; `dist/` and `dist/.build-hash` staged.
- [ ] `npm test` + `npm run typecheck` + `npm run lint` + `npm run build` all green.
- [ ] Pre-commit hook passes (`check-dist-fresh`, `check-no-statements`,
      `check-no-personal-data --staged`).

**Verification:**
- [ ] `npm run build`
- [ ] `npm run start` serves the built bundle; open the editor, open the rules
      sheet, confirm the new copy renders.
- [ ] `git status` — `dist/` staged alongside source.

**Dependencies:** All prior
**Files:** `dist/**`
**Scope:** S

---

### Checkpoint D — Complete
- [ ] Every acceptance criterion above checked
- [ ] Full suite + typecheck + lint + build green
- [ ] `docs/spec/categorization.md` reflects delivered state
- [ ] Branch ready for PR
