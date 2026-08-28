import { useMemo } from "react";
import { categoryDrift } from "@/lib/finance/drift.ts";
import type { PanelMeta, PanelProps } from "@/lib/finance/types.ts";
import { formatMoney, todayIso } from "@/lib/utils.ts";

export const meta: PanelMeta = { title: "Drifting up", span: 2, order: 5 };

/**
 * The verdict the charts never gave: which categories are running above their
 * own recent average, said in a sentence. Quiet in a month where nothing is.
 */
export default function DriftingUp({ transactions, month }: PanelProps) {
  const drifts = useMemo(
    () => categoryDrift(transactions, month, { today: todayIso() }),
    [transactions, month],
  );

  if (drifts.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2.5">
      {drifts.map((d) => (
        <li key={d.id} className="text-sm">
          <span className="text-spend">{d.name}</span> is up{" "}
          <span className="tabular-nums">{Math.round(d.pct * 100)}%</span> on your{" "}
          {d.months}-month average —{" "}
          <span className="tabular-nums">{formatMoney(d.current)}</span> vs{" "}
          <span className="tabular-nums">{formatMoney(d.average)}</span>.
        </li>
      ))}
    </ul>
  );
}
