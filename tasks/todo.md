# Todo: Front-page drop zone for a fresh run

Plan: `tasks/plan.md`. Work top to bottom; stop at each checkpoint for review.

Open questions all resolved (2026-08-28): PR #5 merged (no conflict);
click-to-choose = files only (folder by drag / menu); drop zone stays on the
folder-attached zero-transaction state.

Build note: the pre-commit hook runs `check-dist-fresh`, so every task commit
that touches a build input (`src/**` non-test, `index.html`, `vite.config.ts`,
`scripts/page-shell.mjs`) rebuilds `dist/` and stages it in the same commit
(`npm run build` is <1s). Task 8 is therefore just a final full-suite +
end-to-end pass, not a separate build commit.

---

## Task 1: Fold folder-relative paths into `parseDroppedFiles` — DONE (37b8183..)

**Description:** Make `parseDroppedFiles` handle files that arrive with a
folder-relative path (from a dragged folder or a `webkitdirectory` input), so the
single leading container segment the browser prepends does not defeat
`kindFromLocalPath`. A file at `MyStatements/Credit/aug.csv` must resolve to
account kind `credit`, same as the server-path case does for `Credit/aug.csv`.

**Acceptance criteria:**
- [ ] `parseDroppedFiles` strips exactly one leading path segment when a file's
      relative path has 2+ segments; a bare `aug.csv` is untouched.
- [ ] A folder-relative `X/Credit/aug.csv` yields `accountKind: "credit"`.
- [ ] `kindFromLocalPath` is not modified.
- [ ] Non-statement files (`.pdf`, dotfiles) are still filtered out.

**Verification:**
- [ ] Tests pass: `node --experimental-strip-types --test src/lib/finance/statements.test.ts`
- [ ] Full: `npm test`
- [ ] Typecheck: `npm run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/lib/finance/statements.ts`
- `src/lib/finance/statements.test.ts`

**Estimated scope:** S (1–2 files)

---

## Task 2: Extract `toastImport(summary)` in `sync.ts` — DONE

