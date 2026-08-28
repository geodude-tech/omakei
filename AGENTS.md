# Omakei

Omarchy bar widget for monthly spend vs income, plus the local ledger editor it opens.

One tree holds both: the shell-loaded widget files at the root, and the editor around them. `omarchy plugin add` clones this repository, so everything here ships to installers.

## Shape

The editor is a static SPA served by `scripts/omakei-serve.mjs`. `dist/` is committed on purpose: the installer clones the git tree and never runs `npm install`, so the build has to be in the tree already. The server has no npm dependencies, and `scripts/omakei-open` starts it on demand when the widget opens Omakei.

**The server owns the attached folder.** `scripts/ledger-api.mjs` is the one place that touches disk — it remembers which folder is attached, lists and reads the statements in it, and writes `omakei-ledger.json` back. The browser has no filesystem of its own and no cached copy of the ledger.

Both the Vite dev server and `omakei-serve.mjs` mount that same handler, so development and an installed plugin run identical disk code. Anything that only one of them can do is a bug: that split is what let an earlier version ship a data path nobody exercised by hand.

Because the server knows the folder's real path, it records it in `~/.local/state/omakei/state.json`, and `Panel.qml` reads the ledger from there. That file's shape is part of the plugin contract. Nobody should have to type a ledger path into widget settings; the `ledgerPath` setting exists only to override the recorded one.

## Rebuilding dist

Rebuild and commit `dist/` whenever a build input changes. `npm run build` stamps `dist/.build-hash` with the git blob hashes of those inputs, and the pre-commit hook fails if the staged `dist/` was built from anything else — a forgotten build otherwise ships new source with the old UI, and `npm run dev` never reads `dist/` so nothing catches it locally. Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

Build inputs are listed in `scripts/build-inputs.mjs`. Tests are excluded; QML and the server scripts ship as source, except `page-shell.mjs`, whose class names Tailwind scans. Dependency bumps are not tracked, so rebuild by hand after changing `package.json`.

## Product

- The installable product is the widget. README is for widget install and use, not app or development setup.
- Shell-loaded files at the repo root: `manifest.json`, `BarWidget.qml`, `Panel.qml`, `Model.js`. `omarchy plugin add` clones the public git tree; never put `node_modules` in a plugin install (symlinks fail validation).
- Daily viewing stays in the bar popup. Attaching a folder, one-off imports, rules, and the full activity table stay in the editor. Do not rebuild those flows inside the popup.
- Tailwind's sources are pinned in `src/styles.css` (`source(none)` plus explicit `@source`). Auto-detection would scan the committed `dist/`, so each build would find the previous bundle's class names and the CSS would grow every time. Add an `@source` line for any new file that emits class names into the HTML.
- The bundle carries neither a theme nor data. `dist/index.html` keeps `<!--omakei:head-->` and `<!--omakei:state-->` placeholders that `scripts/page-shell.mjs` fills per request with the user's Omarchy theme and their ledger, so one committed build looks right on every machine and paints real numbers on the first frame.
- Serve on `127.0.0.1` only, and keep the Host and Origin guards in `ledger-api.mjs`. This is a personal ledger; nothing else on the network — or in the user's browser — may reach it.
- Time-to-display, time-to-save, and sync must stay immediate. There is no sample/dummy ledger.
- Persist `omakei-ledger.json` compactly, through a temp file and a rename. Batch statement merges in one pass; do not yield to the UI between files.

## Data

- Personal statements and `omakei-ledger.json` are gitignored. Never commit them.
- Never put personal data in tests, fixtures, comments, or default rules: no household-specific merchants, account numbers, balances, addresses, or family names. Invent neutral values; a test that needs a merchant should use a well-known national chain.
- Statement file extensions are gitignored, so parser fixtures are **inline strings** in `parse.test.ts`, never files.
- No default ledger path. Nothing is attached until the user picks a folder.
- Optional dev convenience: `OMAKEI_STATEMENTS_DIR` in `.env.local` (see `.env.example`) seeds the same state an attach would write.

## Commands

- `npm test` — finance and script tests, no-statements check, plugin check
- `npm run typecheck`
- `npm run dev` — ledger editor at http://127.0.0.1:8080/ (live theme reload)
- `npm run build` — writes `dist/`; commit the result
- `npm run start` — serve the committed `dist/` the way installers do

## Style

- Match existing QML and React patterns.
- `Model.js` is QML-compatible ES5 (no modules, no modern syntax the QML JS engine rejects). It is linted under its own ESLint block.
- Relative imports inside `src/` carry explicit `.ts`/`.tsx` extensions, so any module can be run directly by `node --experimental-strip-types` in a test.
