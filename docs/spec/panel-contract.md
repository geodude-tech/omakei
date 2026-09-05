# Spec: Panel Contract

_Status: implemented 2026-08-27. Traces to `docs/intent/omakei.md`._

## Objective

Give an agent a way to add a dashboard panel by writing **one file** and running
**one command**.

Omakei's loop is: point an agent at the ledger, ask a question, and when the
answer is worth watching every day, pin it as a panel. Step three has no
mechanism today — `src/components/omakei/dashboard.tsx` is a single 798-line
component with its cards written inline as JSX. An agent cannot add to that
without reading and editing the whole file, and a mistake takes the page down.

**User:** an agent (Claude Code or any harness) working in a dev clone, acting
for Andrew. Not an installed plugin user — see Boundaries.

**Success:** an agent that has never seen this repo can read `src/panels/README.md`
plus `types.ts`, write `src/panels/<name>.tsx`, run `npm run build`, and see its
panel on the dashboard. It edits no other file. If the panel throws, the rest of
the dashboard still renders.

## Tech Stack

React 19, TypeScript 5.7, Vite 8, Tailwind 4, shadcn/ui primitives under
`src/components/ui/`. No new dependencies.

## Commands

```
Build:     npm run build          # vite build + stamp dist/.build-hash
Test:      npm test
Typecheck: npm run typecheck
Lint:      npm run lint
Dev:       npm run dev            # 127.0.0.1:8080
```

## Project Structure

```
src/panels/                 → one file per panel, auto-discovered
src/panels/README.md        → the contract, written for an agent to read
src/lib/panels/registry.ts  → import.meta.glob discovery + ordering (core, not a panel)
src/lib/panels/validate.ts  → pure module validation, no Vite API, unit-tested below
src/lib/panels/panel-frame.tsx → Card wrapper + per-panel error boundary (core)
src/lib/panels/panel-grid.tsx  → the five-column grid, and the pre-`ready` placeholders
src/lib/panels/span.ts      → span number → grid class
src/lib/finance/types.ts    → PanelProps, PanelMeta live here beside Transaction
src/lib/finance/panels.test.ts → registry smoke test, against validate.ts
```

No registry file lists the panels. `src/lib/panels/registry.ts` discovers them:

```ts
const modules = import.meta.glob<PanelModule>("./*.tsx", { eager: true });
```

Adding a panel therefore touches exactly one file, creates no merge surface, and
needs no import statement anywhere. `src/styles.css` already declares
`@source "./"` (all of `src/`), and `BUILD_INPUT_PATHS` already includes `"src"`,
so a new panel is picked up by Tailwind and the build stamp with no config edit.

## Code Style

A panel is a default-exported component plus a named `meta`. This is the whole
contract:

```tsx
import type { PanelMeta, PanelProps } from "@/lib/finance/types.ts";
import { isSpend } from "@/lib/finance/ledger.ts";
import { formatMoney, monthKey, shiftMonth } from "@/lib/utils.ts";

export const meta: PanelMeta = {
  title: "Restaurants",
  span: 2,     // columns in a 5-wide grid; 1-5, default 2
  order: 40,   // ascending; default 100, ties broken by filename
};

export default function RestaurantTrend({ transactions, month }: PanelProps) {
  const dining = transactions.filter((t) => t.categoryId === "dining" && isSpend(t));
  const now = total(dining, month);
  const avg = average(dining, previousMonths(month, 6));

  // A panel with nothing to say renders nothing. The card disappears with it.
  if (avg === 0 || now <= avg * 1.15) return null;

  return (
    <p className="text-sm">
      Up {Math.round(((now - avg) / avg) * 100)}% on your 6-month average
      ({formatMoney(now)} vs {formatMoney(avg)}).
    </p>
  );
}
```

Conventions:

- **The panel returns the card's contents, not the card.** `panel-frame.tsx`
  supplies `<Card>`, `<CardHeader>`, and the title from `meta.title`.
- **Returning `null` removes the panel entirely** — no empty card, no header.
  This is what makes verdict panels work: they appear only when they have a
  verdict.
- **Read-only.** A panel never writes to the store or the ledger file.
- Use the existing helpers rather than reimplementing them: `isSpend`, `isIncome`,
  `isTransferTx`, `monthKey`, `shiftMonth`, `formatMoney`, `formatDay`,
  `categoryName`, `setAsideTotal`, `availableNet`.
- Match the existing card styling. `Stat`, `Card`, and `Skeleton` are available.

