# Implementation Plan: Categorization (forward spec)

Traces to `docs/spec/categorization.md`. Branch: `worktree-categorization-spec`.

## Overview

The categorization engine is sound; the work is to (1) lock its behavior behind
unit tests it currently lacks, (2) give an agent at the terminal one sharp tool
for bulk rule-authoring — `scripts/omakei-categorize.mjs` — instead of a
paragraph of caveats about hand-editing JSON, (3) make the derivation path pick
up rules on load rather than only on import/sync, and (4) stop `RulesSheet` from
advertising an add form and a regex entry that don't exist. No engine
precedence changes, no new categories, no in-app rule editor.

## Architecture Decisions

- **Characterization tests first (Phase 1), zero source changes.** `ledger.test.ts`
  and the `extractMerchant` corpus capture *today's* behavior so Phases 2–3 are
  provably behavior-preserving where they claim to be. If a test surfaces a
  latent bug, it is recorded, not fixed here (scope).

- **The script is the contract.** Rather than only documenting a JSON shape,
  ship `scripts/omakei-categorize.mjs`: it locates the ledger the same way
  `omakei-read-ledger.mjs` does, adds/updates/removes a `source:"user"` rule,
  re-derives every `categoryId` using the **real** engine
  (`import … from "../src/lib/finance/ledger.ts"` — verified: `.mjs` importing
  `.ts` works under `node` and `node --test` on this Node, no flag), and writes
  atomically. `docs/ledger.md` documents *the tool*, not a hand-edit procedure.
  Regex patterns (`/…/`) already work in the engine regardless of rule source —
  the script accepts them; the UI still never offers them.

- **`loadSnapshot` re-derives.** One line: run `refreshCategories(transactions,
  rules)` in the store's `loadSnapshot`, so opening the editor applies any rule
  added since the last save — with or without an attached folder. Safe today
  because every stored `categoryId` is already backed by a rule, a default, or
  transfer logic (nothing calls `categorizeOne(…, always=false)`); re-deriving
  also picks up improved shipped defaults across app versions, which is wanted.

- **Don't touch `ledger-api.mjs` logic.** The categorize script gets its own
  small atomic write (temp file + rename) rather than reaching into
  `ledger-api.mjs`. Reusing its pure path helpers (`stateDirFor`,
  `expandHome`, `parseStateFile`, `readCapped`, `LEDGER_FILENAME`) by import is
  fine; editing that file is not (see Risks).

- **The open-editor race is documented, not engineered away.** If a tab is open
  and the user makes an in-app edit, the 32 ms debounced save wins over the
  script's write. The doc says: run the script with the editor closed, or reload
  the tab after. A server round-trip to push rules into a live tab is a
  deliberate non-goal (`dashboard-app.md`: "Ask first" on new render-path
  round-trips; the app stays dumb).

## Dependency Graph

```
Task 1  ledger.test.ts (characterization)      ─┐
Task 2  extractMerchant corpus                  ─┤  (independent; either order)
                                                 │
        ── Checkpoint A ──                       │
                                                 ▼
Task 3  loadSnapshot re-derives  ───────────────┐   (protected by Task 1)
Task 4  scripts/omakei-categorize.mjs + test  ──┤   (protected by Task 1; uses the engine)
                                                 │
        ── Checkpoint B ──                       ▼
Task 5  RulesSheet copy                        ─┐
Task 6  docs/ledger.md write contract + spec  ──┤   (Task 6 describes Tasks 3–5)
                                                 │
        ── Checkpoint C ──                       ▼
Task 7  build dist/ + full verification pass
        ── Checkpoint D ──
```

## Task List

### Phase 1 — Lock the engine (no behavior change)

- [ ] Task 1: `ledger.test.ts` — `assignCategory`, `bestMatchingRule`, `upsertRule`, `refreshCategories`
- [ ] Task 2: Extend `fingerprint.test.ts` with an `extractMerchant` corpus table

### Checkpoint A

- [ ] `npm test` green with the new cases; `git diff --stat` shows test files only
- [ ] Any behavior a test pins that looks *wrong* is noted in this plan's Open Questions, not fixed

### Phase 2 — Derivation path

- [ ] Task 3: `loadSnapshot` runs `refreshCategories`
- [ ] Task 4: `scripts/omakei-categorize.mjs` + `scripts/omakei-categorize.test.mjs`

### Checkpoint B