**Description:** Move the "N added · M duplicates skipped" + "K still need a
category" toast block out of `ImportSheet.commit` into a `toastImport(summary:
ImportSummary)` export in `sync.ts`, next to `toastSync`. `ImportSheet.commit`
calls it. No copy changes.

**Acceptance criteria:**
- [ ] `toastImport` lives in `sync.ts` and is exported.
- [ ] `ImportSheet` imports and calls it; its visible toasts are unchanged.
- [ ] Singular/plural "duplicate(s)" handling preserved.

**Verification:**
- [ ] `npm test`, `npm run typecheck`, `npm run lint`
- [ ] Manual: import a file via the Import sheet — same toasts as before.

**Dependencies:** None

**Files likely touched:**
- `src/lib/finance/sync.ts`
- `src/components/omakei/import-sheet.tsx`

**Estimated scope:** S

---

### Checkpoint A
- [ ] `npm test` green, `npm run typecheck` clean
- [ ] Import sheet and dashboard behave exactly as before this branch
- [ ] Review with human before Phase 2

---

## Task 3: `statement-dropzone.tsx` — shared box with folder-drop support

**Description:** New `src/components/omakei/statement-dropzone.tsx`. Renders the
dashed drop box (the markup currently inline in `import-sheet.tsx`): icon,
primary label, hint line, drag-over highlight, click opens a hidden
`multiple` file input. Adds a DOM helper that recurses dropped directory entries
via `webkitGetAsEntry()` / `readEntries()` into `File[]`. Props:
`onFiles(files: File[]) => void`, plus `label` / `hint` overrides so the two
callers can word it differently. Keep the traversal helper small and colocated;
it takes the `DataTransferItemList` and returns `Promise<File[]>`.

**Acceptance criteria:**
- [ ] Component exports `StatementDropzone` with `onFiles`, optional `label`,
      optional `hint`.
- [ ] Dropping loose files calls `onFiles` with those files.
- [ ] Dropping a folder calls `onFiles` with every file inside it, recursively,
      each carrying its `webkitRelativePath`-style path (folder name + subpath).
- [ ] Click opens a multi-file dialog; choosing files calls `onFiles`.
- [ ] Drag-over adds the same highlight classes as today's Import box.
- [ ] The box is a real `<button>` (keyboard-focusable, Enter/Space opens dialog).
- [ ] `onDrop` / `onDragOver` are scoped to the box, not the document.

**Verification:**
- [ ] `npm run typecheck`, `npm run lint`
- [ ] Manual (wired in Task 4): drop files, drop a folder, click-choose.

**Dependencies:** None (consumed by Tasks 4 and 5)

**Files likely touched:**
- `src/components/omakei/statement-dropzone.tsx` (new — `git add` before any build)

**Estimated scope:** M

---

## Task 4: `ImportSheet` renders `StatementDropzone`

**Description:** Replace the inline dashed-box markup + its `<input>` in
`import-sheet.tsx` with `<StatementDropzone onFiles={stage} />`. The staging
flow (`stage` → `mergePreviews` → preview list → `commit`) is untouched. Folder
drop now works in the Import sheet as a side effect.

**Acceptance criteria:**
- [ ] Import sheet drop box looks and behaves as before for loose files.
- [ ] Dropping or (drag) a folder into the Import sheet stages every statement
      inside it, de-duplicated by `mergePreviews`.
- [ ] The sheet-level `onDrop` on `SheetContent` no longer double-handles (remove
      it if `StatementDropzone` now covers the drop target, or keep it delegating
      to `stage` — pick one, no double-staging).
- [ ] Pasted-CSV path unchanged.

**Verification:**
- [ ] `npm test`, `npm run typecheck`, `npm run lint`
- [ ] Manual: files, folder, paste, drag-over highlight, remove-a-preview.

**Dependencies:** Task 3

**Files likely touched:**
- `src/components/omakei/import-sheet.tsx`

**Estimated scope:** S

---

### Checkpoint B
- [ ] Manual: Import sheet stages loose files, a dropped folder, and
      click-to-choose identically; drag-over highlight intact
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean
- [ ] Review with human before Phase 3

---

## Task 5: Empty-state card becomes `StatementDropzone`, imports immediately

**Description:** In `dashboard.tsx`, replace the `<button onClick={resync}>`
empty-state block with `<StatementDropzone>` wording that includes folders
(e.g. label "Drop your statements or a folder", hint "OFX, QFX, OFC, CSV, or
TSV — or click to choose files"). `onFiles` → `parseDroppedFiles` →
`importAndSave` → `toastImport`; guard against an empty parse result with the
existing "No OFX, QFX, or CSV statements in that drop" message. Keep the
folder-attached variant of the copy (mention the folder + sync).

**Acceptance criteria:**
- [ ] Fresh run: the card is a dashed drop box; dropping a folder or choosing
      files fills the ledger and the card is replaced by the dashboard.
- [ ] Toasts read "N added · M duplicate(s) skipped" and, if any, "K still need
      a category".
- [ ] A drop with no recognizable statements shows the "nothing in that drop"
      toast and leaves the empty state up.
- [ ] `busy`/`syncing` state disables the box while a parse/import is in flight.
- [ ] No preview/staging UI appears on this path.
- [ ] Folder-attached + zero-transaction state still renders a usable box (copy
      names the folder and sync).

**Verification:**
- [ ] `npm test`, `npm run typecheck`, `npm run lint`
- [ ] Manual fresh run per Checkpoint C.

**Dependencies:** Task 3, Task 1 (kind from folder path), Task 2 (`toastImport`)

**Files likely touched:**
- `src/components/omakei/dashboard.tsx`

**Estimated scope:** M

---

## Task 6: Remove the header Attach-folder affordance; gate Sync on `folder`

**Description:** The header's Sync/Attach `ResponsiveAction` renders only when
`folder` is set, and its label is always "Sync" (drop the `folder ? … : "Attach
folder"` ternary and the mobile "Sync statements" fallback stays). Remove the
now-dead `!folder → setPickerOpen(true)` branch in `resync()`. The 3-dot menu
item ("Attach a folder" / "Change folder") and `FolderPicker` wiring are
untouched.

