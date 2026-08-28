import { lazy, Suspense, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { dailySpend } from "@/lib/finance/summaries.ts";
import type { PanelMeta, PanelProps } from "@/lib/finance/types.ts";

export const meta: PanelMeta = { title: "Daily spend", span: 2, order: 20 };

const DailySpendChart = lazy(() => import("@/components/omakei/daily-spend-chart.tsx"));

export default function DailySpend({ month, monthTransactions }: PanelProps) {
  const daily = useMemo(() => dailySpend(month, monthTransactions), [month, monthTransactions]);

  return (
    <div className="h-52">
      <Suspense fallback={<Skeleton className="h-full" />}>
        <DailySpendChart data={daily} />
      </Suspense>
    </div>
  );
}