### PanelProps

```ts
export interface PanelProps {
  /** Every transaction, every month. Trend panels need the history. */
  transactions: Transaction[];
  /** Selected month, "YYYY-MM". */
  month: string;
  /** transactions filtered to `month`. Provided so panels don't each refilter. */
  monthTransactions: Transaction[];
  setAsides: SetAside[];
}

export interface PanelMeta {
  title: string;
  span?: 1 | 2 | 3 | 4 | 5;
  order?: number;
}
```

## Testing Strategy

`npm test` runs `node --experimental-strip-types` over `src/lib/finance/*.test.ts`.
Node cannot strip-type JSX, so **a `.tsx` panel cannot be unit tested directly.**

- Panels whose math is trivial need no test. Render is covered by the
  smoke test below.
- A panel with non-trivial math puts that math in a plain `.ts` module beside it
  and tests it there. Splitting is a judgment call, not a rule — the one-file
  default stands until the math is worth a test on its own.
- **Registry smoke test** (`src/lib/finance/panels.test.ts`): every discovered
  module exports a function default and a `meta` with a non-empty `title` and a
  `span` in 1–5. This is the guard that a malformed agent-written panel fails
  `npm test` rather than failing in the browser.
- Error-boundary behaviour is verified by hand once: a panel that throws leaves
  the rest of the dashboard intact.

## Boundaries

**Always:**
- Wrap each panel in its own error boundary. A thrown panel renders an inline
  "This panel failed" card and nothing else breaks.
- Render panels in the `detailsReady` phase, after first paint, like the existing
  chart. docs/agents.md requires time-to-display stay immediate; panels must never
  block the stat row.
- Keep `PanelProps` additive. Fields may be added; existing fields keep their
  meaning, so old panels keep working.

**Ask first:**
- Adding a field to `PanelProps` that isn't derivable from the ledger.
- Letting a panel write anything.
- Changing the 5-column grid, which would reflow every existing panel.

**Never:**
- Load panels at runtime from the attached statements folder. Panels are build-time
  TSX in the repo. The folder holds the user's financial data and is not a code
  path — executing code from it would make a data directory an attack surface.
- Put personal data in a panel: no household merchants, balances, or account
  names. Same rule as tests and fixtures (docs/agents.md).
- Ship a panel without rebuilding `dist/`. The pre-commit hook catches it.

## Success Criteria

Verified 2026-08-27 against a synthetic three-month ledger.

1. **Met.** `src/panels/where-it-went.tsx` (`span: 3`) and
   `src/panels/daily-spend.tsx` (`span: 2`) are discovered by the registry and
   reproduce the previous layout.
2. **Missed.** `dashboard.tsx` is 721 lines, not under 650. The 650 was an
   uncounted guess; the panels accounted for 77 lines, and the rest of the file
   is the stat row, the activity table, `TransactionRow`, and `Pager` — core
   code with nothing to do with panels. Extracting those is a separate change.
3. **Met.** Adding a panel produces exactly one new untracked file.
4. **Met.** A probe panel that throws renders "This panel failed to render"
   in its own card and logs `Panel "<id>" failed to render.` to the console;
   the other panels, the stat row, and the activity table are unaffected.
5. **Met.** A probe panel returning `null` computes to `display: none` — no
   card, no header, no gap.
6. **Met.** 36 finance tests, 19 script tests, typecheck, and lint all pass.
   (One pre-existing lint warning in `components/ui/button.tsx` is unrelated.)
7. **Met.** Panels render only once `ready` is set, after first paint.

Found while writing the tests: `dailySpend` bucketed rows by day-of-month
without checking they belonged to `month`. Harmless while the only caller passed
pre-filtered rows, but wrong the moment a panel hands it the whole ledger. Fixed
in `summaries.ts`, covered by `summaries.test.ts`.

## Open Questions

1. **Do the stat tiles become panels too?** The row of `Stat` cells (Spend,
   Income, Reserved, Uncategorized) is a different shape from a Card panel, and
   set-asides are interactive. Proposal: leave the stat row alone for now; it is
   core, not an insight. Revisit if an agent wants to pin a stat.
2. **Does `UnknownPanel` (`Needs a category`) migrate?** It mutates the store, so
   under a read-only contract it cannot be a panel. Proposal: leave it in core.
3. **Panel visibility control.** If the agent pins ten panels, does the user need
   a way to hide one without deleting the file? Proposal: not yet — deleting the
   file is the control, and ten panels is a problem we don't have.
