# Spec: Dashboard App

_Status: documents existing behavior as of 2026-08-28. Traces to `docs/intent/omakei.md`._

## Objective

The editor SPA: a single page that shows one month of the ledger — spend, income,
net after set-asides, the panels an agent has pinned, the merchants that still
need a category, and the full activity table — and lets the user attach a folder,
run one-off imports, edit categorize rules, and adjust set-asides.

Under the intent, this is "one view" of the product, not the product. The
design target is "fast and boring": it must paint real numbers on the first
frame and never make the user wait. It carries **no AI surface** — no chat, no
model calls, no API key — by decision, not omission.

**User:** Andrew, and Omarchy users who opened the editor from the bar popup.
They arrive with a month in mind (`?m=YYYY-MM` from the widget) and expect the
numbers to already be there.

**Success:**

- First paint shows the four stat tiles with real figures — no spinner, no fetch
  — because the server inlined the ledger into the HTML.
- The chart, the panels, the "needs a category" list, and the activity table
  appear a frame later and never delay the stat row.
- Every edit (set-aside, category, rule, import, clear) writes back to the
  attached folder within ~32 ms, debounced, and flushes on tab-hide/blur.
- The month shown matches `?m=` if present, else the ledger's `selectedMonth`,
  else the newest month with data.
- The four stat figures agree with `docs/ledger.md`'s worked example and with
  what the bar popup shows for the same month.

## Tech Stack

React 19, TypeScript 5.7, Vite 8, Tailwind 4, Zustand 5, shadcn/ui primitives
under `src/components/ui/`, `sonner` for toasts, `lucide-react` for icons. No new
dependencies (also a panel-contract boundary).

## Commands

```
Dev:       npm run dev            # 127.0.0.1:8080, live theme reload
Dev (safe): npm run dev:isolated  # against .dev/, not your real ledger
Build:     npm run build          # writes dist/, commit it
Test:      npm test               # summaries, drift, set-asides, opening-month, grid, paginate, chart
Typecheck: npm run typecheck
Lint:      npm run lint
```

## Project Structure

```
src/main.tsx                            → mount
src/components/omakei/dashboard.tsx      → the page: header, stat row, sections, dialogs
src/components/omakei/stat.tsx           → a stat tile
src/components/omakei/set-aside-stat.tsx → editable set-aside tile + "Add" cell
src/components/omakei/needs-category.tsx → the uncategorized-merchant list
src/components/omakei/transaction-row.tsx, pager.tsx → the activity table's parts
src/components/omakei/import-sheet.tsx   → one-off file / pasted-CSV import
src/components/omakei/statement-dropzone.tsx → shared drop box (files + dropped folder), used by the sheet and the empty state
src/components/omakei/rules-sheet.tsx    → view/delete categorize rules
src/components/omakei/folder-picker.tsx  → server-backed directory picker (3-dot menu only)
src/components/omakei/daily-spend-chart.tsx, category-select.tsx
src/lib/finance/dropped-entries.ts → walk a drag-and-drop (incl. folders) into a flat File[]
src/lib/finance/boot.ts     → startup: inline state → store, then background sync
src/lib/finance/store.ts    → the Zustand ledger store (in memory; the file is the only durable copy)
src/lib/finance/ledger-file.ts → snapshot shape + the 32 ms save debounce
src/lib/finance/summaries.ts → monthSummary, categoryTotals, dailySpend (tested; panels can't be)
src/lib/finance/drift.ts    → categoryDrift (feeds the "drifting up" panel)
src/lib/use-flush-on-hide.ts → flush the debounce on visibilitychange
```

## Code Style

Derived views are pure functions in `src/lib/finance/`, tested there because
`.tsx` cannot be strip-typed. Components call them through `useMemo`:

```ts
export function monthSummary(rows: Transaction[], setAsides: SetAside[]): MonthSummary {
  let spent = 0, income = 0, uncategorized = 0;
  for (const tx of rows) {
    if (isSpend(tx)) spent += Math.abs(tx.amount);   // isSpend excludes transfers
    if (isIncome(tx)) income += tx.amount;
    if (!tx.categoryId) uncategorized += 1;           // null counts, and is surfaced
  }
  const cashflow = income - spent;
  return { spent, income, cashflow, allocated: setAsideTotal(setAsides),
           net: availableNet(cashflow, setAsides), uncategorized };
}
```

Conventions:

- **The store is memory; the file is truth.** Every mutation schedules a write
  back through the server. There is no `localStorage`, no browser-side cache to
  drift from the file the widget reads.
