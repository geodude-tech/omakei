/**
 * Which month the editor opens on.
 *
 * The bar widget appends `?m=YYYY-MM` when it opens Omakei so the page lands
 * on whatever month the popup was showing. The ledger itself arrives with the
 * page, so this is the only thing the URL has to carry.
 */
const MONTH_RE = /^\d{4}-\d{2}$/;

export const OPENING_MONTH_PARAM = "m";

export function parseOpeningMonth(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return "";
  const month = new URLSearchParams(raw).get(OPENING_MONTH_PARAM) ?? "";
  return MONTH_RE.test(month) ? month : "";
}

export function readOpeningMonth(): string {
  if (typeof window === "undefined") return "";
  return parseOpeningMonth(window.location.search);
}

/** Drop it once it has been applied, so a reload does not pin an old month. */
export function clearOpeningMonthFromUrl(): void {
  if (typeof window === "undefined" || typeof window.history.replaceState !== "function") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(OPENING_MONTH_PARAM)) return;
  url.search = "";
  window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
}
