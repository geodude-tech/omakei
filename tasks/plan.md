# Implementation Plan: Front-page drop zone for a fresh run

## Overview

On a fresh run (no ledger, no attached folder) Omakei shows three ways to get
data in: a header **Attach folder** button, a big empty-state card **Choose a
folder of statements**, and an **Attach a folder** item in the 3-dot menu. All
three open `FolderPicker` — the server-backed directory browser — which the user
finds heavy for a "do it once" action.

This plan keeps the big front-page card but turns it into a real drop zone that
behaves like the Import sheet's "Drop files, or click to choose" target: a
dashed box with a drag-over state, click-to-choose, **and dropped-folder
support**. Dropping or choosing there imports immediately (toasts only, no
preview — matching a folder sync). The header **Attach folder** affordance is
removed. The server-backed `FolderPicker` stays reachable only from the 3-dot
menu, where "attach a folder for automatic syncing" belongs.

Decisions locked with the user (2026-08-28):

- **Drop behavior:** import immediately, toasts only. No staging preview on the
  front-page path.
- **Attach path:** the `FolderPicker` is reachable only from the 3-dot menu. The
  front page carries no link to it.
- **Click-to-choose picks files, not a folder** — accepted limitation. A whole
  folder goes in by drag, or via the 3-dot menu.
- **Folder attached + zero transactions:** the drop zone stays on screen as a
  one-off import, with copy that also names the folder + sync.
- **PR #5 (`ui-cleanup-and-tests`) is merged** — the `dashboard.tsx` in this plan
  is the post-merge file; no sequencing conflict.

## Architecture Decisions

- **Share one drop-zone component.** Extract the dashed box currently inline in
  `import-sheet.tsx` into `src/components/omakei/statement-dropzone.tsx`. Both
  the Import sheet and the new empty state render it, so "same behavior as
  import" is guaranteed by construction rather than by two copies staying in
  sync. The Import sheet keeps its staging flow; only the box is shared.

- **Folder drops go through the entries API.** `e.dataTransfer.files` does not
  recurse into a dropped directory — a dropped folder currently lands as an
  unreadable zero-byte entry and is silently skipped (true in the Import sheet
  today too). Add a thin DOM helper that walks `DataTransferItem.webkitGetAsEntry()`
  recursively into `File[]`, each file carrying its folder-relative path. Keep
  the DOM traversal minimal; extract the path/string logic to a tested `.ts`.

- **Click chooses files, not a folder.** One `<input>` cannot be both `multiple`
  and `webkitdirectory`. Click opens a multi-file picker; a whole folder goes in
  by drag, or via the 3-dot menu's `FolderPicker`. Documented as a known
  limitation rather than adding a submenu.

- **Front-page import reuses `importAndSave` + `parseDroppedFiles`.** The same
  merge path a folder sync uses, so duplicates are skipped identically. Toast
  copy is factored into one `toastImport(summary)` in `sync.ts` and used by both
  the empty state and `ImportSheet.commit`.

- **Account-kind for folder imports.** `kindFromLocalPath` reads the *top* path
  segment (`Mortgage/`, `Credit/`…). A dragged or `webkitdirectory`-chosen
  folder puts the *picked folder's own name* in that position
  (`MyStatements/Credit/aug.csv`). `parseDroppedFiles` strips the single leading
  container segment for folder-sourced files so `Credit/aug.csv` still resolves
  to `credit`. `kindFromLocalPath` itself is unchanged (statement-import spec
  boundary: "Ask first" before changing kind heuristics).

- **Header Sync button.** The combined Sync/Attach `ResponsiveAction` renders
  only when a folder is attached (label always "Sync"). With no folder there is
  nothing to sync and attach has moved, so the button is gone on a fresh run.

## Dependency Graph

```
toastImport(summary)  ─┐   (sync.ts, trivial extract)
                       │
statement path logic  ─┤   (statements.ts: strip leading container segment; tested)
                       │
dropped-entries DOM helper ─┐
                            │
                statement-dropzone.tsx  (shared box: drag state, click→input, folder recursion)
                    │            │
      ImportSheet uses it   Dashboard empty state uses it
      (behavior unchanged)       │
                                 ├─ imports via parseDroppedFiles → importAndSave → toastImport
                                 └─ header "Attach folder" affordance removed; Sync gated on `folder`
                                        │
                                 specs updated (dashboard-app.md, statement-import.md) + dist rebuilt
```

Bottom-up: helpers first, then the shared component proven in its current home
(Import sheet), then the empty state, then the header trim, then docs + build.

## Task List

### Phase 1 — Foundation (helpers, no UI change)

- [ ] Task 1: Fold folder-relative paths into `parseDroppedFiles`
- [ ] Task 2: Extract `toastImport(summary)` in `sync.ts`

### Checkpoint A

- [ ] `npm test` green (new `statements.test.ts` cases pass), `npm run typecheck` clean
- [ ] No UI behavior changed yet — Import sheet and dashboard identical to before

### Phase 2 — Shared drop zone

- [ ] Task 3: `statement-dropzone.tsx` — shared box with folder-drop support
- [ ] Task 4: `ImportSheet` renders `StatementDropzone` (staging flow unchanged)

### Checkpoint B

- [ ] Manual: Import sheet — drop loose files, drop a folder, click-to-choose all
      stage the same previews; drag-over highlight still works
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean

### Phase 3 — Front page

- [ ] Task 5: Empty-state card becomes `StatementDropzone`, imports immediately
- [ ] Task 6: Remove the header **Attach folder** affordance; gate Sync on `folder`

### Checkpoint C

- [ ] Manual (fresh run, no folder): empty-state box accepts a dropped folder and
      a click-to-choose set; ledger fills; toasts read
      "N added · M duplicates skipped"; header shows no Sync/Attach button
- [ ] Manual: 3-dot menu → "Attach a folder" still opens `FolderPicker` and the
      full attach + sync path still works; once attached, header shows "Sync"
- [ ] Manual: with a folder attached but zero transactions, the box still works
      as a one-off import
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean

### Phase 4 — Docs + build

- [ ] Task 7: Update `docs/spec/dashboard-app.md` and `docs/spec/statement-import.md`
- [ ] Task 8: `npm run build`, stage new files first, commit `dist/`

### Checkpoint D — Complete

- [ ] All acceptance criteria met
- [ ] `dist/` rebuilt from the final source (pre-commit `check-dist-fresh` passes)
- [ ] Specs match behavior
- [ ] Ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `webkitGetAsEntry` traversal is DOM-only, hard to unit-test | Low | Keep traversal ~15 lines; put the testable string logic (statement filter, leading-segment strip) in `statements.ts` with tests. Verify traversal by hand at Checkpoint B. |
| Importing with no preview means a mis-guessed account kind lands silently | Low (user chose this) | Wrong kind is still correctable afterward via rules / re-import; `kindFromLocalPath` covers the common `Credit/` `Mortgage/` folder layout. Note in the spec. |
| Removing the header button changes a documented surface | Low | `dashboard-app.md` is updated in the same change (Task 7). |
| `resync()` still has a `!folder → open picker` branch after the button is gone | Low | Task 6 removes the dead branch; grep for other `resync` callers first. |
| Drop handler on the empty-state box could swallow page drops | Low | Scope `onDrop`/`onDragOver` to the box element, not the page. |

## Open Questions

_All resolved with the user (2026-08-28) — see "Decisions locked" above._