- **`detailsReady` gates the heavy stuff.** Two `requestAnimationFrame`s after
  `initialized`, then the chart, panels, unknown-merchant scan, and activity
  table render. Nothing below the stat row may block first paint.
- **Every derived number applies the five ledger rules** via `isSpend`/`isIncome`
  and `setAsideTotal` — never sum raw amounts in a component.
- **Saves are fire-and-forget with retry-on-next-edit.** A failed write must not
  break the page (`ledger-file.ts`).

## Behavior this spec fixes in place

### Startup

`bootLedger()` reads `window.__OMAKEI_STATE` (server-inlined), loads it into the
store, sets `initialized`, removes the `#omakei-boot` splash, then — if a folder
is attached — runs `syncAttachedFolder` in the background to pick up new months.
`readOpeningMonth()` (`?m=`) overrides the ledger's `selectedMonth`, and
`clearOpeningMonthFromUrl()` strips the param so a reload doesn't pin it.

### The stat row

Four fixed tiles: **Spent**, **Income**, **Net** (signed, with an "after $X
reserved this month" hint when set-asides exist), **Uncategorized** (a count).
Then one editable tile per set-aside, then an "Add" cell that spans the rest of
its row at both the 2- and 4-column breakpoints. Set-aside edits commit on blur
via `saveLedgerNow`.

### Month navigation

`months` is the sorted set of `YYYY-MM` keys present in the ledger. `‹`/`›` step
through them, extending past the ends with `shiftMonth`. `canPrev`/`canNext`
disable at the ends.

### Panels

Rendered by `PanelGrid` only when `ready` (`detailsReady`) is true, in a
five-column grid, each in its own error boundary. See `docs/spec/panel-contract.md`.

### Needs a category

`unknownMerchants(transactions)` groups every `categoryId === null` transaction
by `extractMerchant`, sorted by absolute total. Assigning one calls
`categorizeMerchant` → `upsertRule` → `refreshCategories` over the whole ledger,
so the choice sticks for future imports. Paged at 12.

### Activity table

`monthTx` filtered by a search box (description / account / category name) and a
category `Select` (`all` hides transfers, `transfers`, `uncat`, or a specific
category). Paged at 40. Resets to page 1 on month/query/filter change.

### One-off import

`ImportSheet` accepts dropped/chosen files (`.csv,.tsv,.ofx,.qfx,.ofc,.txt`) or
pasted CSV, shows a per-file preview with editable account name and kind, and
commits through `importAndSave` — the same merge path as a folder sync, so
duplicates are skipped either way. The drop target is the shared
`StatementDropzone`, which also walks a **dropped folder** via the entries API
(`dropped-entries.ts`); clicking it opens a multi-file picker (one `<input>`
cannot be both `multiple` and `webkitdirectory`, so a whole folder goes in by
drag or through the folder picker).

### The empty state

`transactions.length === 0` renders one card built around the same
`StatementDropzone`. Dropping or choosing there imports with no per-file preview;
a mis-guessed account kind is corrected afterward, not before.

- **A folder is attached:** `parseDroppedFiles` → `importAndSave` → `toastImport`
  straight away. The card stays put on a folder-attached-but-empty ledger, as a
  one-off import alongside Sync.
- **No folder yet (a fresh run):** there is nowhere to save a ledger, so the
  parsed statements are held in `pendingImport` and the `FolderPicker` opens
  ("pick a folder to keep the ledger in"). `attach` then runs the held import
  into the chosen folder and quietly syncs it. Dismissing the picker drops the
  held statements with a toast. Without this, a fresh-run drop filled the store
  in memory only — `saveLedgerNow` no-ops until `setLedgerWritable`, and the
  server's `PUT /ledger` 409s with no attached folder — so nothing survived a
  reload.

### CSV export

"Download clean file" → `exportLedgerCsv` — a flat CSV with resolved category
names, offered as a browser download (never written to disk by the app).

### No sample ledger

There is no dummy data. With no folder attached, the empty state leads with
**Choose your statements folder**, which opens the `FolderPicker`; the drop zone
sits below it as the shortcut for someone holding exports already. Once a folder
is attached the button goes away and the drop zone is the whole card. The picker
is also in the 3-dot menu — "Attach a folder" / "Change folder". The header
carries no attach button, and its "Sync" action shows only once a folder is
attached.

### The picker has no path box

Choosing is clicking and the keyboard, never typing. The orientation is a
breadcrumb, a Places row (home folders plus anything mounted under
`/run/media/$USER`, `/media/$USER`, or `/mnt`), and a statement count on every
row — the folder you want is the one showing a number. Arrows move focus through
real buttons, Enter walks in, Backspace goes up, and Ctrl/Cmd+Enter attaches
where you are stood.

A browser cannot do this itself: `showDirectoryPicker` hands back an opaque
handle and a dropped folder hands back copies, and neither carries the real path
the bar widget needs. That is why the server browses and the page only renders.

## Testing Strategy

`node --experimental-strip-types` runs the `.ts` view logic; `.tsx` components
are not unit-tested (Node cannot strip JSX). So:

- `summaries.test.ts` — `monthSummary`, `categoryTotals`, `dailySpend`
  (including "bucket only rows in `month`").
- `drift.test.ts` — `categoryDrift` windows, thresholds, month-in-progress cutoff.
- `set-asides.test.ts` — totals, `availableNet`, `parseMoneyInput`.
- `opening-month.test.ts` — `?m=` parsing and clearing.
- `grid.test.ts`, `paginate.test.ts`, `chart.test.ts` — the layout/paging/scale
  helpers extracted from the components.
- Component behavior (first-paint order, error boundaries, flush-on-hide) is
  verified by hand — see `panel-contract.md`'s note.

New view logic goes in a `.ts` module with a failing test first. A component
that grows non-trivial math splits that math out to be tested (same rule as
panels).

## Boundaries

**Always:**
- Keep the stat row rendering on first paint; keep everything else behind
  `detailsReady`.
- Route every mutation through the store, and let the store's `subscribe` +
  `saveLedgerNow` write it back.
- Compute money through `isSpend`/`isIncome`/`setAsideTotal`, never from raw
  amounts.
- Rebuild and commit `dist/` when anything under `src/` changes (see
  `build-and-distribution.md`).

**Ask first:**
- Adding a fourth+ fixed stat tile, or making the stat row configurable.
- Persisting anything browser-side (`localStorage`, IndexedDB).
- A new server round-trip on the render path.

**Never:**
- Add an "ask Omakei" box or any model call, API key, or chat UI. The app stays
  deliberately dumb; the agent lives in the terminal.
- Ship a sample/dummy ledger.
- Put personal data in a component, fixture, or default (docs/agents.md).
- Rebuild the popup's flows (attach, import, rules, full activity) — those stay
  in the editor; the popup stays read-only viewing.

## Success Criteria

Verified against the current suite (2026-08-28): 82 tests pass.

1. **Met.** `monthSummary` for the `docs/ledger.md` worked month produces
   spend `$3,580.51`, income `$8,421.10`, net `+$4,190.59` (ledger-contract
   spec, criterion 1).
2. **Met.** `dailySpend` filters to `month` before bucketing
   (`summaries.test.ts`).
3. **Met.** `dashboard.tsx` renders the stat row unconditionally and gates
   `PanelGrid`, `NeedsCategoryPanel`, the chart, and the activity list on
   `detailsReady`.
4. **Met.** `bootLedger` reads inline state, then background-syncs; `?m=` wins
   over `selectedMonth` (`opening-month.test.ts` + `boot.ts`).
5. **Met.** No `localStorage`/`sessionStorage` and no `fetch` to any non-`/__omakei`
   origin anywhere in `src/`.
6. **Met.** The empty state leads with the `FolderPicker` and keeps a
   `StatementDropzone` below it; `collectEntryFiles` flattens a dropped folder
   (`dropped-entries.test.ts`). With a folder attached a drop imports through
   `parseDroppedFiles` → `importAndSave` with no preview; with no folder it
   opens the `FolderPicker` and imports into the chosen folder (verified by
   hand — a fresh-run drop persists across a reload). A drop that carried a
   `file://` URI opens the picker already standing in that folder
   (`droppedPath`, `dropped-entries.test.ts`). The header shows no attach
   control; "Sync" renders only when `folder` is set.

## Open Questions

1. **`unknownMerchants` re-scans the whole ledger on every `transactions`
   change while `detailsReady`.** Memoized, but O(n) over 30k rows on each
   categorize click. Probably fine; unmeasured.
2. **`clearLedger` resets `selectedMonth` to the current month** even if the
   current month never had data — the next render can show an empty month until
   the user navigates. Minor, but inconsistent with `openingMonth`'s fallback
   logic in the widget.
3. **The activity search has no debounce.** Each keystroke refilters `monthTx`.
   Fine at a month's size; worth noting if the table ever shows all months.
4. **`ImportSheet` pasted CSV is always named `pasted.csv`** and typed by
   `inferKindFromName` → `other`. The user can fix the kind in the preview, but
   the default is a silent `other`.
5. **No test asserts the save debounce or flush-on-hide.** `use-flush-on-hide`
   and the 32 ms timer in `ledger-file.ts` are only exercised by hand.
