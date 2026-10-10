/**
 * Date helpers with no imports at all.
 *
 * `utils.ts` pulls in `tailwind-merge`, which an installed plugin does not have
 * (`omarchy plugin add` never runs `npm install`). The finance modules the
 * scripts load (`summaries.ts`, `drift.ts`) take their dates from here instead,
 * so `scripts/omakei.mjs` runs from a plain clone.
 */

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
