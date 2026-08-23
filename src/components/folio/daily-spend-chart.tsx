import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
} from "recharts";
import { formatMoney } from "@/lib/utils";

export default function DailySpendChart({
  data,
}: {
  data: Array<{ day: string; spent: number; label: string }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          interval={6}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
        />
        <RechartsTooltip
          cursor={{ fill: "var(--color-muted)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null;
            const p = payload[0].payload as { label: string; spent: number };
            return (
              <div className="rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-[var(--shadow-border)]">
                <p>{p.label}</p>
                <p className="tabular-nums">{formatMoney(p.spent)}</p>
              </div>
            );
          }}
        />
        <Bar dataKey="spent" fill="var(--color-chart-1)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