**Acceptance criteria:**
- [ ] Fresh run (no folder): no Sync/Attach button in the header.
- [ ] Folder attached: header shows a "Sync" button that re-reads the folder.
- [ ] 3-dot → "Attach a folder" opens `FolderPicker`; attach + first sync works.
- [ ] `resync()` has no `FolderPicker`-opening path; `grep resync` shows no
      caller relying on it.
- [ ] No unused imports / vars left (`lint` clean).

**Verification:**
- [ ] `npm test`, `npm run typecheck`, `npm run lint`
- [ ] Manual: fresh run, then attach via menu, then Sync.

**Dependencies:** Task 5 (empty state is the fresh-run entry point before this
button goes away)

**Files likely touched:**
- `src/components/omakei/dashboard.tsx`

**Estimated scope:** S

---

### Checkpoint C
- [ ] Manual fresh run: drop a folder → ledger fills → toasts correct → no header
      Sync/Attach button
- [ ] Manual: 3-dot → Attach a folder → picker → attach → sync → header "Sync"
- [ ] Manual: folder attached, no transactions → box still imports one-off
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean
- [ ] Review with human before Phase 4

---

## Task 7: Update the specs

**Description:** Bring the two affected specs in line with the new behavior.

**Acceptance criteria:**
- [ ] `docs/spec/dashboard-app.md`: "No sample ledger" / empty-state section says
      the empty ledger renders a **drop zone** that imports on drop/choose (toasts,
      no preview); the header no longer offers Attach (only Sync, when a folder is
      attached); the `FolderPicker` is menu-only.
- [ ] `docs/spec/statement-import.md`: note that a dragged/chosen **folder** is
      read in the browser via the entries API (the "Dropping a folder …" success
      line is now literally true in the UI, not just via server sync); note the
      leading-container-segment strip; note that the front-page path skips the
      per-file kind preview.
- [ ] Any "798-line dashboard.tsx" / file-count references left accurate or left
      alone (not this change's job).
- [ ] No personal data introduced (scanners pass).

**Verification:**
- [ ] `npm test` (runs `check-no-personal-data`, `check-no-statements`)
- [ ] Re-read both specs end to end for stale claims about the three attach entry
      points.

**Dependencies:** Tasks 5, 6

**Files likely touched:**
- `docs/spec/dashboard-app.md`
- `docs/spec/statement-import.md`

**Estimated scope:** S

---

## Task 8: Rebuild and commit `dist/`

**Description:** `src/` changed, so `dist/` must be rebuilt and committed or the
pre-commit `check-dist-fresh` hook fails and installers ship stale UI.

**Acceptance criteria:**
- [ ] New file `src/components/omakei/statement-dropzone.tsx` is `git add`ed
      **before** running the build (the stamp hashes tracked files only).
- [ ] `npm run build` run; `dist/` and `dist/.build-hash` staged.
- [ ] Pre-commit hook passes (`check-dist-fresh`, `check-no-statements`,
      `check-no-personal-data --staged`).

**Verification:**
- [ ] `npm run build` exits 0
- [ ] `npm run start` serves the built bundle and the fresh-run drop zone works
      end to end
- [ ] `git status` shows `dist/` changes staged alongside the source

**Dependencies:** All prior tasks

**Files likely touched:**
- `dist/**`

**Estimated scope:** S

---

### Checkpoint D — Complete
- [ ] Every acceptance criterion above checked
- [ ] `npm test` + `npm run typecheck` + `npm run lint` + `npm run build` all green
- [ ] Specs match behavior
- [ ] Branch ready for PR / review
