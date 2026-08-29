# Spec: Build and Distribution

_Status: documents existing behavior as of 2026-08-28. Traces to `docs/intent/omakei.md`._

## Objective

Ship one git tree that is both the plugin an Omarchy user installs and the dev
clone an agent extends. `omarchy plugin add` clones the repository and never runs
`npm install`, so the built editor (`dist/`) is committed, and the shell-loaded
QML runs as source. The build's job is to keep the committed `dist/` honest —
built from exactly the sources beside it — and to inject per-machine theme and
per-request data that a one-time build cannot carry.

The intent notes this "taxes the loop, but less than it looks": a new file under
`src/` is already scanned and hashed, so adding a panel costs `npm run build`
plus committing `dist/`. This spec records why the pipeline is shaped this way so
nobody re-litigates it.

**User:** an agent adding a panel or editing the editor, who must rebuild and
commit `dist/`; and the installer, who gets a working editor with no build step.

**Success:**

- A fresh clone or a branch switch does not read as "stale `dist/`".
- Committing a source change without rebuilding `dist/` fails the pre-commit hook
  with an actionable message.
- The committed `dist/` carries no theme and no ledger; both are filled per
  request, so one build looks right on every machine and paints real numbers on
  the first frame.
- `omarchy-plugin-validate` passes on the shell files as an installer would see
  them (no `node_modules`, no symlinks).

## Tech Stack

Vite 8 (build), Tailwind 4 with `@tailwindcss/vite`, `lightningcss`. Staleness
detection is git blob hashes via `git hash-object` / `git ls-files -s` — no
mtimes, no content hashing of our own. The `dist/` server and hooks are Node
standard library only.

## Commands

```
Build:       npm run build     # vite build + node scripts/stamp-build.mjs
Serve dist:  npm run start
Test:        npm test          # includes check-panels, check-plugin (indirectly guards the contract)
Enable hook: git config core.hooksPath .githooks     # once per clone
Force past:  git commit --no-verify                  # when a commit deliberately leaves dist/ alone
```

## Project Structure

```
dist/                          → committed. The built editor. .build-hash records what it was built from
index.html                     → carries <!--omakei:head--> and <!--omakei:state--> placeholders
vite.config.ts                 → build config; mounts the ledger-api and html plugins on the dev server
scripts/build-inputs.mjs       → BUILD_INPUT_PATHS, hashWorkingTree(), hashIndex()
scripts/stamp-build.mjs        → writes dist/.build-hash after a build
scripts/check-dist-fresh.mjs   → pre-commit: staged dist/ must match staged sources
scripts/page-shell.mjs         → renderShell(): theme + inline state injection (prod)
scripts/omakei-html-plugin.mjs → the same injection on the dev server; no-op during build
src/styles.css                 → Tailwind sources: source(none) + explicit @source lines
.githooks/pre-commit           → check-no-statements, check-no-personal-data --staged, check-dist-fresh
```

## Behavior this spec fixes in place

### Build inputs

`BUILD_INPUT_PATHS = ["src", "index.html", "vite.config.ts", "scripts/page-shell.mjs"]`.
`*.test.*` is excluded. QML and the server scripts ship as source and are **not**
inputs — except `page-shell.mjs`, whose class names Tailwind scans. Dependency
bumps are not tracked; rebuild by hand after changing `package.json`.

### Staleness = git blob hash mismatch

`hashWorkingTree()` (build time) runs `git hash-object` over the tracked input
files as they are on disk. `hashIndex()` (pre-commit) reads the index's own blob
hashes. The two agree exactly for unmodified files, so a fresh clone or a branch
switch is not "stale". `stamp-build.mjs` writes the working-tree hash to
`dist/.build-hash`; `check-dist-fresh.mjs` fails the commit unless the staged
stamp equals the staged-sources hash.

### The new-file trap

The stamp hashes files **git is tracking**. A `npm run build` run while a new
panel/component is still untracked stamps a hash that omits it, and the hook then
rejects the commit. Workflow: `git add` the new file **before** `npm run build`.
(`src/panels/README.md` and the ledger-contract spec both call this out.)

