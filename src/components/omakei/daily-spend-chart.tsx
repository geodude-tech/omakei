/**
 * Daily spend for the selected month.
 *
 * Hand-drawn SVG rather than a charting library: this is one bar per day with
 * a hover readout, and the library that used to draw it pulled in more code
 * than the rest of the editor combined.
 */
import { useState } from "react";
import { barHeightPercent } from "@/lib/chart.ts";
import type { DailySpend } from "@/lib/finance/summaries.ts";
import { formatMoney } from "@/lib/utils.ts";

const GAP = 0.25; // share of each slot left as spacing between bars

export default function DailySpendChart({ data }: { data: DailySpend[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) return null;

  const max = Math.max(...data.map((d) => d.spent), 0);
  const slot = 100 / data.length;
  const barWidth = slot * (1 - GAP);
  const active = hover !== null ? data[hover] : null;

  return (
    <figure className="flex h-full flex-col gap-1">
      <figcaption className="sr-only">
        Daily spending, {data[0]!.label} to {data[data.length - 1]!.label}
      </figcaption>

      <div
        className="relative min-h-0 flex-1"
        onPointerLeave={() => setHover(null)}
        role="presentation"
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="size-full overflow-visible"
          aria-hidden="true"
        >
          {data.map((d, i) => {
            const height = barHeightPercent(d.spent, max);
            return (
              <rect
                key={d.day}
                x={i * slot + (slot - barWidth) / 2}
                y={100 - height}
                width={barWidth}
                height={height}
                rx={0.6}
                fill={hover === i ? "var(--color-foreground)" : "var(--color-chart-1)"}
                opacity={hover === null || hover === i ? 1 : 0.45}
                onPointerEnter={() => setHover(i)}
              />
            );
          })}
        </svg>

        {active ? (
          <div
            className="pointer-events-none absolute top-0 rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-[var(--shadow-border)]"
            style={{
              left: `${((hover! + 0.5) / data.length) * 100}%`,
              transform: `translateX(${hover! > data.length / 2 ? "-100%" : "0"})`,
            }}
          >
            <p>{active.label}</p>
            <p className="tabular-nums">{formatMoney(active.spent)}</p>
          </div>
        ) : null}
      </div>

      {/* Roughly weekly ticks, matching the density the chart had before. */}
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        {data
          .filter((_, i) => i % 7 === 0)
          .map((d) => (
            <span key={d.day}>{d.day}</span>
          ))}
      </div>
    </figure>
  );
}
