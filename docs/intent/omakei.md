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
- **Constraint:** Fast and boring. Basic beats fancy. Local-first: by default
  nothing leaves the machine, and the ledger on your laptop is the source of
  truth. The one exception is the opt-in Grok-hosted mode below, which you have
  to turn on yourself.

## Out of scope

- **Any AI interface inside the app.** No chat UI, no model calls, no API key.
  The agent lives in the terminal — Claude Code or any other harness — and points
  at the ledger. The app stays deliberately dumb.
- **Auto-pulling statements from banks in the default mode.** On the laptop,
  you still drop exports into a folder. A bank connection is in scope only as
  part of the opt-in Grok-hosted mode below.
- **The bar widget as the thing being built.** It stays — it is the hook, and the
  reason Omarchy is the right beachhead. It stops driving design decisions.

## Optional: Grok-hosted mode

_Added 2026-10-09._ In scope, opt-in, never the default.

The ledger and the categorizing can run on your Grok Bot machine instead of
your laptop, and that ledger can be fed by a bank connection added through the
bot. It's the same code with no app on top: the bot runs Omakei's scripts
there. Anyone who turns it on must be told plainly where their data goes:

**What leaves your machine in Grok-hosted mode with a bank connection:**

- Your bank sends your account data to the bank-connection provider (for
  example Plaid), which passes it on to the Grok Bot service and the bot's
  machine. That data includes transaction dates, amounts, merchant names and
  descriptions, account names and, usually, the last 4 digits of the account
  number, plus balances (and, for cards and loans, details like the payment due).
  If you link investment accounts, it also includes holdings and trades.
- The ledger and your categories are stored on the bot's machine, not your laptop.
- Any statement files you send the bot (by email or chat) are stored there too.
- The questions you ask and the bot's answers go through the Grok service.

**In the default laptop mode:**

- Your statements, the ledger file, and your categories stay on your laptop.
  Omakei itself uploads nothing and has no account. Its one outside request is
  the dashboard page loading its fonts from Google Fonts, which carries no
  ledger data.
- If you ask an agent about your money (Grok Bot or any other), whatever the
  agent reads goes to that agent's service, along with your questions and its
  answers. Usually that is the summaries or the rows it asked for. An agent
  that opens the ledger or a statement file sends what it read from that file.

There's also a mixed setup: the ledger stays on the laptop, but the bot pulls
from a bank connection and passes the rows along. In that setup your bank data
goes through the provider and the bot on the way, even though the ledger lives
only on your laptop. Say so when you set it up.

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

- ~~**SQLite.**~~ _Decided 2026-09-14: the ledger is `omakei-ledger.sqlite`._
  Decided on the grounds this asked for, not performance. What JSON could not
  give: the query rules live in the file as `spend` / `income` / `uncategorized`
  views and a `categories` table, so an agent's `SELECT` gets the dashboard's
  number; and the two writers (the server and `omakei-categorize.mjs`) share a
  real write lock, closing a lost-update window the JSON could only narrow. See
  `docs/spec/ledger-sqlite.md`.
- ~~**Whether the panel contract must serve other people's forks.**~~ _Decided
  2026-08-27:_ panels are build-time `.tsx` in a dev clone. Installed plugin users
  cannot add panels without cloning. Runtime-loaded panels were rejected — they
  would mean executing code out of the statements folder, and would cost TS, JSX,
  and the component library. See `docs/spec/panel-contract.md`.
- **Push vs. pull.** The Simplifi complaint was about missing verdicts ("spending
  habits are increasing"), not missing charts. A nudge may just be a panel that
  renders a sentence.
