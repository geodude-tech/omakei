# Omakei

A local ledger built from a folder of statements, shaped so an agent can interrogate it, plus a dashboard that agent extends one panel at a time.

The loop this exists to serve: point an agent at the ledger, ask a question, and when the answer is worth watching every day, pin it as a panel. `docs/intent/omakei.md` is the full statement of intent and takes precedence over any framing here.

One tree holds everything: the shell-loaded widget files at the root, and the editor around them. `omarchy plugin add` clones this repository, so everything here ships to installers.

## Shape

The editor is a static SPA served by `scripts/omakei-serve.mjs`. `dist/` is committed on purpose: the installer clones the git tree and never runs `npm install`, so the build has to be in the tree already. The server has no npm dependencies, and `scripts/omakei-open` starts it on demand when the widget opens Omakei.

**The server owns the attached folder.** `scripts/ledger-api.mjs` is the one place that touches disk — it remembers which folder is attached, lists and reads the statements in it, and writes `omakei-ledger.json` back. The browser has no filesystem of its own and no cached copy of the ledger.

Both the Vite dev server and `omakei-serve.mjs` mount that same handler, so development and an installed plugin run identical disk code. Anything that only one of them can do is a bug: that split is what let an earlier version ship a data path nobody exercised by hand.

Because the server knows the folder's real path, it records it in `~/.local/state/omakei/state.json`, and `Panel.qml` reads the ledger from there. That file's shape is part of the plugin contract. Nobody should have to type a ledger path into widget settings; the `ledgerPath` setting exists only to override the recorded one.

## Reading the ledger

`docs/ledger.md` is the contract for querying the ledger from outside the app —
the other half of the loop the panels finish. It states where the ledger lives and
the five rules that make a total correct, the first of which is that
`categoryId === "transfers"` is neither spend nor income. Skipping that one
overstates spending by most of a credit-card payment while leaving net looking
plausible, so the doc exists to be read before the first query, not after a wrong
answer.

`src/lib/finance/ledger-contract.test.ts` parses the doc and compares it to the
code, so a renamed category fails `npm test` rather than misleading an agent.
Keep the doc true; do not duplicate its category table anywhere.

## Panels

Each card on the dashboard is a panel in `src/panels/`, discovered by a glob in
`src/lib/panels/registry.ts`. Adding one means writing **one file** and rebuilding —
there is no registry to append to and no import to add. That property is the whole
point; do not introduce a manifest, an index, or an explicit list.

A panel exports a component and a `meta` (`title`, `span`, `order`), renders the
card's contents rather than the card, and is read-only — it never imports the store.
A panel returning `null` disappears entirely, which is what lets a verdict panel stay
quiet until it has something to say. Each is wrapped in its own error boundary, so a
bad panel costs its own card and nothing else.

`src/panels/README.md` is the contract, written to be read by an agent adding a panel.
Keep it accurate: it is the file that makes the loop work.

Panels are build-time `.tsx` in a dev clone, so an installed plugin user cannot add one
without cloning. That was chosen over runtime-loaded panels, which would mean executing
code out of the user's statements folder. See `docs/spec/panel-contract.md`.

## Rebuilding dist

Rebuild and commit `dist/` whenever a build input changes. `npm run build` stamps `dist/.build-hash` with the git blob hashes of those inputs, and the pre-commit hook fails if the staged `dist/` was built from anything else — a forgotten build otherwise ships new source with the old UI, and `npm run dev` never reads `dist/` so nothing catches it locally. Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

The stamp hashes the files git is **tracking**, so `git add` a brand-new file before building — a build run while it is still untracked stamps a hash that omits it, and the hook then rejects the commit.

Build inputs are listed in `scripts/build-inputs.mjs`. Tests are excluded; QML and the server scripts ship as source, except `page-shell.mjs`, whose class names Tailwind scans. Dependency bumps are not tracked, so rebuild by hand after changing `package.json`.

## Product

- **The product is the ledger and the loop; the widget is one view.** The bar pill is the hook — it is why Omarchy is the right place to ship this, since its users already have an agent on the machine — but it does not drive design decisions. README is for widget install and use, not app or development setup.
- **No AI inside the app.** No chat UI, no model calls, no API key. The agent lives in the user's terminal and reads `omakei-ledger.json` directly. Adding an "ask Omakei" box would be a helpful-looking mistake; the app stays deliberately dumb and fast.
- Shell-loaded files at the repo root: `manifest.json`, `BarWidget.qml`, `Panel.qml`, `Model.js`. `omarchy plugin add` clones the public git tree; never put `node_modules` in a plugin install (symlinks fail validation).
- Daily viewing stays in the bar popup. Attaching a folder, one-off imports, rules, and the full activity table stay in the editor. Do not rebuild those flows inside the popup.
- Tailwind's sources are pinned in `src/styles.css` (`source(none)` plus explicit `@source`). Auto-detection would scan the committed `dist/`, so each build would find the previous bundle's class names and the CSS would grow every time. `@source "./"` already covers everything under `src/`, so a new component or panel needs no change; add an `@source` line only for a file **outside** `src/` that emits class names, as `page-shell.mjs` does.
- The bundle carries neither a theme nor data. `dist/index.html` keeps `<!--omakei:head-->` and `<!--omakei:state-->` placeholders that `scripts/page-shell.mjs` fills per request with the user's Omarchy theme and their ledger, so one committed build looks right on every machine and paints real numbers on the first frame.
- Serve on `127.0.0.1` only, and keep the Host and Origin guards in `ledger-api.mjs`. This is a personal ledger; nothing else on the network — or in the user's browser — may reach it.
- Time-to-display, time-to-save, and sync must stay immediate. There is no sample/dummy ledger.
- Persist `omakei-ledger.json` compactly, through a temp file and a rename. Batch statement merges in one pass; do not yield to the UI between files.

## Data

- Personal statements and `omakei-ledger.json` are gitignored. Never commit them.
- Never put personal data in tests, fixtures, comments, or default rules: no household-specific merchants, account numbers, balances, addresses, or family names. Invent neutral values; a test that needs a merchant should use a well-known national chain.
- Statement file extensions are gitignored, so parser fixtures are **inline strings** in `parse.test.ts`, never files.
- No default ledger path. Nothing is attached until the user picks a folder.
- Optional dev convenience: `OMAKEI_STATEMENTS_DIR` seeds the same state an attach would write. It must be exported in the environment — `OMAKEI_STATEMENTS_DIR=/path npm run dev`. Putting it in `.env.local` does **not** work: Vite does not load `.env` files into `process.env`, and `ledger-api-plugin.mjs` never calls `loadEnv`, so the server never sees it. `.env.example` says otherwise and is wrong.

## Commands

- `npm test` — finance and script tests, ledger-contract check, no-statements check, panel-contract check, plugin check
- `npm run typecheck`
- `npm run dev` — ledger editor at http://127.0.0.1:8080/ (live theme reload)
- `npm run build` — writes `dist/`; commit the result
- `npm run start` — serve the committed `dist/` the way installers do

## Style

- Match existing QML and React patterns.
- `Model.js` is QML-compatible ES5 (no modules, no modern syntax the QML JS engine rejects). It is linted under its own ESLint block.
- Relative imports inside `src/` carry explicit `.ts`/`.tsx` extensions, so any module can be run directly by `node --experimental-strip-types` in a test.
