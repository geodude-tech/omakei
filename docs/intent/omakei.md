# Omakei — Statement of Intent

_Confirmed 2026-08-27._

## What it is

A local ledger built from a folder of statements, shaped so any agent harness can
interrogate it — and a dashboard the agent extends, one panel per insight that
earned its keep.

Omakei is not a finance app with a dashboard. The dashboard is a cache of the
questions that turned out to be worth watching every day. The loop is:

    statements in a folder
      -> ledger
        -> ask an agent a question
          -> the answer is useful
            -> the agent writes a panel
              -> the panel is now part of the app

## Intent

- **Outcome:** A local ledger any agent harness can interrogate, plus a dashboard
  the agent extends with each insight worth keeping.
- **User:** Andrew first. Then Omarchy users, who happen to be the rare audience
  that already has an agent pointed at their own machine.
- **Why now:** Quicken Simplifi held the statements and never once said "pump the
  brakes on restaurants until next month." The data was there; the verdict wasn't.
- **Success:** Ask an agent a question, get an answer from the ledger, say "pin
  it," and a panel appears — without hand-writing React or fighting the build.
- **Constraint:** Fast and boring. Basic beats fancy. Nothing leaves the machine.

## Out of scope

- **Any AI interface inside the app.** No chat UI, no model calls, no API key.
  The agent lives in the terminal — Claude Code or any other harness — and points
  at the ledger. The app stays deliberately dumb.
- **Auto-pulling statements from banks.** Wanted eventually, explicitly farther
  out. Today the user drops exports into a folder.
- **The bar widget as the thing being built.** It stays — it is the hook, and the
  reason Omarchy is the right beachhead. It stops driving design decisions.

## Consequences

Three things follow from this that were not true before:

1. **The product inverts.** `docs/agents.md` currently says "the installable product is
   the widget." That is backwards under this intent, and it is the source of the
   existing strain: ~4,700 lines of editor sitting behind a doc defending four
   widget files. The product is the ledger and the loop; the widget is one view.

2. **The panel contract becomes the central design problem.** There is no
   extension point today — `src/components/omakei/dashboard.tsx` is a single
   798-line file with cards written inline as JSX. An agent cannot add to that
   safely. The design target shifts from "easy for a human to click" to "easy for
   an agent to write into without breaking anything": a stable schema, a panel
   contract, a place to drop a file.

3. **The build pipeline taxes the loop, but less than it looks.** Committed
   `dist/`, the `dist/.build-hash` pre-commit hook, and Tailwind's pinned
   `@source` lines exist to serve plugin distribution (installers clone the tree
   and never run `npm install`). The tax on adding a panel is smaller than first
   assessed: `src/styles.css` declares `@source "./"`, and `BUILD_INPUT_PATHS`
   includes `"src"` wholesale, so a new file under `src/` is already scanned and
   already hashed. Adding a panel costs `npm run build` plus committing `dist/` —
   two steps an agent runs trivially. Not a blocker; noted so nobody re-litigates it.

## Open, not yet decided

- **SQLite.** Raised as a performance question; performance is not the reason.
  Ten years of transactions is ~30k rows — single-digit MB of JSON, parsed in
  milliseconds. The real argument for SQLite is that an agent writes SQL, and a
  queryable ledger is a more legible substrate than a JSON blob. Decide on those
  grounds.
- ~~**Whether the panel contract must serve other people's forks.**~~ _Decided
  2026-08-27:_ panels are build-time `.tsx` in a dev clone. Installed plugin users
  cannot add panels without cloning. Runtime-loaded panels were rejected — they
  would mean executing code out of the statements folder, and would cost TS, JSX,
  and the component library. See `docs/spec/panel-contract.md`.
- **Push vs. pull.** The Simplifi complaint was about missing verdicts ("spending
  habits are increasing"), not missing charts. A nudge may just be a panel that
  renders a sentence.
