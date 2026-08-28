# Panels

A panel is one card on the Omakei dashboard. Panels exist so that an insight
worth watching every day can be pinned without touching the rest of the app.

**To add one: create a single file in this directory and run `npm run build`.**
Nothing else. There is no registry to append to and no import to add — every
`src/panels/*.tsx` is discovered automatically.

## The contract

```tsx
import type { PanelMeta, PanelProps } from "@/lib/finance/types.ts";

export const meta: PanelMeta = {
  title: "Restaurants",  // the card header
  span: 2,               // columns in a five-wide grid; 1-5, default 2
  order: 40,             // ascending; default 100, ties broken by filename
};

export default function RestaurantTrend({ transactions, month }: PanelProps) {
  return <p className="text-sm">…</p>;
}
```

You render the card's **contents**. The frame draws the `<Card>`, the header, and
the title from `meta`.

### What you receive

```ts
interface PanelProps {
  transactions: Transaction[];       // every transaction, every month
  month: string;                     // the selected month, "YYYY-MM"
  monthTransactions: Transaction[];  // transactions filtered to `month`
  setAsides: SetAside[];
}
```

Use `transactions` for anything comparative — a trend, a rolling average, "vs.
last month". Use `monthTransactions` when you only care about the month on screen.

### Returning nothing

**A panel with nothing to say returns `null`, and its card disappears entirely** —
no header, no empty box, no gap in the grid.

This is what makes a verdict panel work. Render only when the verdict is true:

```tsx
if (dining <= average * 1.15) return null;
return <p>Restaurants are up {pct}% on your six-month average.</p>;
```

A dashboard of ten such panels stays quiet until something is worth saying.

## Rules

- **Panels are read-only.** Never import `@/lib/finance/store` — writing to the
  ledger belongs in core code. `npm test` fails if a panel imports it.
- **Reuse the helpers.** `categoryTotals` and `dailySpend` in
  `@/lib/finance/summaries.ts`; `isSpend`, `isIncome` in `ledger.ts`;
  `isTransferTx` in `transfers.ts`; `categoryName` in `categories.ts`;
  `formatMoney`, `formatDay`, `monthKey`, `shiftMonth` in `@/lib/utils.ts`.
- **No personal data.** No household merchants, balances, or account names — the
  same rule that governs tests and fixtures. Panels ship to everyone.
- **Match the existing look.** Tailwind classes, `text-sm`, `tabular-nums` for
  figures. `Skeleton`, `Card`, and the rest of `@/components/ui/` are available.
- **A throwing panel costs only its own card.** Each is wrapped in an error
  boundary, so a mistake here cannot blank the dashboard. It will log to the
  console — check there when a card reads "This panel failed to render."

## Testing

`node --experimental-strip-types` cannot strip JSX, so a `.tsx` panel cannot be
unit tested directly. `npm test` checks each panel's shape statically
(`scripts/check-panels.mjs`) and the registry repeats those checks at runtime.

If a panel's math is worth testing on its own, move it to a plain `.ts` module
and test that. One file per panel is the default; split only when the maths earns
it — see `summaries.ts` and `summaries.test.ts` for the pattern.

## After adding a panel

```sh
npm run build     # dist/ is committed, so this is required
npm test
```

`npm run dev` picks up new panels without a build, but an installed plugin reads
the committed `dist/`, and the pre-commit hook rejects a stale one.