### `dist/` carries neither theme nor data

The build leaves both `<!--omakei:head-->` and `<!--omakei:state-->` in
`index.html`. `omakei-serve.mjs` fills them per request via `renderShell` — the
user's live Omarchy theme, and `<script>window.__OMAKEI_STATE=…</script>` with
the ledger — so one committed build looks right everywhere and the first frame
has real numbers. The dev server does the same via `omakei-html-plugin.mjs`,
which is a no-op when `config.command === "build"`.

### Tailwind sources are pinned

`src/styles.css` uses `source(none)` plus explicit `@source`. Auto-detection
would scan the committed `dist/` and re-find the previous bundle's class names,
so the CSS would grow every build. `@source "./"` already covers all of `src/`,
so a new component or panel needs no change; add an `@source` line only for a
file **outside** `src/` that emits class names (as `page-shell.mjs` does).

### Plugin shape

`check-plugin.mjs` copies `manifest.json`, `BarWidget.qml`, `Panel.qml`,
`Model.js` to a clean temp dir and runs `omarchy-plugin-validate` (skipped when
the validator is not on `PATH`). Never put `node_modules` in a plugin install —
symlinks fail validation.

## Testing Strategy

- `check-dist-fresh.mjs` in the pre-commit hook is the guard. There is no unit
  test of `build-inputs.mjs` itself; its correctness is observable — a stale
  commit is refused.
- `check-panels.mjs` and `check-plugin.mjs` run in `npm test` and keep the
  panel/plugin shapes valid (the panel one is detailed in `panel-contract.md`).
- `omarchy-theme.test.mjs` covers the theme loader that `page-shell.mjs` uses.
- Round-trip verification (build → commit → `npm run start` looks right) is a
  manual step after any input change.

## Boundaries

**Always:**
- Rebuild and commit `dist/` whenever a `BUILD_INPUT_PATHS` file changes.
- `git add` a brand-new source file before `npm run build`.
- Keep `dist/` free of theme and data — inject per request.
- Keep the dev server and `omakei-serve.mjs` doing identical injection.

**Ask first:**
- Adding a path to `BUILD_INPUT_PATHS`.
- Changing the staleness mechanism (mtimes, content hashes) — the git-blob
  approach is deliberate.
- Un-committing `dist/` or introducing a build step for installers.

**Never:**
- Turn on Tailwind source auto-detection.
- Put `node_modules` or a symlink in the shell-loaded file set.
- Bake a machine's theme or anyone's ledger into `dist/`.

## Success Criteria

Verified against the current tree (2026-08-28).

1. **Met.** `git status` on a fresh checkout of this branch reports `dist/`
   clean — `hashWorkingTree` and the committed stamp agree.
2. **Met.** `check-dist-fresh.mjs` exits 0 when `dist/` matches and non-zero with
   a rebuild instruction otherwise (observed by staging a source-only change).
3. **Met.** `dist/index.html` retains both placeholders after `npm run build`.
4. **Met.** `npm test` runs `check-panels.mjs` and `check-plugin.mjs`.
5. **Met.** `src/styles.css` uses `source(none)` + `@source`, not auto-detection.

## Open Questions

1. **Dependency bumps are untracked.** Changing `package.json` and forgetting
   `npm run build` ships a `dist/` compiled against the old deps, and nothing
   catches it. Adding `package-lock.json` to `BUILD_INPUT_PATHS` would fix it at
   the cost of a rebuild on every lockfile churn.
2. **`--no-verify` is the only escape hatch** and it skips *all three*
   pre-commit guards, including the personal-data scan. A per-check opt-out
   (e.g. `SKIP_DIST_CHECK=1`) would be safer for the "deliberately leaving
   `dist/` alone" case.
3. **No CI runs these checks.** The hook is per-clone and opt-in
   (`git config core.hooksPath`). A push from a clone without the hook enabled
   can land a stale `dist/`. A CI job running `npm test` + `check-dist-fresh`
   against the index would close that.
4. **The 40-hex-char truncated sha256** in `build-inputs.mjs` is well short of
   collision concern but is an unexplained constant.
