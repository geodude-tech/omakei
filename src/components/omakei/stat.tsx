import { cn } from "@/lib/utils";

/** One cell in the dashboard stat row. Also available to panels that pin a number. */
export function Stat({
  label,
  value,
  tone,
  hint,
  hintTone,
}: {
  label: string;
  value: string;
  tone?: "income" | "spend" | "reserved";
  hint?: string;
  hintTone?: "reserved";
}) {
  return (
    <div className="bg-card px-4 py-4 sm:px-5" data-stat={label.toLowerCase()}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          "mt-1 font-display text-2xl font-medium tracking-tight tabular-nums sm:text-3xl",
          tone === "income" && "text-income",
          tone === "spend" && "text-spend",
          tone === "reserved" && "text-reserved",
        )}
      >
        {value}
      </p>
      {hint ? (
        <p
          className={cn(
            "mt-1 text-xs",
            hintTone === "reserved" ? "text-reserved" : "text-muted-foreground",
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
