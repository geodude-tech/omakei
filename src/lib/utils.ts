import { twMerge } from "tailwind-merge";

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

export function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7);
}

/** Today as "YYYY-MM-DD", in the user's own timezone rather than UTC. */
export function todayIso(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

export function formatMonthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}`;
}

export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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
