import { twMerge } from "tailwind-merge";

// Date helpers live in `dates.ts`, which imports nothing, so the scripts can
// share them without `node_modules`. Re-exported so existing imports keep working.
export { formatDay, formatMonthLabel, monthKey, shiftMonth, todayIso } from "./dates.ts";

export function cn(
  ...inputs: Array<string | undefined | null | false | Record<string, boolean>>
) {
  const classes: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") {
      classes.push(input);
      continue;
    }
    for (const [key, on] of Object.entries(input)) {
      if (on) classes.push(key);
    }
  }
  return twMerge(classes.join(" "));
}

export function formatMoney(
  n: number,
  opts?: { sign?: boolean; abs?: boolean },
): string {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Math.abs(n));

  if (opts?.sign) {
    if (n < -0.0001) return `−${formatted}`;
    if (n > 0.0001) return `+${formatted}`;
    return formatted;
  }
  if (n < -0.0001 && !opts?.abs) return `−${formatted}`;
  return formatted;
}

export function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
