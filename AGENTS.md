# Omakei

Omarchy bar widget for monthly spend vs income, plus an optional local ledger editor.

One tree holds both: the shell-loaded widget files at the root, and the companion ledger editor around them. `omarchy plugin add` clones this repository, so everything here ships to installers.

The editor is a static SPA. `dist/` is committed on purpose: the installer clones the git tree and never runs `npm install`, so the build has to be in the tree already. `scripts/omakei-serve.mjs` serves it with no npm dependencies, and `scripts/omakei-open` starts that server on demand when the widget opens Omakei.

Rebuild and commit `dist/` whenever a build input changes. `npm run build` stamps `dist/.build-hash` with the git blob hashes of those inputs, and the pre-commit hook fails if the staged `dist/` was built from anything else — a forgotten build otherwise ships new source with the old UI, and `npm run dev` never reads `dist/` so nothing catches it locally. Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

Build inputs are listed in `scripts/build-inputs.mjs`. Tests are excluded; QML and the server scripts are not inputs because they ship as source. Dependency bumps are not tracked either, so rebuild by hand after changing `package.json`.

## Product

- The installable product is the widget. README is for widget install and use, not app or development setup.
- Shell-loaded files at the repo root: `manifest.json`, `BarWidget.qml`, `Panel.qml`, `Model.js`. `omarchy plugin add` clones the public git tree; never put `node_modules` in a plugin install (symlinks fail validation).
- Daily viewing stays in the bar popup. Import, folder sync, rules, and the full activity table stay in the web editor (Open Omakei). Do not rebuild those flows inside the popup.
- Tailwind's sources are pinned in `src/styles.css` (`source(none)` plus explicit `@source`). Auto-detection would scan the committed `dist/`, so each build would find the previous bundle's class names and the CSS would grow every time. Add an `@source` line for any new file that emits class names into the HTML.
- The bundle carries no theme. `dist/index.html` keeps an `<!--omakei:head-->` placeholder that `scripts/page-shell.mjs` fills per request with the user's Omarchy theme, so one committed build looks right on every machine.
- Serve on `127.0.0.1` only. This is a personal ledger; it must never be reachable from the network.
- Time-to-display, time-to-save, and sync must stay immediate. There is no sample/dummy ledger.
- Persist `omakei-ledger.json` compactly. Batch statement merges in one pass; do not yield to the UI between files.

## Data

- Personal statements and `omakei-ledger.json` are gitignored. Never commit them.
- Never put personal data in tests, fixtures, comments, or default rules: no household-specific merchants, account numbers, balances, addresses, or family names. Invent neutral values; a test that needs a merchant should use a well-known national chain.
- No default ledger path. An unset `ledgerPath` resolves to `""` and the widget shows its empty state; the user sets the path by hand in widget settings.
- Dev-only localhost folder: `FOLIO_STATEMENTS_DIR` in `.env.local` (see `.env.example`).

## Commands

- `npm test` — finance tests, no-statements check, plugin check
- `npm run typecheck`
- `npm run dev` — ledger editor at http://127.0.0.1:8080/ (dev server, live theme reload)
- `npm run build` — writes `dist/`; commit the result
- `npm run start` — serve the committed `dist/` the way installers do

## Style

- Match existing QML and React patterns.
- `Model.js` is QML-compatible ES5 (no modules, no modern syntax the QML JS engine rejects).
