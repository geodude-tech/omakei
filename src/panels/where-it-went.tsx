import { useMemo } from "react";
import { categoryTotals } from "@/lib/finance/summaries.ts";
import type { PanelMeta, PanelProps } from "@/lib/finance/types.ts";
import { formatMoney } from "@/lib/utils.ts";

export const meta: PanelMeta = { title: "Where it went", span: 3, order: 10 };

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
  "var(--color-chart-7)",
];

export default function WhereItWent({ monthTransactions }: PanelProps) {
  const cats = useMemo(() => categoryTotals(monthTransactions), [monthTransactions]);

  if (cats.length === 0) {
    return <p className="py-10 text-sm text-muted-foreground">No spending this month.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {cats.map((row, i) => (
        <li key={row.id}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="text-sm">{row.name}</span>
            <span className="text-sm tabular-nums">{formatMoney(row.total)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, (row.total / cats[0]!.total) * 100)}%`,
                background: CHART_COLORS[i % CHART_COLORS.length],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