- [ ] `npm test`, `npm run typecheck`, `npm run lint` green
- [ ] Manual (`dev:isolated`): hand-add a rule to `.dev/state/…/omakei-ledger.json`, reload → rule applies with no folder attached
- [ ] Manual: `node scripts/omakei-categorize.mjs "national-chain" groceries` against an isolated ledger re-tags matching rows; a second identical run is a no-op; `--list` prints uncategorized merchants; `--dry-run` writes nothing

### Phase 3 — Truthful UI + the contract

- [ ] Task 5: `RulesSheet` copy — remove the unreachable add-form / regex claims
- [ ] Task 6: `docs/ledger.md` "Writing back" section; reconcile `docs/spec/categorization.md`

### Checkpoint C

- [ ] `node scripts/check-no-personal-data.mjs` exit 0
- [ ] `docs/ledger.md`, `docs/spec/categorization.md`, and `RulesSheet` agree with what shipped
- [ ] `docs/spec/categorization.md` "What changes from today" rows are all struck or moved to Open Questions

### Phase 4 — Build + verify

- [ ] Task 7: `npm run build`, stage `dist/` + `dist/.build-hash`, full suite pass

### Checkpoint D — Complete

- [ ] Every acceptance criterion checked
- [ ] `npm test` + `npm run typecheck` + `npm run lint` + `npm run build` all green
- [ ] Pre-commit `check-dist-fresh` passes
- [ ] Specs match behavior; ready for PR

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `node --test scripts/**/*.test.mjs` (no strip flag) can't import the `.ts` engine transitively | Med — kills the script's single-source-of-truth design | **Pre-verified** on this Node (v26): plain and `--test` both import `.ts` fine. Task 4 does this import first; fallback is a dedicated `npm test` entry with `--experimental-strip-types` for that one file. |
| Editing `ledger-api.mjs` destabilises the session (memory: crashed 5× on in-tree reverts) | High | Script does **not** import mutating internals; own atomic write; only pure helpers imported. No edits to `ledger-api.mjs`. |
| `loadSnapshot` re-derive changes categories on an existing ledger (improved defaults, or a stale hand-set value) | Low | Desired behavior (rule 5: trust `categoryId`, but it's derived from rules+defaults). Task 1 pins `refreshCategories` idempotency on already-derived input. Note in `docs/ledger.md`. |
| `extractMerchant` characterization reveals mis-grouping | Low | Task 2 records current output as the baseline; a fix is a separate spec item (categorization OQ4). |
| Script re-derive omits `seedRules()` and blanks every default category | Med | Script mirrors `parseLedgerData`: `rules = [...userRules, ...seedRules()]` before `refreshCategories`. Test asserts a default-categorized row survives a script run that touched an unrelated rule. |
| Concurrent write with an open editor tab | Low | Documented constraint (editor closed / reload). Not solved in code. |
| `dist/` not rebuilt after Tasks 3 & 5 touch `src/` | Med | Task 7; pre-commit `check-dist-fresh` is the backstop. |

## Open Questions

1. **Script surface.** Plan assumes `omakei-categorize.mjs` does: `<pattern>
   <categoryId>` (add/update), `--remove <pattern>`, `--list` (uncategorized
   merchants by absolute total, like `unknownMerchants`), `--dry-run`. Leaner
   (add/update only) or is `--list` worth it? _Recommend: keep `--list` — it's
   the agent's entry point and reuses `unknownMerchants`/`extractMerchant`._

2. **"Just this one" recategorize (spec OQ5).** `transaction-row.tsx` always
   writes a merchant-wide rule. _Recommend: document the behavior in `RulesSheet`
   / spec (Task 5/6), do **not** build a per-transaction override — it needs a
   ledger-shape concept (`source:"manual-tx"`) that "lean on the agent" says we
   don't want._ Confirm.

3. **Confirmed-vs-guess marker (spec OQ1).** _Recommend: deferred, not in this
   plan._ Confirm.

4. **`docs/ledger.md` vs a new doc.** The write contract could live in
   `docs/ledger.md` (currently read-only) or a sibling `docs/ledger-write.md`.
   _Recommend: a "Writing back" section in `docs/ledger.md` — one file for the
   whole ledger contract._

## Definition of Done (every task)

`npm test` + `npm run typecheck` + `npm run lint` green; no regressions; behavior
verified at runtime via `dev:isolated`; `dist/` rebuilt if `src/` changed; the
relevant spec/doc updated in the same change.
